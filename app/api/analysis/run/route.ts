/**
 * POST /api/analysis/run
 *
 * Streaming AI-analyse endpoint powered by Claude (claude-sonnet-4-6).
 * Accepts an entity (virksomhed, ejendom, person) og en analysetype,
 * henter data fra offentlige registre via tool-use, og streamer resultatet
 * som SSE.
 *
 * Understøttede analysetyper:
 *  - due_diligence  — Grundig gennemgang: økonomi, ejerskab, risici
 *  - konkurrent     — Konkurrentanalyse inden for en branche
 *  - investering    — Investeringsscreening og potentialevurdering
 *  - marked         — Ejendomsmarkedsanalyse for et geografisk område
 *
 * SSE-protokol:
 *  - `data: {"t":"<text>"}` — streamet tekstchunk
 *  - `data: {"status":"<msg>"}` — tool-statusbesked (vises under hentning)
 *  - `data: {"error":"<msg>"}` — fejlbesked
 *  - `data: [DONE]` — stream afsluttet
 *
 * Bruger de samme tools som /api/ai/chat — hent_cvr_virksomhed,
 * hent_regnskab_noegletal, hent_bbr_data, hent_vurdering m.fl.
 *
 * @param body.type   - Analysetype identifier
 * @param body.entity - Valgt entitet { id, title, type, meta? }
 * @returns SSE stream
 *
 * TODO(tech-debt): Udtræk TOOLS + executeTool til app/lib/aiTools.ts og del med /api/ai/chat
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { resolveTenantId } from '@/lib/api/auth';
import { fetchBbrForAddress } from '@/app/lib/fetchBbrData';
import { parseBody } from '@/app/lib/validate';

/** Zod schema for POST /api/analysis/run request body */
const analysisRunSchema = z
  .object({
    type: z.enum([
      'due_diligence',
      'konkurrent',
      'investering',
      'marked',
      'virksomhed',
      'ejendom',
      'ejerskab',
      'omraade',
      'portefolje',
    ]),
    entity: z.object({
      id: z.string().min(1),
      title: z.string(),
      subtitle: z.string().optional(),
      type: z.enum(['address', 'company', 'person', 'area']),
      meta: z.record(z.string(), z.string()).optional(),
    }),
  })
  .passthrough();

export const runtime = 'nodejs';
export const maxDuration = 120;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Union of supported analysis type identifiers */
type AnalysisType =
  | 'due_diligence'
  | 'konkurrent'
  | 'investering'
  | 'marked'
  | 'virksomhed'
  | 'ejendom'
  | 'ejerskab'
  | 'omraade'
  | 'portefolje';

/** Entity passed from the frontend */
interface AnalysisEntity {
  id: string;
  title: string;
  subtitle?: string;
  type: 'address' | 'company' | 'person' | 'area';
  meta?: Record<string, string>;
}

/** Request body shape */
interface AnalysisRequestBody {
  type: AnalysisType;
  entity: AnalysisEntity;
}

// ─── Rate limiter ────────────────────────────────────────────────────────────

/** Lazily-initialised rate limiter — 5 req/min per IP (analyses are heavy) */
let _rateLimit: Ratelimit | null = null;

/** Returns the lazily-initialised rate limiter instance. */
function getRateLimit(): Ratelimit {
  if (!_rateLimit) {
    _rateLimit = new Ratelimit({
      redis: new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      }),
      limiter: Ratelimit.slidingWindow(5, '1 m'),
      analytics: true,
      prefix: 'ba:analysis-ratelimit',
    });
  }
  return _rateLimit;
}

/**
 * Derive a stable per-client key for rate limiting from request headers.
 *
 * @param req - Incoming Next.js request
 * @returns Opaque client identifier (IP-based, never logged)
 */
function getClientKey(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip')?.trim() ?? 'anonymous';
}

// ─── Tool definitions (mirrors /api/ai/chat) ────────────────────────────────

