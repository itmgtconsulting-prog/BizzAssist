/**
 * POST /api/ai/chat
 *
 * Streaming chat endpoint for the AI Bizzness Assistent.
 * Uses Claude tool_use to fetch real data from internal BizzAssist API routes
 * (BBR, vurdering, ejerskab, energimærke, plandata, jordforurening, CVR)
 * and external DAWA endpoints — then analyses and presents the data.
 *
 * Flow:
 *  1. Send user messages + tool definitions to Claude
 *  2. If Claude responds with tool_use → execute tools (internal API calls)
 *  3. Send tool results back → repeat until Claude gives a text response
 *  4. Stream the final text response to the client via SSE
 *
 * SSE protocol:
 *  - `data: {"t":"<text>"}` — streamed text chunks
 *  - `data: {"status":"<msg>"}` — progress messages (tool calls in progress)
 *  - `data: {"error":"<msg>"}` — error messages
 *  - `data: [DONE]` — stream complete
 *
 * @param body.messages - Array of { role: 'user' | 'assistant', content: string }
 * @param body.context  - Optional context string (current page, property, company)
 * @returns SSE stream
 */

import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import * as Sentry from '@sentry/nextjs';
import { checkRateLimit, aiRateLimit } from '@/app/lib/rateLimit';
import { fetchBbrForAddress } from '@/app/lib/fetchBbrData';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient, tenantDb, type TenantDb } from '@/lib/supabase/admin';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/types';
import { logActivity } from '@/app/lib/activityLog';

export const runtime = 'nodejs';
export const maxDuration = 120;

// ─── Types ──────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatRequestBody {
  messages: ChatMessage[];
  context?: string;
}

// ─── Tool definitions ───────────────────────────────────────────────────────

