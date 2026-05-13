/**
 * POST /api/analyse/forsikring-gap
 *
 * BIZZ-1223: Forsikrings-gap-analyse backend.
 * Modtager kundeId + policeliste, henter aktiver fra interne API'er,
 * matcher policer mod aktiver, og returnerer struktureret gap-rapport.
 *
 * Input: { kundeType, kundeId, policer[] }
 * Output: { aktiver[], gaps[], score, summary }
 *
 * @retention Ingen PII persisteres — ren beregning.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import { createAdminClient } from '@/lib/supabase/admin';
import { getEjfToken } from '@/app/lib/ejfIngest';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { EJF_GQL_ENDPOINT, DAWA_BASE_URL } from '@/app/lib/serviceEndpoints';
import { fetchDawa } from '@/app/lib/dawa';
import type { ForsikringsType, ParsedPolice } from '@/app/lib/parsePoliceFile';

export const maxDuration = 60;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Input body — enten policer-array ELLER fritekst (BIZZ-1280) */
interface GapAnalyseBody {
  kundeType: 'person' | 'virksomhed';
  kundeId: string;
  policer?: ParsedPolice[];
  /** BIZZ-1280: Fritekst med forsikringsbeskrivelse — parser server-side */
  fritekst?: string;
}

/** Et fundet aktiv fra BizzAssist data */
export interface FundetAktiv {
  id: string;
  type: 'ejendom' | 'køretøj' | 'virksomhed' | 'bestyrelsespost';
  label: string;
  /** Vurdering/værdi i DKK */
  vaerdi: number | null;
  /** Adresse eller identifikation */
  adresse: string | null;
  /** BFE-nummer (ejendomme) */
  bfe: number | null;
  /** CVR-nummer (virksomheder) */
  cvr: string | null;
  /** Risikofaktorer */
  risikofaktorer: string[];
  /** Matchende police (null = uforsikret) */
  matchetPolice: ParsedPolice | null;
}

/** Et gap i forsikringsdækningen */
export interface ForsikringsGap {
  aktiv: FundetAktiv;
  gapType: 'uforsikret' | 'underforsikret' | 'manglende_ansvar' | 'risiko';
  risikoScore: 'lav' | 'middel' | 'hoej';
  besked: string;
  anbefaletDaekning: number | null;
}

/** Samlet resultat */
export interface GapAnalyseResult {
  aktiver: FundetAktiv[];
  gaps: ForsikringsGap[];
  summary: {
    totalAktiver: number;
    forsikrede: number;
    uforsikrede: number;
    underforsikrede: number;
    risikoAktiver: number;
    samletVaerdi: number;
    samletDaekning: number;
  };
}

// ─── BIZZ-1280: Fritekst-parsing ────────────────────────────────────────────

/** Keyword→type mapping for simpel fritekst-parsing */
const FRITEKST_TYPE_MAP: Array<{ keywords: string[]; type: ForsikringsType }> = [
  { keywords: ['hus', 'villa', 'parcelhus', 'bolig', 'ejerlejlighed'], type: 'husforsikring' },
  { keywords: ['bygning', 'erhvervsejendom', 'ejendom'], type: 'bygningsforsikring' },
  { keywords: ['indbo', 'løsøre', 'bohave'], type: 'indboforsikring' },
  { keywords: ['bil', 'køretøj', 'auto', 'kasko', 'motor'], type: 'bilforsikring' },
  { keywords: ['erhverv', 'driftstab', 'varelager'], type: 'erhvervsforsikring' },
  { keywords: ['ansvar', 'erstatning', 'liability'], type: 'ansvarsforsikring' },
  { keywords: ['bestyrelse', 'd&o', 'directors'], type: 'bestyrelsesansvar' },
  { keywords: ['arbejdsskade', 'arbejdsulykke'], type: 'arbejdsskadeforsikring' },
  { keywords: ['rejse', 'udland'], type: 'rejseforsikring' },
  { keywords: ['liv', 'pension', 'død'], type: 'livsforsikring' },
];

/**
 * Parser fritekst til policer via keyword-matching.
 * Splitter på linjer/sætninger og matcher mod kendte forsikringstyper.
 *
 * @param tekst - Fritekst med forsikringsbeskrivelse
 * @returns Array af parsed policer
 */