/** Tool definitions Claude can call to fetch real Danish register data */
const TOOLS: Anthropic.Tool[] = [
  {
    name: 'dawa_adresse_soeg',
    description:
      'Søg efter en dansk adresse via DAWA autocomplete. Returnerer matches med DAWA-id, vejnavn, husnr, postnr, by, kommune.',
    input_schema: {
      type: 'object' as const,
      properties: { q: { type: 'string', description: 'Søgestreng' } },
      required: ['q'],
    },
  },
  {
    name: 'dawa_adresse_detaljer',
    description:
      'Hent fulde detaljer for en DAWA adgangsadresse-ID — koordinater, matrikelnr, ejerlavkode, kommunekode, jordstykke og BFE-nummer.',
    input_schema: {
      type: 'object' as const,
      properties: { dawaId: { type: 'string', description: 'DAWA adgangsadresse UUID' } },
      required: ['dawaId'],
    },
  },
  {
    name: 'hent_bbr_data',
    description:
      'Hent BBR-bygningsdata (opførelsesår, areal, materialer, etager, opvarmning, enheder, energiforsyning) via DAWA adresse-ID.',
    input_schema: {
      type: 'object' as const,
      properties: { dawaId: { type: 'string', description: 'DAWA adgangsadresse UUID' } },
      required: ['dawaId'],
    },
  },
  {
    name: 'hent_vurdering',
    description:
      'Hent offentlig ejendomsvurdering fra Datafordeler: ejendomsværdi, grundværdi, afgiftspligtige beløb, grundskyld, vurderingshistorik.',
    input_schema: {
      type: 'object' as const,
      properties: {
        bfeNummer: { type: 'string', description: 'BFE-nummer' },
        kommunekode: { type: 'string', description: '4-cifret kommunekode' },
      },
      required: ['bfeNummer'],
    },
  },
  {
    name: 'hent_forelobig_vurdering',
    description:
      'Hent foreløbige ejendomsvurderinger fra Vurderingsportalen — faktiske skatteberegninger: grundskyld, ejendomsværdiskat, total skat.',
    input_schema: {
      type: 'object' as const,
      properties: {
        adresseId: { type: 'string', description: 'DAWA adgangsadresse UUID (foretrukket)' },
        bfeNummer: { type: 'string', description: 'BFE-nummer (fallback)' },
      },
      required: [],
    },
  },
  {
    name: 'hent_ejerskab',
    description: 'Hent ejerskabsdata (ejertype, ejerandel, CVR, startdato) fra Datafordeler.',
    input_schema: {
      type: 'object' as const,
      properties: { bfeNummer: { type: 'string', description: 'BFE-nummer' } },
      required: ['bfeNummer'],
    },
  },
  {
    name: 'hent_salgshistorik',
    description:
      'Hent salgshistorik (købesum, overtagelsesdato, overdragelsesmåde) fra Datafordeler.',
    input_schema: {
      type: 'object' as const,
      properties: { bfeNummer: { type: 'string', description: 'BFE-nummer' } },
      required: ['bfeNummer'],
    },
  },
  {
    name: 'hent_energimaerke',
    description: 'Hent energimærke (energiklasse A-G, gyldig dato, PDF-link) fra Energistyrelsen.',
    input_schema: {
      type: 'object' as const,
      properties: { bfeNummer: { type: 'string', description: 'BFE-nummer' } },
      required: ['bfeNummer'],
    },
  },
  {
    name: 'hent_jordforurening',
    description: 'Hent jordforureningsstatus (V1/V2-kortlægning) fra Miljøportalen.',
    input_schema: {
      type: 'object' as const,
      properties: {
        ejerlavKode: { type: 'string', description: 'Ejerlavkode (numerisk)' },
        matrikelnr: { type: 'string', description: 'Matrikelnummer' },
      },
      required: ['ejerlavKode', 'matrikelnr'],
    },
  },
  {
    name: 'hent_plandata',
    description:
      'Hent plandata (lokalplaner, kommuneplanrammer, anvendelse, bebyggelsesprocent, max etager) fra Plandata.dk.',
    input_schema: {
      type: 'object' as const,
      properties: { adresseId: { type: 'string', description: 'DAWA adgangsadresse UUID' } },
      required: ['adresseId'],
    },
  },
  {
    name: 'hent_cvr_virksomhed',
    description:
      'Hent virksomhedsdata (navn, adresse, branche, ansatte, stiftelsesdato) for et CVR-nummer.',
    input_schema: {
      type: 'object' as const,
      properties: { cvr: { type: 'string', description: '8-cifret CVR-nummer' } },
      required: ['cvr'],
    },
  },
  {
    name: 'hent_matrikeldata',
    description:
      'Henter matrikeloplysninger (jordstykker, matrikelnumre, arealer, fredskov, strandbeskyttelse) fra Datafordeler.',
    input_schema: {
      type: 'object' as const,
      properties: {
        bfeNummer: { type: 'string', description: 'BFE-nummer' },
      },
      required: ['bfeNummer'],
    },
  },
  {
    name: 'hent_regnskab_noegletal',
    description:
      'Henter XBRL-regnskabsdata (egenkapital, aktiver, omsætning, årets resultat, nøgletal) for de seneste 1-3 år.',
    input_schema: {
      type: 'object' as const,
      properties: { cvr: { type: 'string', description: '8-cifret CVR-nummer' } },
      required: ['cvr'],
    },
  },
  {
    name: 'hent_datterselskaber',
    description: 'Henter datterselskaber og kapitalandele for en virksomhed fra CVR.',
    input_schema: {
      type: 'object' as const,
      properties: { cvr: { type: 'string', description: '8-cifret CVR-nummer' } },
      required: ['cvr'],
    },
  },
  {
    name: 'soeg_person_cvr',
    description: 'Søger CVR-registret efter en person på navn. Returnerer enhedsNummer og adresse.',
    input_schema: {
      type: 'object' as const,
      properties: {
        navn: { type: 'string', description: 'Personens fulde navn' },
      },
      required: ['navn'],
    },
  },
  {
    name: 'hent_person_virksomheder',
    description:
      'Henter alle virksomheder en person er tilknyttet fra CVR med ejerandel (%), rolle og CVR-nummer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        enhedsNummer: { type: 'string', description: 'CVR enhedsnummer for personen' },
        navn: { type: 'string', description: 'Personens fulde navn (fallback)' },
      },
      required: [],
    },
  },
];