/** Tool definitions that Claude can call to fetch real data */
const TOOLS: Anthropic.Tool[] = [
  {
    name: 'dawa_adresse_soeg',
    description:
      'Søg efter en dansk adresse via DAWA autocomplete. Returnerer matches med DAWA-id, vejnavn, husnr, postnr, by, kommune. Brug dette som første skridt når brugeren nævner en adresse.',
    input_schema: {
      type: 'object' as const,
      properties: {
        q: {
          type: 'string',
          description:
            'Søgestreng, f.eks. "Søbyvej 11, 2650 Hvidovre" eller "Vestergade 10, København"',
        },
      },
      required: ['q'],
    },
  },
  {
    name: 'dawa_adresse_detaljer',
    description:
      "Hent fulde detaljer for en DAWA adgangsadresse-ID — inkl. koordinater, matrikelnr, ejerlavkode, kommunekode, jordstykke og BFE-nummer. Kald dette efter dawa_adresse_soeg for at få de nødvendige ID'er til andre opslag.",
    input_schema: {
      type: 'object' as const,
      properties: {
        dawaId: { type: 'string', description: 'DAWA adgangsadresse UUID' },
      },
      required: ['dawaId'],
    },
  },
  {
    name: 'hent_bbr_data',
    description:
      'Hent BBR-bygningsdata (opførelsesår, areal, materialer, etager, opvarmning, supplerende varme, vandforsyning, bevaringsværdighed, enheder med boligtype og energiforsyning) for en ejendom via DAWA-adresse-ID. Returnerer også ejendomsrelationer med BFE-nummer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        dawaId: { type: 'string', description: 'DAWA adgangsadresse UUID' },
      },
      required: ['dawaId'],
    },
  },
  {
    name: 'hent_vurdering',
    description:
      'Hent offentlig ejendomsvurdering med udvidede data fra Datafordeler. Returnerer: ejendomsværdi, grundværdi, afgiftspligtige beløb, estimeret grundskyld, grundskyldspromille, juridisk kategori, vurderingshistorik (alle år), PLUS: ejerboligfordeling, grundværdispecifikation (areal × enhedspris nedbrydning), grundskatteloft (loftansættelse), skattefritagelser, og fradrag for forbedringer. Kræver BFE-nummer og kommunekode.',
    input_schema: {
      type: 'object' as const,
      properties: {
        bfeNummer: { type: 'string', description: 'BFE-nummer (Bestemt Fast Ejendom)' },
        kommunekode: { type: 'string', description: '4-cifret kommunekode, f.eks. "0167"' },
      },
      required: ['bfeNummer'],
    },
  },
  {
    name: 'hent_forelobig_vurdering',
    description:
      'Hent foreløbige ejendomsvurderinger fra Vurderingsportalen (det nye vurderingssystem). Returnerer: foreløbig ejendomsværdi, grundværdi, grundskyld, ejendomsværdiskat og total skat for nyeste vurderingsår (typisk 2024 og 2022). Disse er de faktiske skatteberegninger under det nye system — brug dem til skatteanalyse. Kan søges via adresseId (DAWA UUID) eller bfeNummer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        adresseId: { type: 'string', description: 'DAWA adgangsadresse UUID (foretrukket)' },
        bfeNummer: { type: 'string', description: 'BFE-nummer (fallback hvis adresseId mangler)' },
      },
      required: [],
    },
  },
  {
    name: 'hent_ejerskab',
    description:
      'Hent ejerskabsdata (ejertype, ejerforholdskode, ejerandel som brøk, CVR for selskaber, ejerskab-startdato) fra Datafordeler. Kræver BFE-nummer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        bfeNummer: { type: 'string', description: 'BFE-nummer' },
      },
      required: ['bfeNummer'],
    },
  },
  {
    name: 'hent_salgshistorik',
    description:
      'Hent salgshistorik (købesum, overtagelsesdato, overdragelsesmåde) fra Datafordeler. Kræver BFE-nummer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        bfeNummer: { type: 'string', description: 'BFE-nummer' },
      },
      required: ['bfeNummer'],
    },
  },
  {
    name: 'hent_energimaerke',
    description:
      'Hent energimærke (energiklasse A-G, gyldig fra/til dato, status, adresse, bygningsdata med varmeforsyning, PDF-link) fra Energistyrelsen. Kræver BFE-nummer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        bfeNummer: { type: 'string', description: 'BFE-nummer' },
      },
      required: ['bfeNummer'],
    },
  },
  {
    name: 'hent_jordforurening',
    description:
      'Hent jordforureningsstatus (V1/V2-kortlægning) fra Miljøportalen. Kræver ejerlavkode og matrikelnr (hent fra dawa_adresse_detaljer).',
    input_schema: {
      type: 'object' as const,
      properties: {
        ejerlavKode: { type: 'string', description: 'Ejerlavkode (numerisk)' },
        matrikelnr: { type: 'string', description: 'Matrikelnummer, f.eks. "21cn"' },
      },
      required: ['ejerlavKode', 'matrikelnr'],
    },
  },
  {
    name: 'hent_plandata',
    description:
      'Hent plandata (lokalplaner, kommuneplanrammer, delområder — med anvendelse, bebyggelsesprocent, max etager, max bygningshøjde) fra Plandata.dk. Kræver DAWA adresse-ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        adresseId: { type: 'string', description: 'DAWA adgangsadresse UUID' },
      },
      required: ['adresseId'],
    },
  },
  {
    name: 'hent_cvr_virksomhed',
    description:
      'Hent virksomhedsdata (navn, adresse, branche, ansatte, stiftelsesdato) for et specifikt CVR-nummer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        cvr: { type: 'string', description: '8-cifret CVR-nummer' },
      },
      required: ['cvr'],
    },
  },
  {
    name: 'hent_matrikeldata',
    description:
      'Henter matrikeloplysninger (jordstykker, matrikelnumre, arealer, fredskov, strandbeskyttelse, landbrugsnotering) for en ejendom fra Datafordeler MAT/v1. Kræver BFE-nummer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        bfeNummer: {
          type: 'string',
          description: 'BFE-nummer for ejendommen (f.eks. "6016117")',
        },
      },
      required: ['bfeNummer'],
    },
  },
  {
    name: 'hent_person_virksomheder',
    description:
      'Henter alle virksomheder en person er tilknyttet fra CVR-registret med ejerandel (%), rolle og CVR-nummer. Brug dette som første skridt i en formueanalyse — kald derefter hent_cvr_virksomhed for hvert CVR-nummer for at estimere virksomhedsværdier. Brug enhedsNummer hvis det kendes (fra kontekst eller søg_person_cvr), ellers søg på navn.',
    input_schema: {
      type: 'object' as const,
      properties: {
        enhedsNummer: {
          type: 'string',
          description: 'CVR enhedsnummer for personen (numerisk streng) — foretrukket',
        },
        navn: {
          type: 'string',
          description: 'Personens fulde navn — bruges som fallback hvis enhedsNummer ikke kendes',
        },
      },
      required: [],
    },
  },
  {
    name: 'hent_regnskab_noegletal',
    description:
      'Henter XBRL-regnskabsdata (balance og resultatopgørelse) for en virksomhed — egenkapital, aktiver, omsætning, årets resultat og nøgletal for de seneste 1-3 år. Brug dette til at estimere virksomhedsværdi i formueanalyse. Egenkapital er det mest direkte bud på bogført nettoværdi for holdingselskaber. Kald dette for ALLE virksomheder med ejerandel parallelt.',
    input_schema: {
      type: 'object' as const,
      properties: {
        cvr: { type: 'string', description: '8-cifret CVR-nummer' },
      },
      required: ['cvr'],
    },
  },
  {
    name: 'hent_datterselskaber',
    description:
      'Henter datterselskaber og kapitalandele for en virksomhed fra CVR. Brug dette når en ejet virksomhed er et holdingselskab (navn indeholder "Holding", "Invest" eller "Group") for at afdække den underliggende portefølje. Returnerer CVR-numre og ejerandele på niveau 2.',
    input_schema: {
      type: 'object' as const,
      properties: {
        cvr: { type: 'string', description: '8-cifret CVR-nummer for holdingselskabet' },
      },
      required: ['cvr'],
    },
  },
  {
    name: 'soeg_person_cvr',
    description:
      'Søger CVR-registret efter en person eller virksomhed på navn. Returnerer enhedsNummer, fuldt navn og registrerede adresser. Brug dette til at finde en persons CVR-enhedsnummer inden du kalder hent_person_virksomheder. Kald ALTID dette først hvis du kun kender et navn og ikke har enhedsNummer i konteksten.',
    input_schema: {
      type: 'object' as const,
      properties: {
        navn: {
          type: 'string',
          description: 'Personens fulde navn eller del af navn, f.eks. "Jakob Juul Rasmussen"',
        },
      },
      required: ['navn'],
    },
  },
  {
    name: 'hent_tinglysning',
    description:
      'Henter tinglysningsdata for en ejendom fra Den Digitale Tinglysning (e-TL). Returnerer ejere (adkomsthavere) med navne, ejerandele og CVR; hæftelser (pantebreve) med beløb, kreditor og låntype; samt servitutter med titler og påtaleberettigede. Kræver BFE-nummer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        bfeNummer: {
          type: 'string',
          description: 'BFE-nummer for ejendommen',
        },
      },
      required: ['bfeNummer'],
    },
  },
];

// ─── Tool labels (for status messages) ──────────────────────────────────────

const TOOL_STATUS: Record<string, string> = {
  dawa_adresse_soeg: 'Søger adresse…',
  dawa_adresse_detaljer: 'Henter adressedetaljer…',
  hent_bbr_data: 'Henter BBR-bygningsdata…',
  hent_vurdering: 'Henter ejendomsvurdering…',
  hent_ejerskab: 'Henter ejerskabsdata…',
  hent_salgshistorik: 'Henter salgshistorik…',
  hent_energimaerke: 'Henter energimærke…',
  hent_jordforurening: 'Henter jordforureningsdata…',
  hent_plandata: 'Henter plandata…',
  hent_cvr_virksomhed: 'Henter CVR-data…',
  hent_matrikeldata: 'Henter matrikeldata…',
  hent_person_virksomheder: 'Henter personens virksomhedstilknytninger…',
  hent_regnskab_noegletal: 'Henter regnskabsnøgletal…',
  hent_datterselskaber: 'Henter datterselskaber…',
  soeg_person_cvr: 'Søger efter person i CVR…',
  hent_tinglysning: 'Henter tinglysningsdata…',
};