function parseFritekstTilPolicer(tekst: string): ParsedPolice[] {
  const policer: ParsedPolice[] = [];
  const linjer = tekst
    .split(/[\n;,]+/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (let idx = 0; idx < linjer.length; idx++) {
    const linje = linjer[idx];
    const lower = linje.toLowerCase();
    let matchedType: ForsikringsType = 'andet';
    for (const { keywords, type } of FRITEKST_TYPE_MAP) {
      if (keywords.some((kw) => lower.includes(kw))) {
        matchedType = type;
        break;
      }
    }

    // Forsøg at finde beløb (dækningssum)
    const beloebMatch = linje.match(/(\d[\d.]*)\s*(?:kr|dkk|mio)/i);
    let daekningssum: number | null = null;
    if (beloebMatch) {
      const raw = beloebMatch[1].replace(/\./g, '');
      daekningssum = parseInt(raw, 10);
      if (lower.includes('mio')) daekningssum *= 1_000_000;
    }

    policer.push({
      type: matchedType,
      rawType: linje.slice(0, 100),
      daekningssum,
      selskab: null,
      objekt: null,
      policenummer: null,
      udloebsdato: null,
      linje: idx + 1,
    });
  }

  // Dedup: kun én police per type
  const seen = new Set<string>();
  return policer.filter((p) => {
    if (seen.has(p.type)) return false;
    seen.add(p.type);
    return true;
  });
}

// ─── Aktiv-hentning ─────────────────────────────────────────────────────────

/** EJF GraphQL response for CVR-ejerskab */
interface EjfCvrNode {
  bestemtFastEjendomBFENr: number | null;
}

/** EJF GraphQL wrapper */
interface EjfGqlResult {
  data?: Record<string, { nodes?: EjfCvrNode[] }>;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

/**
 * Henter BFE-numre for et CVR via ejf_ejerskab cache → live EJF GraphQL fallback.
 * Ingen intern HTTP-roundtrip — kalder DB og Datafordeler direkte.
 *
 * @param cvr - CVR-nummer
 * @returns Array af BFE-numre
 */
async function hentBfeForCvr(cvr: string): Promise<number[]> {
  // ── Trin 1: Cache-lookup i ejf_ejerskab ──
  let staleBfes: number[] = [];
  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: cached, error: cacheErr } = await (admin as any)
      .from('ejf_ejerskab')
      .select('bfe_nummer, sidst_opdateret')
      .eq('ejer_cvr', cvr)
      .eq('status', 'gældende')
      .limit(500);

    if (!cacheErr && cached && cached.length > 0) {
      const freshest = Math.max(
        ...cached.map((r: { sidst_opdateret: string | null }) =>
          r.sidst_opdateret ? new Date(r.sidst_opdateret).getTime() : 0
        )
      );
      const STALE_MS = 7 * 24 * 60 * 60 * 1000;
      if (Date.now() - freshest < STALE_MS) {
        const bfes: number[] = cached
          .map((r: { bfe_nummer: number }) => r.bfe_nummer)
          .filter((b: number) => b != null);
        logger.log(`[forsikring-gap] Cache hit: ${bfes.length} BFE for CVR ${cvr}`);
        return [...new Set(bfes)];
      }
      logger.log(`[forsikring-gap] Cache stale for CVR ${cvr} — prøver live EJF`);
      // Gem stale data som fallback hvis live EJF fejler
      staleBfes = cached
        .map((r: { bfe_nummer: number }) => r.bfe_nummer)
        .filter((b: number) => b != null);
    }
  } catch (err) {
    logger.warn('[forsikring-gap] Cache lookup fejl:', err instanceof Error ? err.message : err);
  }

  // ── Trin 2: Live EJF GraphQL ──
  const token = await getEjfToken();
  if (!token) {
    // Graceful fallback: brug stale cache-data hvis live EJF ikke er tilgængelig
    if (staleBfes.length > 0) {
      logger.warn(
        `[forsikring-gap] EJF token unavailable — bruger stale cache (${staleBfes.length} BFE)`
      );
      return [...new Set(staleBfes)];
    }
    throw new Error('Kunne ikke hente Datafordeler-token — OAuth-nøgler mangler eller er ugyldige');
  }

  const virkningstid = new Date().toISOString();
  const query = `{
    EJFCustom_EjerskabBegraenset(
      first: 500
      virkningstid: "${virkningstid}"
      where: { ejendeVirksomhedCVRNr: { eq: ${parseInt(cvr, 10)} } }
    ) {
      nodes { bestemtFastEjendomBFENr }
    }
  }`;

  const res = await fetch(proxyUrl(EJF_GQL_ENDPOINT), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...proxyHeaders(),
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(proxyTimeout()),
  });

  if (res.status === 403) {
    throw new Error('Datafordeler-adgang afvist (403) — manglende rettigheder til EJF');
  }
  if (!res.ok) {
    throw new Error(`EJF GraphQL returnerede ${res.status}`);
  }

  const json = (await res.json()) as EjfGqlResult;
  const authError = json.errors?.some(
    (e) => e.extensions?.code === 'DAF-AUTH-0001' || e.message?.includes('not authorized')
  );
  if (authError) {
    throw new Error('EJF-autorisation fejlede (DAF-AUTH-0001)');
  }

  const nodes = Object.values(json.data ?? {})[0]?.nodes ?? [];
  const bfes = nodes.map((n) => n.bestemtFastEjendomBFENr).filter((b): b is number => b != null);

  logger.log(`[forsikring-gap] Live EJF: ${bfes.length} BFE for CVR ${cvr}`);
  return [...new Set(bfes)];
}