/** Human-readable status labels for each tool (shown in SSE status events) */
const TOOL_STATUS: Record<string, string> = {
  dawa_adresse_soeg: 'Søger adresse…',
  dawa_adresse_detaljer: 'Henter adressedetaljer…',
  hent_bbr_data: 'Henter BBR-bygningsdata…',
  hent_vurdering: 'Henter ejendomsvurdering…',
  hent_forelobig_vurdering: 'Henter foreløbig vurdering…',
  hent_ejerskab: 'Henter ejerskabsdata…',
  hent_salgshistorik: 'Henter salgshistorik…',
  hent_energimaerke: 'Henter energimærke…',
  hent_jordforurening: 'Henter jordforureningsdata…',
  hent_plandata: 'Henter plandata…',
  hent_cvr_virksomhed: 'Henter CVR-data…',
  hent_matrikeldata: 'Henter matrikeldata…',
  hent_regnskab_noegletal: 'Henter regnskabsnøgletal…',
  hent_datterselskaber: 'Henter datterselskaber…',
  soeg_person_cvr: 'Søger efter person i CVR…',
  hent_person_virksomheder: 'Henter personens virksomhedstilknytninger…',
};

// ─── Tool result cache ──────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;
interface CacheEntry {
  result: unknown;
  expiresAt: number;
}
const toolCache = new Map<string, CacheEntry>();

/** Returns cached result if still valid, null otherwise. */
function getCached(name: string, input: Record<string, string>): unknown | null {
  const key = `${name}:${JSON.stringify(input)}`;
  const entry = toolCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    toolCache.delete(key);
    return null;
  }
  return entry.result;
}