// ─── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Du er AI Bizzness Assistent — en intelligent ejendoms- og virksomhedsrådgiver bygget ind i BizzAssist-platformen.

Du har DIREKTE ADGANG til danske offentlige registre via dine tools. Brug dem aktivt!

## Workflow ved ejendomsspørgsmål
1. Søg adressen med dawa_adresse_soeg
2. Kald SAMTIDIGT: dawa_adresse_detaljer + hent_bbr_data (begge bruger dawaId)
3. Når du har BFE-nr + kommunekode + ejerlavkode + matrikelnr + adresseId, kald ALLE relevante tools SAMTIDIGT i én omgang:
   - hent_vurdering (bfeNummer + kommunekode) — endelige vurderinger (gammelt + nyt system)
   - hent_forelobig_vurdering (adresseId + bfeNummer) — foreløbige vurderinger med skatteberegning
   - hent_ejerskab (bfeNummer)
   - hent_salgshistorik (bfeNummer)
   - hent_energimaerke (bfeNummer)
   - hent_jordforurening (ejerlavKode + matrikelnr)
   - hent_plandata (adresseId)
   - hent_matrikeldata (bfeNummer)

VIGTIGT: Kald så mange tools som muligt i SAMME runde for at spare tid. Vent ikke på ét tool-resultat hvis du allerede har alle nødvendige parametre.

## Data-forståelse
- **hent_vurdering**: Endelige vurderinger fra Datafordeler. Feltet erNytSystem=true markerer det nye vurderingssystem (2020+). juridiskKategoriKode "0" = gammelt system, "1100"+ = nyt system.
- **hent_forelobig_vurdering**: Foreløbige vurderinger fra Vurderingsportalen. Indeholder de FAKTISKE skatteberegninger: grundskyld, ejendomsværdiskat, total skat. Vurderingsår 2024 = beskatningsår 2025. Brug ALTID dette til skatteanalyse.
- Kombiner begge vurderings-kilder: endelige for historisk overblik, foreløbige for nuværende og fremtidig beskatning.
- **Matrikeldata**: Brug \`hent_matrikeldata\` for at se jordstykker, matrikelnumre, registrerede arealer, og noteringstyper (fredskov, strandbeskyttelse, klitfredning, jordrente, landbrugsnotering). Kræver BFE-nummer.

## Regler
- BRUG ALTID dine tools til at hente rigtig data — gæt aldrig
- Svar ALTID på dansk medmindre brugeren skriver på engelsk
- Præsenter data struktureret med overskrifter og tal
- Hold svar fokuserede — vis de mest relevante data først
- Ved analyse: kombiner data fra flere kilder til en samlet vurdering
- Marker tydeligt hvad der er fakta (fra registre) vs. din vurdering
- Hvis et tool returnerer fejl eller manglende data, nævn det kort og fortsæt med de øvrige data
- Kald gerne flere tools for at give et komplet billede
- BFE-nummer findes typisk i jordstykke-objektet fra dawa_adresse_detaljer (feltet "bfenummer" eller i ejendomsrelationer fra BBR)

## Workflow ved formueanalyse for en person

### REGEL 1 — Vælg den rigtige liste baseret på spørgsmålstype
Konteksten indeholder to separate lister markeret med tags:
- **[EJERSKAB]** — selskaber med registreret ejerandel
- **[FUNKTIONSROLLER]** — selskaber hvor personen er direktør/bestyrelsesmedlem uden ejerandel

**Spørgsmål om formue, værdi, aktiver, ejerandele → brug KUN [EJERSKAB]-listen.**
Direktørroller og bestyrelsesposter uden ejerandel ignoreres fuldstændigt i formueberegning.

**Spørgsmål om netværk, bestyrelser, brancheforbindelser, tilknytninger → brug BEGGE lister.**
Her er [FUNKTIONSROLLER] relevant og skal inkluderes.

### REGEL 2 — Hent regnskaber parallelt
For ALLE virksomheder med ejerandel: kald hent_regnskab_noegletal parallelt (alle på én gang).
Egenkapital = bogført nettoværdi. Markedsværdi-multipel: 1–3× egenkapital for holdingselskaber, 3–8× EBITDA for driftsselskaber.

### REGEL 3 — Holdingkæder (effektiv ejerandel, op til 3 niveauer)
Hvis et ejet selskab er holdingselskab (navn indeholder "Holding", "Invest", "Group", "Management" eller ingen ansatte):
- Kald hent_datterselskaber → niveau 2-selskaber med ejerandele
- Hvis niveau 2-selskaber OGSÅ er holdingselskaber: kald hent_datterselskaber på dem → niveau 3
- Gå max 3 niveauer ned

Beregn EFFEKTIV ejerandel multiplicativt:
- Niveau 2: personens % × niveau1's % i niveau2
- Niveau 3: personens % × niveau1's % × niveau2's % i niveau3

Konkret eksempel (3-lags kæde):
- Jakob ejer 90% af JaJR Holding → JaJR Holding ejer 100% af JaJR Holding 2 → JaJR Holding 2 ejer 100% af JAJR Ejendomme 2
- Jakobs effektive andel i JAJR Ejendomme 2 = 90% × 100% × 100% = **90%**
- JAJR Ejendomme 2 skal medtages i formueestimatet med 90% effektiv ejerandel

Kald hent_regnskab_noegletal for ALLE niveau 2 og 3 selskaber parallelt.

Nævn ALTID eksplicit i svaret som en del af forbeholdene:
"⚠️ Holding-analysen går max 3 niveauer ned i ejerskabskæden. Dybere strukturer (niveau 4+) kan forekomme og er ikke medregnet i dette estimat."
Hvis du støder på et niveau 3-selskab der OGSÅ ser ud som et holdingselskab, nævn det specifikt: "XXXX ser ud til at være endnu et holdingselskab — dets underliggende aktiver er ikke kortlagt her."

### REGEL 4 — Præsentation
Strukturér svaret: tabel med ejede selskaber (ejerandel | egenkapital | estimeret værdi), holdingkæder med effektive andele, samlet estimat (lav/høj), og eksplicit forbehold om bogførte vs. markedsværdier.

### Trin-for-trin:
1. Er "Personens EJEDE virksomheder med ejerandel" i konteksten? → Brug listen direkte
2. Ellers: hent via enhedsNummer eller soeg_person_cvr
3. Kald hent_regnskab_noegletal for ALLE ejede selskaber PARALLELT
4. For holdingselskaber: kald hent_datterselskaber parallelt
5. Præsenter struktureret resultat med tydelige forbehold

## KRITISK: Brug af side-kontekst (læs dette FØR du planlægger tool-kald)
Systemet injicerer automatisk ID'er fra den side brugeren kigger på under "Tilgængelige ID'er (brug direkte i tool-kald)".

**Regler — ingen undtagelser:**
- Er "CVR enhedsnummer (person): XXXXXXXX" listet → kald hent_person_virksomheder med dette enhedsNummer DIREKTE. Søg IKKE på navn.
- Er "BFE-nummer: XXXXXXX" listet → kald hent_vurdering, hent_ejerskab osv. direkte. Søg IKKE adressen.
- Er "CVR-nummer: XXXXXXXX" listet → kald hent_cvr_virksomhed direkte. Søg IKKE CVR.
- Kald ALDRIG soeg_person_cvr hvis enhedsNummer allerede er i konteksten.
- Kald ALDRIG dawa_adresse_soeg hvis adresseId eller bfeNummer allerede er i konteksten.`;