/**
 * Resolver adresse for ét BFE-nummer via DAWA.
 *
 * @param bfe - BFE-nummer
 * @returns Adressestreng eller null
 */
async function hentAdresseForBfe(bfe: number): Promise<string | null> {
  try {
    const res = await fetchDawa(
      `${DAWA_BASE_URL}/bfe/${bfe}`,
      { signal: AbortSignal.timeout(8000) },
      { caller: 'forsikring-gap.bfe-adresse' }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      beliggenhedsadresse?: {
        vejnavn?: string;
        husnr?: string;
        postnr?: string;
        postnrnavn?: string;
      };
    };
    const bel = json.beliggenhedsadresse;
    if (!bel?.vejnavn) return null;
    const parts = [bel.vejnavn, bel.husnr].filter(Boolean).join(' ');
    const post = [bel.postnr, bel.postnrnavn].filter(Boolean).join(' ');
    return post ? `${parts}, ${post}` : parts;
  } catch {
    return null;
  }
}

/**
 * Henter alle aktiver for en kunde.
 *
 * Virksomhed-flow (direkte — ingen intern HTTP-roundtrip):
 *   1. ejf_ejerskab cache → live EJF GraphQL → BFE-numre
 *   2. DAWA → adresser per BFE
 *   3. /api/tinglysning/bilbog → køretøjer (intern fetch, ikke kritisk)
 *
 * Person-flow (intern fetch — person-data kræver CVR-API):
 *   1. /api/ejerskab/person-bridge → navn + fødselsdato
 *   2. /api/ejerskab/person-properties → BFE-numre
 *   3. /api/bfe-addresses → adresser per BFE
 *   4. /api/cvr-public/person → virksomheder + bestyrelsesposter
 *
 * @param kundeType - person eller virksomhed
 * @param kundeId - enhedsNummer eller CVR
 * @param host - Request host for intern fetch (person-flow + bilbog)
 * @param cookie - Cookie header for auth
 * @returns Array af fundne aktiver
 */