/** Stores a tool result in the module-level cache. */
function setCache(name: string, input: Record<string, string>, result: unknown): void {
  toolCache.set(`${name}:${JSON.stringify(input)}`, {
    result,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

// ─── Tool executor ──────────────────────────────────────────────────────────

/**
 * Executes a named tool by calling internal API routes or external endpoints.
 * Results are cached in-memory for 5 minutes.
 *
 * @param name    - Tool name from TOOLS
 * @param input   - Tool input parameters from Claude
 * @param baseUrl - Base URL for internal API self-calls
 * @returns JSON-serialisable result
 */
async function executeTool(
  name: string,
  input: Record<string, string>,
  baseUrl: string
): Promise<unknown> {
  const cached = getCached(name, input);
  if (cached !== null) return cached;

  const timeout = 15_000;

  try {
    let result: unknown;
    switch (name) {
      case 'dawa_adresse_soeg': {
        const res = await fetch(
          `${baseUrl}/api/adresse/autocomplete?q=${encodeURIComponent(input.q)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!res.ok) {
          result = { fejl: `Adresse-autocomplete svarede ${res.status}` };
          break;
        }
        const data = await res.json();
        result = (
          data as Array<{
            tekst: string;
            adresse: {
              id: string;
              vejnavn: string;
              husnr: string;
              postnr: string;
              postnrnavn: string;
            };
          }>
        ).map((r) => ({
          tekst: r.tekst,
          id: r.adresse.id,
          vejnavn: r.adresse.vejnavn,
          husnr: r.adresse.husnr,
          postnr: r.adresse.postnr,
          by: r.adresse.postnrnavn,
        }));
        break;
      }

      case 'dawa_adresse_detaljer': {
        const res = await fetch(
          `${baseUrl}/api/adresse/lookup?id=${encodeURIComponent(input.dawaId)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!res.ok) {
          result = { fejl: `Adresse-opslag svarede ${res.status}` };
          break;
        }
        const d = (await res.json()) as Record<string, unknown>;
        result = {
          id: d.id,
          vejnavn: d.vejnavn,
          husnr: d.husnr,
          postnr: d.postnr,
          by: d.postnrnavn,
          kommune: d.kommunenavn,
          koordinater: d.x != null && d.y != null ? [d.x, d.y] : null,
          zone: d.zone,
          matrikelnr: d.matrikelnr,
          ejerlavkode: d.ejerlavskode,
          ejerlavnavn: d.ejerlavsnavn,
        };
        break;
      }

      case 'hent_bbr_data': {
        const data = await fetchBbrForAddress(input.dawaId);
        result = { dawaId: input.dawaId, ...data };
        break;
      }

      case 'hent_vurdering': {
        const params = new URLSearchParams();
        if (input.bfeNummer) params.set('bfeNummer', input.bfeNummer);
        if (input.kommunekode) params.set('kommunekode', input.kommunekode);
        const res = await fetch(`${baseUrl}/api/vurdering?${params}`, {
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) {
          result = { fejl: `Vurderings-API svarede ${res.status}` };
          break;
        }
        result = await res.json();
        break;
      }

      case 'hent_forelobig_vurdering': {
        const params = new URLSearchParams();
        if (input.adresseId) params.set('adresseId', input.adresseId);
        if (input.bfeNummer) params.set('bfeNummer', input.bfeNummer);
        const res = await fetch(`${baseUrl}/api/vurdering-forelobig?${params}`, {
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) {
          result = { fejl: `Foreløbig-vurdering-API svarede ${res.status}` };
          break;
        }
        result = await res.json();
        break;
      }

      case 'hent_ejerskab': {
        const res = await fetch(
          `${baseUrl}/api/ejerskab?bfeNummer=${encodeURIComponent(input.bfeNummer)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!res.ok) {
          result = { fejl: `Ejerskabs-API svarede ${res.status}` };
          break;
        }
        result = await res.json();
        break;
      }

      case 'hent_salgshistorik': {
        const res = await fetch(
          `${baseUrl}/api/salgshistorik?bfeNummer=${encodeURIComponent(input.bfeNummer)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!res.ok) {
          result = { fejl: `Salgshistorik-API svarede ${res.status}` };
          break;
        }
        result = await res.json();
        break;
      }

      case 'hent_energimaerke': {
        const res = await fetch(
          `${baseUrl}/api/energimaerke?bfeNummer=${encodeURIComponent(input.bfeNummer)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!res.ok) {
          result = { fejl: `Energimærke-API svarede ${res.status}` };
          break;
        }
        result = await res.json();
        break;
      }

      case 'hent_jordforurening': {
        const params = new URLSearchParams({
          ejerlavKode: input.ejerlavKode,
          matrikelnr: input.matrikelnr,
        });
        const res = await fetch(`${baseUrl}/api/jord?${params}`, {
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) {
          result = { fejl: `Jord-API svarede ${res.status}` };
          break;
        }
        result = await res.json();
        break;
      }

      case 'hent_plandata': {
        const res = await fetch(
          `${baseUrl}/api/plandata?adresseId=${encodeURIComponent(input.adresseId)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!res.ok) {
          result = { fejl: `Plandata-API svarede ${res.status}` };
          break;
        }
        result = await res.json();
        break;
      }

      case 'hent_cvr_virksomhed': {
        const res = await fetch(`${baseUrl}/api/cvr/${encodeURIComponent(input.cvr)}`, {
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) {
          result = { fejl: `CVR-API svarede ${res.status}` };
          break;
        }
        result = await res.json();
        break;
      }

      case 'hent_matrikeldata': {
        const res = await fetch(
          `${baseUrl}/api/matrikel?bfeNummer=${encodeURIComponent(input.bfeNummer)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!res.ok) {
          result = { matrikel: null, fejl: `HTTP ${res.status}` };
          break;
        }
        result = await res.json();
        break;
      }

      case 'hent_regnskab_noegletal': {
        const res = await fetch(
          `${baseUrl}/api/regnskab/xbrl?cvr=${encodeURIComponent(input.cvr)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!res.ok) {
          result = { fejl: `Regnskabs-API svarede ${res.status}` };
          break;
        }
        const xbrl = (await res.json()) as {
          years?: Array<{
            aar: number;
            periodeStart: string;
            periodeSlut: string;
            resultat: {
              omsaetning: number | null;
              aaretsResultat: number | null;
              resultatFoerSkat: number | null;
            };
            balance: {
              aktiverIAlt: number | null;
              egenkapital: number | null;
              gaeldsforpligtelserIAlt: number | null;
            };
            noegletal: { soliditetsgrad: number | null; overskudsgrad: number | null };
          }>;
          error?: string;
        };
        if (xbrl.error || !xbrl.years?.length) {
          result = {
            cvr: input.cvr,
            ingenRegnskab: true,
            besked: 'Ingen XBRL-regnskaber tilgængelige',
          };
          break;
        }
        result = {
          cvr: input.cvr,
          antalAar: xbrl.years.length,
          seneste: xbrl.years.slice(0, 3).map((y) => ({
            aar: y.aar,
            periode: `${y.periodeStart?.slice(0, 10)} → ${y.periodeSlut?.slice(0, 10)}`,
            omsaetning: y.resultat.omsaetning,
            aaretsResultat: y.resultat.aaretsResultat,
            resultatFoerSkat: y.resultat.resultatFoerSkat,
            egenkapital: y.balance.egenkapital,
            aktiverIAlt: y.balance.aktiverIAlt,
            gaeld: y.balance.gaeldsforpligtelserIAlt,
            soliditetsgrad: y.noegletal.soliditetsgrad,
            overskudsgrad: y.noegletal.overskudsgrad,
          })),
        };
        break;
      }

      case 'hent_datterselskaber': {
        const res = await fetch(
          `${baseUrl}/api/cvr-public/related?cvr=${encodeURIComponent(input.cvr)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!res.ok) {
          result = { fejl: `Related-API svarede ${res.status}` };
          break;
        }
        const relData = (await res.json()) as Array<{
          cvr: number;
          navn: string;
          ejerandel?: string | null;
          rolle?: string;
          aktiv?: boolean;
        }>;
        const datterselskaber = relData
          .filter((r) => r.aktiv !== false && r.ejerandel)
          .map((r) => ({ cvr: r.cvr, navn: r.navn, ejerandel: r.ejerandel, rolle: r.rolle }));
        result = { cvr: input.cvr, datterselskaber, antalMedEjerandel: datterselskaber.length };
        break;
      }

      case 'soeg_person_cvr': {
        const cvrUser = process.env.CVR_ES_USER;
        const cvrPass = process.env.CVR_ES_PASS;
        if (!cvrUser || !cvrPass) {
          result = { fejl: 'CVR system-til-system credentials ikke konfigureret' };
          break;
        }
        const searchBody = {
          size: 5,
          query: {
            bool: {
              should: [
                { match_phrase: { 'navne.navn': { query: input.navn, boost: 3 } } },
                { match: { 'navne.navn': { query: input.navn, fuzziness: 'AUTO', boost: 1 } } },
              ],
              minimum_should_match: 1,
            },
          },
          _source: ['enhedsNummer', 'navne', 'beliggenhedsadresse'],
        };
        const res = await fetch('http://distribution.virk.dk/cvr-permanent/deltager/_search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Basic ' + Buffer.from(`${cvrUser}:${cvrPass}`).toString('base64'),
          },
          body: JSON.stringify(searchBody),
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) {
          result = { fejl: `CVR søge-API svarede ${res.status}` };
          break;
        }
        const data = (await res.json()) as {
          hits: {
            total: { value: number };
            hits: Array<{
              _source: {
                enhedsNummer: number;
                navne?: Array<{ navn: string; periode?: { gyldigTil: string | null } }>;
                beliggenhedsadresse?: Array<{
                  vejnavn?: string;
                  husnummerFra?: number;
                  postnummer?: number;
                  postdistrikt?: string;
                }>;
              };
            }>;
          };
        };
        const hits = data.hits?.hits ?? [];
        result = {
          antalFundet: data.hits?.total?.value ?? 0,
          resultater: hits.map((h) => {
            const src = h._source;
            const aktivtNavn =
              src.navne?.find((n) => n.periode?.gyldigTil == null)?.navn ??
              src.navne?.[src.navne.length - 1]?.navn ??
              null;
            const adr = src.beliggenhedsadresse?.[0];
            return {
              enhedsNummer: String(src.enhedsNummer),
              navn: aktivtNavn,
              adresse: adr
                ? [adr.vejnavn, adr.husnummerFra, adr.postnummer, adr.postdistrikt]
                    .filter(Boolean)
                    .join(' ')
                : null,
            };
          }),
        };
        break;
      }

      case 'hent_person_virksomheder': {
        const cvrUser = process.env.CVR_ES_USER;
        const cvrPass = process.env.CVR_ES_PASS;
        if (!cvrUser || !cvrPass) {
          result = { fejl: 'CVR system-til-system credentials ikke konfigureret' };
          break;
        }
        const esQuery = input.enhedsNummer
          ? { term: { enhedsNummer: Number(input.enhedsNummer) } }
          : { match_phrase: { 'navne.navn': input.navn ?? '' } };
        const esRes = await fetch('http://distribution.virk.dk/cvr-permanent/deltager/_search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Basic ' + Buffer.from(`${cvrUser}:${cvrPass}`).toString('base64'),
          },
          body: JSON.stringify({
            size: 1,
            query: esQuery,
            _source: ['enhedsNummer', 'navne', 'deltagerRelation'],
          }),
          signal: AbortSignal.timeout(timeout),
        });
        if (!esRes.ok) {
          result = { fejl: `CVR deltager-API svarede ${esRes.status}` };
          break;
        }
        const esData = (await esRes.json()) as {
          hits: {
            hits: Array<{
              _source: {
                enhedsNummer: number;
                navne?: Array<{ navn: string }>;
                deltagerRelation?: Array<{
                  virksomhed?: { cvrNummer?: number; navn?: Array<{ navn: string }> };
                  organisationer?: Array<{
                    organisationsNavn?: Array<{ navn: string }>;
                    medlemsData?: Array<{
                      attributter?: Array<{
                        type: string;
                        vaerdier?: Array<{
                          vaerdi: string;
                          periode?: { gyldigTil: string | null };
                        }>;
                      }>;
                    }>;
                  }>;
                  periode?: { gyldigTil: string | null };
                }>;
              };
            }>;
          };
        };
        const hit = esData.hits?.hits?.[0]?._source;
        if (!hit) {
          result = { fejl: 'Person ikke fundet i CVR' };
          break;
        }
        const relations = (hit.deltagerRelation ?? [])
          .filter((r) => r.periode?.gyldigTil == null && r.virksomhed?.cvrNummer != null)
          .map((r) => {
            const cvr = String(r.virksomhed!.cvrNummer);
            const virksomhedNavn = r.virksomhed?.navn?.[r.virksomhed.navn.length - 1]?.navn ?? null;
            let ejerandelPct: number | null = null;
            const roller: string[] = [];
            for (const org of r.organisationer ?? []) {
              roller.push(org.organisationsNavn?.[org.organisationsNavn.length - 1]?.navn ?? '');
              for (const md of org.medlemsData ?? []) {
                for (const attr of md.attributter ?? []) {
                  if (
                    attr.type === 'EJERANDEL_PROCENT' &&
                    attr.vaerdier?.some((v) => v.periode?.gyldigTil == null)
                  ) {
                    const activeVal = attr.vaerdier.find((v) => v.periode?.gyldigTil == null);
                    if (activeVal) ejerandelPct = parseFloat(activeVal.vaerdi);
                  }
                }
              }
            }
            return { cvr, navn: virksomhedNavn, ejerandelPct, roller: roller.filter(Boolean) };
          });
        result = {
          enhedsNummer: hit.enhedsNummer,
          navn: hit.navne?.[hit.navne.length - 1]?.navn ?? null,
          aktiveTilknytninger: relations,
          antalAktive: relations.length,
        };
        break;
      }

      default:
        return { fejl: `Ukendt tool: ${name}` };
    }

    setCache(name, input, result);
    return result;
  } catch (err) {
    console.error('[analysis/run] Tool-kald fejl:', err);
    return { fejl: 'Ekstern API fejl' };
  }
}

// ─── System prompt builder ───────────────────────────────────────────────────

/**
 * Builds the system prompt for a given analysis type and entity.
 * Instructs Claude to use its tools to fetch real data before writing the analysis.
 *
 * @param type   - Analysis type identifier
 * @param entity - The selected entity with id, title, type
 * @returns Full system prompt string
 */
function buildSystemPrompt(type: AnalysisType, entity: AnalysisEntity): string {
  // Entity-type-specific data-gathering instructions
  const entityInstructions: Record<AnalysisEntity['type'], string> = {
    company: `
## Datahentning for virksomhed (CVR: ${entity.id})
Kald disse tools i rækkefølge (brug parallelle kald hvor muligt):
1. hent_cvr_virksomhed(cvr="${entity.id}") — basisinfo, adresse, branche
2. hent_regnskab_noegletal(cvr="${entity.id}") — regnskab for de seneste 3 år
3. hent_datterselskaber(cvr="${entity.id}") — datterselskaber og kapitalandele
4. For hvert datterselskab med ejerandel: kald hent_regnskab_noegletal parallelt`,

    address: `
## Datahentning for ejendom (DAWA adresse-ID: ${entity.id})
Kald disse tools i rækkefølge (brug parallelle kald hvor muligt):
1. dawa_adresse_detaljer(dawaId="${entity.id}") — hent BFE-nummer, kommunekode, matrikelnr, ejerlavkode
2. hent_bbr_data(dawaId="${entity.id}") — BBR bygningsdata
3. Når du har BFE-nummer fra trin 1, kald ALLE disse parallelt:
   - hent_vurdering(bfeNummer=..., kommunekode=...)
   - hent_forelobig_vurdering(adresseId="${entity.id}", bfeNummer=...)
   - hent_ejerskab(bfeNummer=...)
   - hent_salgshistorik(bfeNummer=...)
   - hent_energimaerke(bfeNummer=...)
   - hent_matrikeldata(bfeNummer=...)
   - hent_jordforurening(ejerlavKode=..., matrikelnr=...)
   - hent_plandata(adresseId="${entity.id}")`,

    person: `
## Datahentning for person (CVR enhedsNummer: ${entity.id})
Kald disse tools i rækkefølge (brug parallelle kald hvor muligt):
1. hent_person_virksomheder(enhedsNummer="${entity.id}") — alle ejede virksomheder med ejerandel
2. For ALLE ejede virksomheder: kald hent_regnskab_noegletal parallelt
3. For holdingselskaber (navn indeholder "Holding", "Invest", "Group"): kald hent_datterselskaber`,

    area: `
## Datahentning for område
Brug din viden om det danske ejendomsmarked og virksomhedsregister til at give et overblik over: ${entity.title}.
Supplér med relevante tools hvor det er muligt (f.eks. adresseopslag for konkrete adresser).`,
  };

  // Analysis-type-specific output instructions
  const outputInstructions: Record<AnalysisType, string> = {
    due_diligence: `
## Analyse-output: Due Diligence
Strukturér analysen med disse sektioner (brug ## til overskrifter):
## Sammenfatning
## Virksomhedsprofil / Ejendomsprofil
## Økonomi og regnskab (kun virksomheder)
## Ejerskab og struktur
## Risici og forbehold
## Konklusion og anbefalinger

Vær præcis og faktabaseret. Angiv tydeligt hvad der er fakta fra registre vs. din vurdering.`,

    konkurrent: `
## Analyse-output: Konkurrentanalyse
Hent CVR-data og regnskab for virksomheden. Brug din viden om branchen til at identificere konkurrenter.
Strukturér med disse sektioner:
## Virksomhedens profil og position
## Brancheoverblik
## Styrker og svagheder (SWOT-elementer)
## Nøgletal sammenlignet med branchegennemsnit
## Muligheder og trusler
## Konklusioner`,

    investering: `
## Analyse-output: Investeringsscreening
Hent al tilgængelig data og lav en investeringsvurdering.
Strukturér med disse sektioner:
## Aktiv-overblik
## Finansielt potentiale
## Risikoprofil
## Nøglepunkter til due diligence
## Samlet investeringsvurdering (lav / moderat / høj attraktivitet)`,

    marked: `
## Analyse-output: Markedsanalyse
Basér analysen på ejendomsdata og generel viden om det danske marked.
Strukturér med disse sektioner:
## Markedsoverblik for området
## Prisudvikling og tendenser
## Sammenligning med naboområder
## Risici og drivere
## Udsigter`,

    virksomhed: `
## Analyse-output: Virksomhedsanalyse
Hent CVR-data, regnskab og ejerskabsstruktur. Strukturér med disse sektioner:
## Sammenfatning
## Virksomhedsprofil (branche, stiftelse, ansatte, adresse)
## Regnskabsoversigt (seneste 3 år): omsætning, resultat, egenkapital, soliditetsgrad
## Ejerskab og ledelse
## Risikoprofil (likviditet, gæld, kapitalforhold)
## Konklusion`,

    ejendom: `
## Analyse-output: Ejendomsanalyse
Hent BBR, vurdering, foreløbig vurdering, ejerskab og salgshistorik. Strukturér med disse sektioner:
## Sammenfatning
## Ejendomsbeskrivelse (BBR: areal, opførelsesår, materialer, enheder)
## Offentlig vurdering vs. seneste handelspris
## Skatteberegning (grundskyld og ejendomsværdiskat)
## Ejerskabshistorik og nuværende ejer
## Skatteoptimeringspotentiale
## Konklusion`,

    ejerskab: `
## Analyse-output: Ejerskabsanalyse
Hent ejerskabsdata, datterselskaber og personrelationer. Strukturér med disse sektioner:
## Sammenfatning
## Koncernstruktur (moderselskab → datterselskaber)
## Ultimativ ejer (gennemgå holdinglag)
## Krydsejerskab og cirkulære strukturer
## Nøglepersoner og deres roller
## Risici ved ejerskabsstrukturen
## Konklusion`,

    omraade: `
## Analyse-output: Områdeanalyse
Brug viden om det danske marked og tilgængelige registre til at beskrive området. Strukturér med disse sektioner:
## Sammenfatning
## Geografisk og demografisk profil
## Ejendomspriser og prisudvikling
## Virksomhedstæthed og erhvervsaktivitet
## Infrastruktur og udviklingsplaner
## Investorinteresse og potentiale
## Konklusion`,

    portefolje: `
## Analyse-output: Porteføljeanalyse
Hent data for alle ejede aktiver (ejendomme og virksomheder) fra ejerskabsdata. Strukturér med disse sektioner:
## Sammenfatning
## Porteføljeoverblik (antal aktiver, samlet værdi)
## Ejendomsportefølje (vurdering, areal, lokation pr. ejendom)
## Virksomhedsportefølje (CVR, branche, omsætning pr. selskab)
## Koncentrations- og diversificeringsanalyse
## Samlet risikoprofil
## Konklusion`,
  };

  return `Du er en professionel erhvervs- og ejendomsanalytiker tilknyttet BizzAssist-platformen.

Du har DIREKTE ADGANG til danske offentlige registre via dine tools. Brug dem aktivt til at hente rigtige data.

## Entitet til analyse
Navn: ${entity.title}
Type: ${entity.type === 'address' ? 'Ejendom/adresse' : entity.type === 'company' ? 'Virksomhed' : 'Person'}
${entity.subtitle ? `Undertype: ${entity.subtitle}` : ''}
${entityInstructions[entity.type]}

${outputInstructions[type]}

## Generelle regler
- BRUG ALTID dine tools til at hente rigtig data — gæt aldrig
- Svar på dansk
- Præsenter data struktureret med markdown-overskrifter og tal
- Marker tydeligt hvad der er fakta (fra registre) vs. din vurdering
- Hvis et tool returnerer fejl eller manglende data, nævn det kort og fortsæt
- Kald gerne flere tools parallelt for at spare tid`;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * POST /api/analysis/run
 *
 * Authenticates the user, rate limits, runs tool-use loop (max 10 rounds),
 * and streams the analysis result as SSE.
 *
 * @param request - Incoming request with AnalysisRequestBody
 * @returns SSE stream or error NextResponse
 */
export async function POST(request: NextRequest): Promise<Response> {
  // BIZZ-236: AI access gated by API key availability (not env flag)
  if (!process.env.BIZZASSIST_CLAUDE_KEY) {
    return NextResponse.json(
      { error: 'AI-analyse er ikke konfigureret i dette miljø' },
      { status: 503 }
    );
  }

  // ── Auth ────────────────────────────────────────────────────────────────────
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // ── Rate limit ──────────────────────────────────────────────────────────────
  const identifier = getClientKey(request);
  const { success } = await getRateLimit().limit(identifier);
  if (!success) {
    return NextResponse.json(
      { error: 'For mange anmodninger — prøv igen om et øjeblik' },
      { status: 429 }
    );
  }

  // ── API key ─────────────────────────────────────────────────────────────────
  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey)
    return NextResponse.json({ error: 'BIZZASSIST_CLAUDE_KEY ikke konfigureret' }, { status: 500 });

  // ── Parse + validate body ────────────────────────────────────────────────────
  const parsed = await parseBody(request, analysisRunSchema);
  if (!parsed.success) return parsed.response;
  const body = parsed.data as unknown as AnalysisRequestBody;

  // ── Determine base URL for internal API self-calls ───────────────────────────
  const host = request.headers.get('host') ?? 'localhost:3000';
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  const baseUrl = `${proto}://${host}`;

  // ── SSE helpers ─────────────────────────────────────────────────────────────
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      /**
       * Enqueue a single SSE event.
       *
       * @param data - Raw SSE data string (without "data: " prefix)
       */
      const sse = (data: string): void => {
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      try {
        const client = new Anthropic({ apiKey });
        const systemPrompt = buildSystemPrompt(body.type, body.entity);

        const userMessage = `Lav analysen nu. Hent al tilgængelig data via dine tools og skriv en komplet analyse.`;

        // Tool-use loop — max 10 rounds to prevent runaway costs
        const MAX_ROUNDS = 10;
        let messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];
        let round = 0;

        while (round < MAX_ROUNDS) {
          round++;

          const response = await client.messages.create(
            {
              model: 'claude-sonnet-4-6',
              max_tokens: 8192,
              system: systemPrompt,
              tools: TOOLS,
              messages,
            },
            { signal: AbortSignal.timeout(60_000) }
          );

          // If Claude wants to use tools, execute them and loop
          if (response.stop_reason === 'tool_use') {
            const toolUseBlocks = response.content.filter(
              (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
            );

            // Send status message for each tool being called
            for (const block of toolUseBlocks) {
              const statusMsg = TOOL_STATUS[block.name] ?? `Kalder ${block.name}…`;
              sse(JSON.stringify({ status: statusMsg }));
            }

            // Execute all tools in parallel
            const toolResults = await Promise.all(
              toolUseBlocks.map(async (block) => ({
                type: 'tool_result' as const,
                tool_use_id: block.id,
                content: JSON.stringify(
                  await executeTool(block.name, block.input as Record<string, string>, baseUrl)
                ),
              }))
            );

            // Add assistant response + tool results to message history
            messages = [
              ...messages,
              { role: 'assistant', content: response.content },
              { role: 'user', content: toolResults },
            ];
            continue;
          }

          // Claude is done with tools — stream the text response
          for (const block of response.content) {
            if (block.type === 'text' && block.text) {
              // Stream in chunks for a smooth experience
              const CHUNK_SIZE = 20;
              for (let i = 0; i < block.text.length; i += CHUNK_SIZE) {
                sse(JSON.stringify({ t: block.text.slice(i, i + CHUNK_SIZE) }));
              }
            }
          }
          break;
        }

        if (round >= MAX_ROUNDS) {
          sse(JSON.stringify({ status: 'Maksimalt antal data-hentningsrunder nået' }));
        }

        sse('[DONE]');
        controller.close();
      } catch (err) {
        console.error('[analysis/run] SSE stream fejl:', err);
        sse(JSON.stringify({ error: 'AI-tjeneste fejl' }));
        sse('[DONE]');
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