// ─── Tool result cache ──────────────────────────────────────────────────────

/** TTL for cached tool results — 5 minutes */
const TOOL_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  result: unknown;
  expiresAt: number;
}

/** Module-level cache shared across requests within the same serverless instance */
const toolCache = new Map<string, CacheEntry>();

/** Returns cached result if still valid, otherwise null */
function getCached(name: string, input: Record<string, string>): unknown | null {
  const key = `${name}:${JSON.stringify(input)}`;
  const entry = toolCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    toolCache.delete(key);
    return null;
  }
  return entry.result;
}

/** Stores a tool result in the cache */
function setCache(name: string, input: Record<string, string>, result: unknown): void {
  const key = `${name}:${JSON.stringify(input)}`;
  toolCache.set(key, { result, expiresAt: Date.now() + TOOL_CACHE_TTL_MS });
}

// ─── Tool executor ──────────────────────────────────────────────────────────

/**
 * Executes a tool by calling the appropriate internal API route or external endpoint.
 * Results are cached in-memory for 5 minutes to avoid duplicate API calls within a session.
 *
 * BIZZ-239: Provide a clear, actionable error message for tool API failures.
 * 401 errors in dev are expected (IP not whitelisted) — explain this to the AI.
 */
function toolErrorMessage(apiName: string, status: number): string {
  if (status === 401 || status === 403) {
    return `${apiName} returnerede ${status} (ikke autoriseret). Adgangsnogler eller IP-whitelisting mangler for dette register. Data er ikke tilgaengeligt i det aktuelle miljoe.`;
  }
  return `${apiName} svarede ${status}`;
}