async function hentAktiver(
  kundeType: string,
  kundeId: string,
  host: string,
  cookie: string
): Promise<FundetAktiv[]> {
  const base = host.startsWith('localhost') ? `http://${host}` : `https://${host}`;
  const headers = { cookie };
  const aktiver: FundetAktiv[] = [];

  if (kundeType === 'person') {
    // Step 1: Brug person-bridge til at få navn + fødselsdato fra enhedsNummer
    let personNavn = '';
    let foedselsdato = '';
    try {
      const bridgeRes = await fetch(`${base}/api/ejerskab/person-bridge?enhedsNummer=${kundeId}`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (bridgeRes.ok) {
        const bridge = await bridgeRes.json();
        personNavn = bridge.navn ?? '';
        foedselsdato = bridge.foedselsdato ?? '';
      }
    } catch (err) {
      logger.warn('[forsikring-gap] person-bridge fejlede:', err);
    }

    // Step 2+3: Hent ejendomme (kræver navn + fdato) OG virksomheder parallelt
    const [ejdResult, virkResult] = await Promise.allSettled([
      // Ejendomme via person-properties → bfe-addresses
      (async () => {
        if (!personNavn || !foedselsdato) return;
        const ppRes = await fetch(
          `${base}/api/ejerskab/person-properties?navn=${encodeURIComponent(personNavn)}&fdato=${foedselsdato}`,
          { headers, signal: AbortSignal.timeout(10000) }
        );
        if (!ppRes.ok) return;
        const ppData = await ppRes.json();
        const bfes: number[] =
          ppData?.bfes ?? ppData?.properties?.map((p: { bfeNummer: number }) => p.bfeNummer) ?? [];
        if (bfes.length === 0) return;

        // Berig med adresser
        const addrRes = await fetch(`${base}/api/bfe-addresses`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ bfes: bfes.slice(0, 50) }),
          signal: AbortSignal.timeout(10000),
        });
        const addrMap: Record<number, string> = {};
        if (addrRes.ok) {
          const addrData = await addrRes.json();
          for (const a of addrData?.addresses ?? []) {
            addrMap[a.bfe] = a.adresse;
          }
        }

        for (const bfe of bfes) {
          aktiver.push({
            id: `ejendom-${bfe}`,
            type: 'ejendom',
            label: addrMap[bfe] ?? `BFE ${bfe}`,
            vaerdi: null,
            adresse: addrMap[bfe] ?? null,
            bfe,
            cvr: null,
            risikofaktorer: [],
            matchetPolice: null,
          });
        }
      })(),
      // Virksomheder via cvr-public/person
      (async () => {
        const virkRes = await fetch(`${base}/api/cvr-public/person?enhedsNummer=${kundeId}`, {
          headers,
          signal: AbortSignal.timeout(15000),
        });
        if (!virkRes.ok) return;
        const data = await virkRes.json();
        for (const v of data?.virksomheder ?? []) {
          // BIZZ-1295: Skip ophørte selskaber — kun aktive virksomheder er relevante for gap-analyse
          if (v.aktiv === false) continue;

          // BIZZ-1295: Check om personen har aktive roller (til=null)
          const aktiveRoller = (v.roller ?? []).filter(
            (r: { til: string | null }) => r.til == null
          );
          if (aktiveRoller.length === 0) continue;

          // Virksomheder personen ejer → erhvervsforsikring-gap
          aktiver.push({
            id: `virksomhed-${v.cvr}`,
            type: 'virksomhed',
            label: `${v.navn} (CVR ${v.cvr})`,
            vaerdi: null,
            adresse: null,
            bfe: null,
            cvr: String(v.cvr),
            risikofaktorer: [],
            matchetPolice: null,
          });
          // Bestyrelsesposter → D&O ansvarsforsikring-gap (kun aktive roller)
          const harBestyrelseRolle = aktiveRoller.some((r: { rolle: string }) =>
            /bestyrelse|direktion/i.test(r.rolle)
          );
          if (harBestyrelseRolle) {
            const rolleLabels = aktiveRoller.map((r: { rolle: string }) => r.rolle).join(', ');
            aktiver.push({
              id: `bestyrelsespost-${v.cvr}`,
              type: 'bestyrelsespost',
              label: `${v.navn} (${rolleLabels})`,
              vaerdi: null,
              adresse: null,
              bfe: null,
              cvr: String(v.cvr),
              risikofaktorer: [],
              matchetPolice: null,
            });
          }
        }
      })(),
    ]);

    if (ejdResult.status === 'rejected') {
      logger.error('[forsikring-gap] Ejendom-hentning fejlede:', ejdResult.reason);
      throw new Error('Kunne ikke hente ejendomsdata — prøv igen senere');
    }
    if (virkResult.status === 'rejected') {
      logger.warn('[forsikring-gap] Virksomhed-hentning fejlede:', virkResult.reason);
    }
  } else {
    // ── Virksomhed: direkte DB + EJF (ingen intern HTTP-roundtrip) ──

    // Trin 1: Hent BFE-numre via cache → live EJF fallback
    const bfes = await hentBfeForCvr(kundeId);

    // Trin 2+3: Hent adresser (DAWA) + køretøjer (bilbog) parallelt
    const DAWA_CONCURRENCY = 10;
    const adresseMap = new Map<number, string | null>();

    const [addrResult, bilResult] = await Promise.allSettled([
      // DAWA adresse-opslag med begrænset parallelisme
      (async () => {
        for (let i = 0; i < bfes.length; i += DAWA_CONCURRENCY) {
          const chunk = bfes.slice(i, i + DAWA_CONCURRENCY);
          const results = await Promise.allSettled(
            chunk.map(async (bfe) => {
              const addr = await hentAdresseForBfe(bfe);
              adresseMap.set(bfe, addr);
            })
          );
          for (const r of results) {
            if (r.status === 'rejected') {
              logger.warn('[forsikring-gap] DAWA adresse-opslag fejlede:', r.reason);
            }
          }
        }
      })(),
      // Køretøjer via bilbog (intern fetch — ikke kritisk for analyse)
      (async () => {
        try {
          const res = await fetch(`${base}/api/tinglysning/bilbog?cvr=${kundeId}`, {
            headers,
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) return;
          const data = await res.json();
          for (const bil of data?.biler ?? []) {
            aktiver.push({
              id: `koeretoej-${bil.uuid}`,
              type: 'køretøj',
              label: [bil.fabrikat, bil.aargang, bil.registreringsnummer].filter(Boolean).join(' '),
              vaerdi: null,
              adresse: bil.registreringsnummer ?? bil.stelnummer ?? null,
              bfe: null,
              cvr: null,
              risikofaktorer: [],
              matchetPolice: null,
            });
          }
        } catch (err) {
          logger.warn('[forsikring-gap] Bilbog fejlede:', err);
        }
      })(),
    ]);

    if (addrResult.status === 'rejected') {
      logger.warn('[forsikring-gap] Adresse-batch fejlede:', addrResult.reason);
    }
    if (bilResult.status === 'rejected') {
      logger.warn('[forsikring-gap] Bilbog fejlede:', bilResult.reason);
    }

    // Byg ejendoms-aktiver fra BFE + adresser
    for (const bfe of bfes) {
      const adresse = adresseMap.get(bfe) ?? null;
      aktiver.push({
        id: `ejendom-${bfe}`,
        type: 'ejendom',
        label: adresse ?? `BFE ${bfe}`,
        vaerdi: null,
        adresse,
        bfe,
        cvr: null,
        risikofaktorer: [],
        matchetPolice: null,
      });
    }
  }

  return aktiver;
}