/**
 * @param name - Tool name matching one of TOOLS[].name
 * @param input - Tool input parameters from Claude
 * @param baseUrl - Base URL for internal API routes (e.g. http://localhost:3000)
 * @returns JSON-serialisable result object
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
      // TODO(BIZZ-92): Migrate to DAR before 1 July 2026
      case 'dawa_adresse_soeg': {
        // Server-side proxy via DAR (DAWA lukker 1. juli 2026)
        const res = await fetch(
          `${baseUrl}/api/adresse/autocomplete?q=${encodeURIComponent(input.q)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!res.ok) {
          result = { fejl: toolErrorMessage('Adresse-autocomplete', res.status) };
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

      // TODO(BIZZ-92): Migrate to DAR before 1 July 2026
      case 'dawa_adresse_detaljer': {
        // Server-side proxy via DAR (DAWA lukker 1. juli 2026)
        const res = await fetch(
          `${baseUrl}/api/adresse/lookup?id=${encodeURIComponent(input.dawaId)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!res.ok) {
          result = { fejl: toolErrorMessage('Adresse-opslag', res.status) };
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
        // Direct function call — no HTTP self-call (self-calls are unreliable on Vercel serverless)
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
          result = { fejl: toolErrorMessage('Vurderings-API', res.status) };
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
          result = { fejl: toolErrorMessage('Foreloebig-vurderings-API', res.status) };
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
          result = { fejl: toolErrorMessage('Ejerskabs-API', res.status) };
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
          result = { fejl: toolErrorMessage('Salgshistorik-API', res.status) };
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
          result = { fejl: toolErrorMessage('Energimaerke-API', res.status) };
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
          result = { fejl: toolErrorMessage('Jordforurenings-API', res.status) };
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
          result = { fejl: toolErrorMessage('Plandata-API', res.status) };
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
          result = { fejl: toolErrorMessage('CVR-API', res.status) };
          break;
        }
        result = await res.json();
        break;
      }

      case 'hent_matrikeldata': {
        const bfe = input.bfeNummer as string;
        const matRes = await fetch(`${baseUrl}/api/matrikel?bfeNummer=${encodeURIComponent(bfe)}`, {
          signal: AbortSignal.timeout(timeout),
        });
        if (!matRes.ok) {
          result = { matrikel: null, fejl: `HTTP ${matRes.status}` };
          break;
        }
        result = await matRes.json();
        break;
      }

      case 'hent_regnskab_noegletal': {
        // Henter XBRL-regnskab (balance + resultat) via intern route.
        // Returnerer de seneste 2 regnskabsår med nøgletal for formueestimering.
        const xbrlRes = await fetch(
          `${baseUrl}/api/regnskab/xbrl?cvr=${encodeURIComponent(input.cvr)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!xbrlRes.ok) {
          result = { fejl: toolErrorMessage('Regnskabs-API', xbrlRes.status) };
          break;
        }
        const xbrlData = (await xbrlRes.json()) as {
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
              langfristetGaeld: number | null;
            };
            noegletal: {
              soliditetsgrad: number | null;
              overskudsgrad: number | null;
              afkastningsgrad: number | null;
            };
          }>;
          error?: string;
        };

        if (xbrlData.error || !xbrlData.years?.length) {
          result = {
            cvr: input.cvr,
            ingenRegnskab: true,
            besked: 'Ingen XBRL-regnskaber tilgængelige for dette CVR-nummer',
          };
          break;
        }

        // Returnér de seneste 2 år — nok til at vurdere trend
        result = {
          cvr: input.cvr,
          antalAar: xbrlData.years.length,
          seneste: xbrlData.years.slice(0, 2).map((y) => ({
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
        // Henter relaterede virksomheder (datterselskaber/kapitalandele) via CVR-public/related.
        const relRes = await fetch(
          `${baseUrl}/api/cvr-public/related?cvr=${encodeURIComponent(input.cvr)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!relRes.ok) {
          result = { fejl: toolErrorMessage('Related-API', relRes.status) };
          break;
        }
        const relData = (await relRes.json()) as Array<{
          cvr: number;
          navn: string;
          ejerandel?: string | null;
          rolle?: string;
          aktiv?: boolean;
        }>;

        // Filtrer til aktive datterselskaber med ejerandel
        const datterselskaber = relData
          .filter((r) => r.aktiv !== false && r.ejerandel)
          .map((r) => ({
            cvr: r.cvr,
            navn: r.navn,
            ejerandel: r.ejerandel,
            rolle: r.rolle,
          }));

        result = {
          cvr: input.cvr,
          datterselskaber,
          antalMedEjerandel: datterselskaber.length,
          totalRelaterede: relData.length,
        };
        break;
      }

      case 'soeg_person_cvr': {
        // Søger CVR ES deltager-indeks på navn med phrase-match.
        // Returnerer enhedsNummer + navnehistorik + aktuelle adresser.
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
                // Exact phrase match — højest prioritet
                { match_phrase: { 'navne.navn': { query: input.navn, boost: 3 } } },
                // Fuzzy match for stavefejl
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
          result = { fejl: toolErrorMessage('CVR-soege-API', res.status) };
          break;
        }

        const data = (await res.json()) as {
          hits: {
            total: { value: number };
            hits: Array<{
              _score: number;
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
            // Aktive navne (gyldigTil == null) — ellers seneste
            const aktivtNavn =
              src.navne?.find((n) => n.periode?.gyldigTil == null)?.navn ??
              src.navne?.[src.navne.length - 1]?.navn ??
              null;
            const adresse = src.beliggenhedsadresse?.[0];
            return {
              enhedsNummer: String(src.enhedsNummer),
              navn: aktivtNavn,
              adresse: adresse
                ? [adresse.vejnavn, adresse.husnummerFra, adresse.postnummer, adresse.postdistrikt]
                    .filter(Boolean)
                    .join(' ')
                : null,
            };
          }),
        };
        break;
      }

      case 'hent_person_virksomheder': {
        // Query CVR ES deltager index for all companies linked to a person.
        // Uses system-to-system credentials (same as /api/cvr route).
        const cvrUser = process.env.CVR_ES_USER;
        const cvrPass = process.env.CVR_ES_PASS;
        if (!cvrUser || !cvrPass) {
          result = { fejl: 'CVR system-til-system credentials ikke konfigureret' };
          break;
        }

        // Build ES query — prefer enhedsNummer (exact), fall back to phrase match on navn.
        // match_phrase kræver ordene i den rigtige rækkefølge, hvilket giver færre falske matches.
        const esQuery = input.enhedsNummer
          ? { term: { enhedsNummer: Number(input.enhedsNummer) } }
          : { match_phrase: { 'navne.navn': input.navn ?? '' } };

        const esBody = {
          size: 1,
          query: esQuery,
          _source: ['enhedsNummer', 'navne', 'deltagerRelation'],
        };

        const esRes = await fetch('http://distribution.virk.dk/cvr-permanent/deltager/_search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Basic ' + Buffer.from(`${cvrUser}:${cvrPass}`).toString('base64'),
          },
          body: JSON.stringify(esBody),
          signal: AbortSignal.timeout(timeout),
        });

        if (!esRes.ok) {
          result = { fejl: toolErrorMessage('CVR-deltager-API', esRes.status) };
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

        // Extract active ownership relations (gyldigTil IS NULL means still active)
        const relations = (hit.deltagerRelation ?? [])
          .filter((r) => r.periode?.gyldigTil == null && r.virksomhed?.cvrNummer != null)
          .map((r) => {
            const cvr = String(r.virksomhed!.cvrNummer);
            const virksomhedNavn = r.virksomhed?.navn?.[r.virksomhed.navn.length - 1]?.navn ?? null;

            // Extract ejerandel (%) and rolle from organisation attributes
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

            return {
              cvr,
              navn: virksomhedNavn,
              ejerandelPct,
              roller: roller.filter(Boolean),
            };
          });

        result = {
          enhedsNummer: hit.enhedsNummer,
          navn: hit.navne?.[hit.navne.length - 1]?.navn ?? null,
          aktiveTilknytninger: relations,
          antalAktive: relations.length,
        };
        break;
      }

      // BIZZ-233: Tinglysning (e-TL) — ejere, hæftelser, servitutter
      case 'hent_tinglysning': {
        // Step 1: Get tinglysning UUID from BFE number
        const uuidRes = await fetch(
          `${baseUrl}/api/tinglysning?bfe=${encodeURIComponent(input.bfeNummer)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!uuidRes.ok) {
          result = { fejl: toolErrorMessage('Tinglysning UUID-opslag', uuidRes.status) };
          break;
        }
        const uuidData = (await uuidRes.json()) as { uuid?: string };
        if (!uuidData.uuid) {
          result = { fejl: 'Ingen tinglysning UUID fundet for denne ejendom' };
          break;
        }

        // Step 2: Get summarisk data (ejere, hæftelser, servitutter)
        const sumRes = await fetch(
          `${baseUrl}/api/tinglysning/summarisk?uuid=${encodeURIComponent(uuidData.uuid)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!sumRes.ok) {
          result = { fejl: toolErrorMessage('Tinglysning summarisk', sumRes.status) };
          break;
        }
        result = await sumRes.json();
        break;
      }

      default:
        return { fejl: `Ukendt tool: ${name}` };
    }
    setCache(name, input, result);
    return result;
  } catch (err) {
    return { fejl: err instanceof Error ? err.message : 'Ukendt fejl ved tool-kald' };
  }
}

// ─── Token budget helpers ────────────────────────────────────────────────────

/** Default monthly token limit per tenant when no plan-level override exists. */
const TENANT_MONTHLY_TOKEN_LIMIT = 2_000_000; // 2 M tokens/month