// ─── Gap-detektion ──────────────────────────────────────────────────────────

/** Mapper aktiv-type til relevante forsikringstyper */
const AKTIV_TIL_FORSIKRING: Record<string, ForsikringsType[]> = {
  ejendom: ['husforsikring', 'bygningsforsikring', 'indboforsikring'],
  køretøj: ['bilforsikring'],
  virksomhed: ['erhvervsforsikring', 'ansvarsforsikring'],
  bestyrelsespost: ['bestyrelsesansvar'],
};

/**
 * Matcher policer mod aktiver og identificerer gaps.
 *
 * @param aktiver - Fundne aktiver fra BizzAssist
 * @param policer - Kundens eksisterende policer
 * @returns Gaps med risiko-scoring
 */
function detectGaps(aktiver: FundetAktiv[], policer: ParsedPolice[]): ForsikringsGap[] {
  const gaps: ForsikringsGap[] = [];

  for (const aktiv of aktiver) {
    const relevantTypes = AKTIV_TIL_FORSIKRING[aktiv.type] ?? [];

    // Find matchende police — prioriter specifik objekt-match, ellers type-match.
    // En police UDEN objekt dækker alle aktiver af matchende type (fx "husforsikring"
    // dækker alle ejendomme). En police MED objekt dækker kun det specifikke aktiv.
    const match = policer.find((p) => {
      if (!relevantTypes.includes(p.type)) return false;
      // Specifik objekt-match: kun match hvis adresse/regnr matcher
      if (p.objekt && aktiv.adresse) {
        const pObj = p.objekt.toLowerCase();
        const aAddr = aktiv.adresse.toLowerCase();
        return pObj.includes(aAddr) || aAddr.includes(pObj);
      }
      // Generel type-match: policen dækker denne aktiv-type
      return true;
    });

    if (match) {
      aktiv.matchetPolice = match;
      // Tjek for underforsikring — kun relevant når vi har vurdering + dækningssum
      if (aktiv.vaerdi && match.daekningssum && match.daekningssum < aktiv.vaerdi * 0.8) {
        gaps.push({
          aktiv,
          gapType: 'underforsikret',
          risikoScore: match.daekningssum < aktiv.vaerdi * 0.5 ? 'hoej' : 'middel',
          besked: `Dækningssum ${match.daekningssum?.toLocaleString('da-DK')} DKK er under 80% af vurdering ${aktiv.vaerdi.toLocaleString('da-DK')} DKK`,
          anbefaletDaekning: aktiv.vaerdi,
        });
      }
    } else {
      // Uforsikret
      gaps.push({
        aktiv,
        gapType: aktiv.type === 'bestyrelsespost' ? 'manglende_ansvar' : 'uforsikret',
        risikoScore: aktiv.vaerdi && aktiv.vaerdi > 1_000_000 ? 'hoej' : 'middel',
        besked:
          aktiv.type === 'bestyrelsespost'
            ? `Bestyrelsespost i ${aktiv.label} uden D&O-forsikring`
            : `${aktiv.label} er ikke dækket af nogen forsikringspolice`,
        anbefaletDaekning: aktiv.vaerdi,
      });
    }

    // Risikofaktorer tilføjes til aktiv
    if (aktiv.risikofaktorer.length > 0) {
      gaps.push({
        aktiv,
        gapType: 'risiko',
        risikoScore: 'middel',
        besked: `Risikofaktorer: ${aktiv.risikofaktorer.join(', ')}`,
        anbefaletDaekning: null,
      });
    }
  }

  return gaps.sort((a, b) => {
    const score = { hoej: 3, middel: 2, lav: 1 };
    return score[b.risikoScore] - score[a.risikoScore];
  });
}