/**
 * Checks whether the tenant has exceeded their monthly AI token budget
 * by summing rows in `tenant.ai_token_usage` since the 1st of the current month.
 * Fails-open on any DB error so transient failures never block legitimate users.
 *
 * @param adminClient - Supabase admin client (service-role, can access all schemas)
 * @param tenantId    - The tenant UUID to check, or null (skips check)
 * @returns true if the tenant has reached or exceeded TENANT_MONTHLY_TOKEN_LIMIT
 */
async function isTenantMonthlyBudgetExceeded(
  adminClient: SupabaseClient<Database>,
  tenantId: string | null
): Promise<boolean> {
  if (!tenantId) return false;
  try {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const db: TenantDb = adminClient.schema('tenant');
    const { data: usageData } = await db
      .from('ai_token_usage')
      .select('tokens_in, tokens_out')
      .eq('tenant_id', tenantId)
      .gte('created_at', monthStart.toISOString());

    const monthlyTokens = (usageData ?? []).reduce(
      (sum, r) => sum + (r.tokens_in ?? 0) + (r.tokens_out ?? 0),
      0
    );
    return monthlyTokens >= TENANT_MONTHLY_TOKEN_LIMIT;
  } catch {
    // Fail-open: do not block request on DB error
    return false;
  }
}

/**
 * Inserts a token-usage record into `tenant.ai_token_usage` for billing and auditing.
 * Fire-and-forget — failures are silently swallowed so they never affect streaming.
 *
 * @param adminClient - Supabase admin client (service-role)
 * @param tenantId    - The tenant UUID
 * @param userId      - The authenticated user UUID
 * @param tokensIn    - Input tokens consumed in this Claude API call
 * @param tokensOut   - Output tokens consumed in this Claude API call
 */
function recordTenantTokenUsage(
  adminClient: SupabaseClient<Database>,
  tenantId: string,
  userId: string,
  tokensIn: number,
  tokensOut: number
): void {
  void (async () => {
    try {
      const db: TenantDb = adminClient.schema('tenant');
      await db.from('ai_token_usage').insert({
        tenant_id: tenantId,
        user_id: userId,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        model: 'claude-sonnet-4-6',
      });
    } catch {
      // Non-critical — best-effort tracking
    }
  })();
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<Response> {
  // BIZZ-236: AI access gated by API key availability (not env flag)
  if (!process.env.BIZZASSIST_CLAUDE_KEY) {
    return Response.json({ error: 'AI-chat er ikke konfigureret i dette miljø' }, { status: 503 });
  }

  // Rate limit: 10 req/min for AI chat
  const limited = await checkRateLimit(request, aiRateLimit);
  if (limited) return limited;

  // Require an authenticated user — AI chat consumes paid API tokens
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Require an active subscription — read app_metadata via admin client (not exposed to JWT)
  const adminClient = createAdminClient();
  const { data: freshUser } = await adminClient.auth.admin.getUserById(user.id);
  const sub = freshUser?.user?.app_metadata?.subscription as
    | { status?: string; tokensUsedThisMonth?: number; bonusTokens?: number; planId?: string }
    | null
    | undefined;
  if (!sub || sub.status !== 'active') {
    return Response.json(
      { error: 'Aktivt abonnement kræves for at bruge AI-assistenten' },
      { status: 403 }
    );
  }

  // Guard: reject immediately if token quota is exhausted.
  // Fetch effective token limit from plan_configs; fall back to 0 (unlimited) if unavailable.
  const tokensUsedThisMonth = sub.tokensUsedThisMonth ?? 0;
  let effectiveTokenLimit = 0;
  if (sub.planId) {
    const { data: planRow } = await adminClient
      .from('plan_configs')
      .select('ai_tokens_per_month')
      .eq('plan_id', sub.planId)
      .single<{ ai_tokens_per_month: number }>();
    const bonusTokens = sub.bonusTokens ?? 0;
    effectiveTokenLimit = (planRow?.ai_tokens_per_month ?? 0) + bonusTokens;
  }
  if (effectiveTokenLimit > 0 && tokensUsedThisMonth >= effectiveTokenLimit) {
    return Response.json({ error: 'Token kvote opbrugt for denne måned' }, { status: 429 });
  }

  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey) {
    return Response.json(
      { error: 'BIZZASSIST_CLAUDE_KEY ikke konfigureret. Tilføj den i .env.local' },
      { status: 500 }
    );
  }

  // Fetch the user's recently viewed entities from the tenant schema.
  // These are injected into the system prompt so the AI can reference them
  // without the user having to re-explain what they were looking at.
  // Non-critical — failures are silently swallowed.
  let recentEntitiesContext = '';
  /** Formatted tenant knowledge base context injected into the system prompt. */
  let knowledgeContext = '';
  // Captured for activity logging below — avoids a second membership lookup
  let resolvedTenantId: string | null = null;
  try {
    const { data: membership } = await adminClient
      .from('tenant_memberships')
      .select('tenant_id')
      .eq('user_id', user.id)
      .limit(1)
      .single();
    if (membership?.tenant_id) {
      resolvedTenantId = membership.tenant_id as string;
    }

    if (membership?.tenant_id) {
      const { data: tenantRow } = await adminClient
        .from('tenants')
        .select('schema_name')
        .eq('id', membership.tenant_id)
        .single();

      if (tenantRow?.schema_name) {
        const db = tenantDb(tenantRow.schema_name);
        const { data: recents } = await db
          .from('recent_entities')
          .select('entity_type, entity_id, display_name, visited_at')
          .eq('user_id', user.id)
          .in('entity_type', ['property', 'company', 'person'])
          .order('visited_at', { ascending: false })
          .limit(15);

        if (recents && recents.length > 0) {
          // Group by entity_type for a readable summary
          const grouped: Record<string, Array<{ entity_id: string; display_name: string }>> = {};
          for (const r of recents as Array<{
            entity_type: string;
            entity_id: string;
            display_name: string;
            visited_at: string;
          }>) {
            if (!grouped[r.entity_type]) grouped[r.entity_type] = [];
            grouped[r.entity_type].push({
              entity_id: r.entity_id,
              display_name: r.display_name,
            });
          }

          const typeLabels: Record<string, string> = {
            property: 'Ejendomme',
            company: 'Virksomheder',
            person: 'Personer',
          };

          const lines: string[] = ['## Brugerens seneste aktivitet'];
          for (const [type, items] of Object.entries(grouped)) {
            lines.push(`\n**${typeLabels[type] ?? type}:**`);
            for (const item of items) {
              lines.push(`- ${item.display_name} (id: ${item.entity_id})`);
            }
          }
          lines.push(
            '\nBrug disse entiteter som kontekst. Når brugeren refererer til "den" eller "den seneste" uden at specificere, antag de mener den øverste i listen ovenfor.'
          );

          recentEntitiesContext = lines.join('\n');
        }
      }
    }
  } catch {
    // Non-critical — AI still works without recent entities context
  }

  // ── Tenant knowledge base context injection ───────────────────────────────
  // Fetches the 5 most recent knowledge items for the tenant and appends them
  // to the system prompt so the AI can reference company-specific information
  // without the user having to repeat it.
  // Max 2000 chars per item to keep token usage predictable.
  // Non-critical — failures are silently swallowed.
  if (resolvedTenantId) {
    try {
      const { data: knowledgeItems } = await (
        adminClient as unknown as {
          schema: (s: string) => {
            from: (t: string) => {
              select: (cols: string) => {
                eq: (
                  col: string,
                  val: string
                ) => {
                  order: (
                    col: string,
                    opts: { ascending: boolean }
                  ) => {
                    limit: (n: number) => Promise<{
                      data: Array<{ title: string; content: string }> | null;
                    }>;
                  };
                };
              };
            };
          };
        }
      )
        .schema('tenant')
        .from('tenant_knowledge')
        .select('title, content')
        .eq('tenant_id', resolvedTenantId)
        .order('created_at', { ascending: false })
        .limit(5);

      if (knowledgeItems && knowledgeItems.length > 0) {
        const formatted = knowledgeItems
          .map((k) => `[VIDEN: ${k.title}]\n${k.content.slice(0, 2000)}`)
          .join('\n\n');
        knowledgeContext = `## Organisationens videnbase\n${formatted}`;
      }
    } catch {
      // Non-critical — AI still works without knowledge context
    }
  }

  // ── Per-tenant monthly token budget check (Supabase table-based) ─────────
  // Supplements the app_metadata check above with a durable, per-tenant record
  // in tenant.ai_token_usage. On DB error we fail-open (let the request through)
  // to avoid false-positives caused by transient DB issues.
  // resolvedTenantId is populated by the membership lookup above.
  const tenantBudgetExceeded = await isTenantMonthlyBudgetExceeded(adminClient, resolvedTenantId);
  if (tenantBudgetExceeded) {
    return new Response(
      JSON.stringify({ error: 'Månedlig AI-kvote nået. Kontakt support for at opgradere.' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body: ChatRequestBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const { messages, context } = body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: 'Ingen beskeder' }, { status: 400 });
  }

  // ── Input validation — guard against oversized payloads ──────────────────
  /** Maximum number of messages accepted per request (prevents token amplification). */
  const MAX_MESSAGES = 50;
  /** Maximum characters allowed per message content string. */
  const MAX_CONTENT_CHARS = 10_000;

  if (messages.length > MAX_MESSAGES) {
    return Response.json({ error: `Maks ${MAX_MESSAGES} beskeder pr. anmodning` }, { status: 400 });
  }

  const oversizedMessage = messages.find(
    (m) => typeof m.content === 'string' && m.content.length > MAX_CONTENT_CHARS
  );
  if (oversizedMessage) {
    return Response.json(
      { error: `Besked overstiger maks ${MAX_CONTENT_CHARS} tegn` },
      { status: 400 }
    );
  }

  // Fire-and-forget: log this AI chat call for usage analytics.
  // promptLength is the character count of the last user message — no raw text stored.
  if (resolvedTenantId) {
    const lastMessage = messages[messages.length - 1];
    const promptLength = typeof lastMessage?.content === 'string' ? lastMessage.content.length : 0;
    logActivity(adminClient, resolvedTenantId, user.id, 'ai_chat', { promptLength });
  }

  // Resolve base URL for internal API calls
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `http://localhost:3000`;

  // Build system prompt — append knowledge base, recent entities and page context if available
  let systemPrompt = SYSTEM_PROMPT;
  // Inject knowledge base first so it forms stable background knowledge
  if (knowledgeContext) {
    systemPrompt += `\n\n${knowledgeContext}`;
  }
  if (recentEntitiesContext) {
    systemPrompt += `\n\n${recentEntitiesContext}`;
  }
  if (context) {
    systemPrompt += `\n\n## Aktuel kontekst\nBrugeren kigger på: ${context}`;
  }

  // Map to Anthropic format (only simple text messages from the client)
  const anthropicMessages: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const client = new Anthropic({ apiKey });
  const encoder = new TextEncoder();

  /** Helper: enqueue SSE event */
  const sse = (controller: ReadableStreamDefaultController, data: string) => {
    controller.enqueue(encoder.encode(`data: ${data}\n\n`));
  };

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const MAX_TOOL_ROUNDS = 15;
        let round = 0;

        /** Track total token usage across all Claude API calls in this request */
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        while (round < MAX_TOOL_ROUNDS) {
          round++;

          // Call Claude (non-streaming for tool rounds, streaming for final)
          const response = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 4096,
            system: systemPrompt,
            tools: TOOLS,
            messages: anthropicMessages,
          });

          // Accumulate token usage from this API call
          totalInputTokens += response.usage?.input_tokens ?? 0;
          totalOutputTokens += response.usage?.output_tokens ?? 0;

          // Check for tool_use blocks
          const toolUseBlocks = response.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
          );

          if (toolUseBlocks.length === 0) {
            // ── Final text response — stream it to client ──
            const text = response.content
              .filter((b): b is Anthropic.TextBlock => b.type === 'text')
              .map((b) => b.text)
              .join('');

            // Stream in chunks — 200 chars reduces SSE overhead vs. perceived smoothness
            const CHUNK = 200;
            for (let i = 0; i < text.length; i += CHUNK) {
              sse(controller, JSON.stringify({ t: text.slice(i, i + CHUNK) }));
            }

            // Send token usage summary before closing stream
            const totalTokens = totalInputTokens + totalOutputTokens;
            sse(
              controller,
              JSON.stringify({
                usage: {
                  inputTokens: totalInputTokens,
                  outputTokens: totalOutputTokens,
                  totalTokens,
                },
              })
            );

            sse(controller, '[DONE]');
            controller.close();

            // Fire-and-forget: persist token usage so quota check works next request
            adminClient.auth.admin
              .updateUserById(user.id, {
                app_metadata: {
                  ...freshUser?.user?.app_metadata,
                  subscription: {
                    ...sub,
                    tokensUsedThisMonth: tokensUsedThisMonth + totalTokens,
                  },
                },
              })
              .catch(() => {}); // non-critical — best-effort tracking

            // Fire-and-forget: record in tenant.ai_token_usage for auditable per-tenant billing
            if (resolvedTenantId) {
              recordTenantTokenUsage(
                adminClient,
                resolvedTenantId,
                user.id,
                totalInputTokens,
                totalOutputTokens
              );
            }

            return;
          }

          // ── Execute tools ──
          // Send status to client for each tool
          for (const toolBlock of toolUseBlocks) {
            const label = TOOL_STATUS[toolBlock.name] ?? 'Henter data…';
            sse(controller, JSON.stringify({ status: label }));
          }

          // Add assistant response (with tool_use blocks) to message history
          anthropicMessages.push({ role: 'assistant', content: response.content });

          // Execute all tools in parallel
          const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
            toolUseBlocks.map(async (toolBlock) => {
              const result = await executeTool(
                toolBlock.name,
                toolBlock.input as Record<string, string>,
                baseUrl
              );
              return {
                type: 'tool_result' as const,
                tool_use_id: toolBlock.id,
                content: JSON.stringify(result),
              };
            })
          );

          // Add tool results as "user" message
          anthropicMessages.push({ role: 'user', content: toolResults });
        }

        // If we exhausted tool rounds, send what we have + usage
        sse(
          controller,
          JSON.stringify({
            t: 'Jeg nåede max antal data-opslag. Her er hvad jeg fandt — stil gerne et opfølgende spørgsmål.',
          })
        );
        const totalTokens = totalInputTokens + totalOutputTokens;
        sse(
          controller,
          JSON.stringify({
            usage: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              totalTokens,
            },
          })
        );
        sse(controller, '[DONE]');
        controller.close();

        // Fire-and-forget: persist token usage so quota check works next request
        adminClient.auth.admin
          .updateUserById(user.id, {
            app_metadata: {
              ...freshUser?.user?.app_metadata,
              subscription: {
                ...sub,
                tokensUsedThisMonth: tokensUsedThisMonth + totalTokens,
              },
            },
          })
          .catch(() => {}); // non-critical — best-effort tracking

        // Fire-and-forget: record in tenant.ai_token_usage for auditable per-tenant billing
        if (resolvedTenantId) {
          recordTenantTokenUsage(
            adminClient,
            resolvedTenantId,
            user.id,
            totalInputTokens,
            totalOutputTokens
          );
        }
      } catch (err) {
        // Capture unexpected errors (not routine Claude API errors) in Sentry
        if (!(err instanceof Anthropic.APIError)) {
          Sentry.captureException(err);
        }
        const msg =
          err instanceof Anthropic.APIError
            ? `API-fejl (${err.status}): ${err.message}`
            : err instanceof Error
              ? err.message
              : 'Ukendt fejl';
        sse(controller, JSON.stringify({ error: msg }));
        sse(controller, '[DONE]');
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