// ─── Route handler ──────────────────────────────────────────────────────────

/**
 * POST handler — forsikrings-gap-analyse.
 *
 * @param request - POST med kundeId + policer
 * @returns GapAnalyseResult
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const blocked = await assertAiAllowed(auth.userId);
  if (blocked) return blocked as NextResponse;

  let body: GapAnalyseBody;
  try {
    body = (await request.json()) as GapAnalyseBody;
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  if (!body.kundeId || !body.kundeType) {
    return NextResponse.json({ error: 'Mangler kundeType eller kundeId' }, { status: 400 });
  }

  // BIZZ-1280: Enten policer-array eller fritekst er required
  if (!body.policer?.length && !body.fritekst?.trim()) {
    return NextResponse.json({ error: 'Mangler policer eller fritekst' }, { status: 400 });
  }

  try {
    const host = request.headers.get('host') ?? 'localhost:3000';
    const cookie = request.headers.get('cookie') ?? '';

    // BIZZ-1280: Parse fritekst til policer via simple pattern matching
    let policer = body.policer ?? [];
    if (policer.length === 0 && body.fritekst?.trim()) {
      policer = parseFritekstTilPolicer(body.fritekst.trim());
    }

    // Hent aktiver
    const aktiver = await hentAktiver(body.kundeType, body.kundeId, host, cookie);

    // BIZZ-1223: Hvis ingen aktiver fundet, returnér fejl — analysen kræver data
    if (aktiver.length === 0) {
      return NextResponse.json(
        {
          error:
            body.kundeType === 'virksomhed'
              ? 'Kunne ikke finde aktiver (ejendomme/køretøjer) for dette CVR-nummer. Prøv igen senere — data kan være midlertidigt utilgængelige.'
              : 'Kunne ikke finde aktiver for denne person. Prøv igen senere — data kan være midlertidigt utilgængelige.',
        },
        { status: 404 }
      );
    }

    // Detect gaps
    const gaps = detectGaps(aktiver, policer);

    // Summary
    const forsikrede = aktiver.filter((a) => a.matchetPolice).length;
    const uforsikrede = gaps.filter(
      (g) => g.gapType === 'uforsikret' || g.gapType === 'manglende_ansvar'
    ).length;
    const underforsikrede = gaps.filter((g) => g.gapType === 'underforsikret').length;
    const risikoAktiver = gaps.filter((g) => g.gapType === 'risiko').length;
    const samletVaerdi = aktiver.reduce((s, a) => s + (a.vaerdi ?? 0), 0);
    const samletDaekning = (body.policer ?? []).reduce((s, p) => s + (p.daekningssum ?? 0), 0);

    const result: GapAnalyseResult = {
      aktiver,
      gaps,
      summary: {
        totalAktiver: aktiver.length,
        forsikrede,
        uforsikrede,
        underforsikrede,
        risikoAktiver,
        samletVaerdi,
        samletDaekning,
      },
    };

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ukendt fejl';
    logger.error('[forsikring-gap] Fejl:', msg);
    return NextResponse.json(
      {
        error:
          msg.includes('Datafordeler') || msg.includes('ejendomsdata')
            ? msg
            : 'Kunne ikke hente data til analysen — prøv igen senere',
      },
      { status: 502 }
    );
  }
}
