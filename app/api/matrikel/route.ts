/**
 * GET /api/matrikel
 *
 * Henter matrikeldata (Samlet Fast Ejendom + jordstykker) fra Datafordeler MAT GraphQL v1.
 *
 * Flow:
 *   1. Validerer bfeNummer query-param
 *   2. Sender GraphQL-forespørgsel til MAT/v1 med bitemporale parametre
 *   3. Prøver fuld query med fredskov/strandbeskyttelse/klitfredning/jordrente —
 *      falder tilbage til simpel query hvis skemaet ikke understøtter disse felter
 *   4. Mapper rå MAT-data til klient-venligt MatrikelResponse
 *
 * Auth: API key som query-param (MAT er "frie data" / zone 0).
 * Cache: 24 timer — matrikeldata ændres sjældent.
 *
 * @param request - Next.js request med ?bfeNummer=xxx
 * @returns MatrikelResponse
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { resolveTenantId } from '@/lib/api/auth';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Et enkelt jordstykke (matrikelnummer) tilknyttet ejendommen */
export interface MatrikelJordstykke {
  id: string;
  matrikelnummer: string;
  registreretAreal: number | null;
  arealtype: string | null;
  vejareal: number | null;
  faelleslod: boolean;
  fredskov: boolean | null;
  strandbeskyttelse: boolean | null;
  klitfredning: boolean | null;
  jordrente: boolean | null;
  ejerlavskode: string | null;
  ejerlavsnavn: string | null;
}

/** Samlet Fast Ejendom — hovedobjektet fra Matriklen */
export interface MatrikelEjendom {
  bfeNummer: number;
  status: string | null;
  erFaelleslod: boolean;
  landbrugsnotering: string | null;
  opdeltIEjerlejligheder: boolean;
  arbejderbolig: boolean;
  udskiltVej: boolean;
  jordstykker: MatrikelJordstykke[];
}

/** API-svaret fra denne route */
export interface MatrikelResponse {
  matrikel: MatrikelEjendom | null;
  fejl: string | null;
}

// ─── Raw types fra MAT GraphQL ───────────────────────────────────────────────

interface RawJordstykke {
  id_lokalId?: string;
  matrikelnummer?: string;
  registreretAreal?: number;
  arealtype?: string;
  vejareal?: number;
  faelleslod?: boolean;
  fredskov?: boolean;
  strandbeskyttelse?: boolean;
  klitfredning?: boolean;
  jordrente?: boolean;
  ejerlavLokalId?: string;
}

interface RawSamletFastEjendom {
  BFEnummer?: number;
  status?: string;
  erFaelleslod?: boolean;
  landbrugsnotering?: string;
  hovedejendomOpdeltIEjerlejligh?: boolean;
  arbejderbolig?: boolean;
  udskiltVej?: boolean;
  jordstykkeSamlesISamletFastEjendom?: {
    nodes?: RawJordstykke[];
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAT_GQL_URL = 'https://graphql.datafordeler.dk/MAT/v1';
const DF_API_KEY = process.env.DATAFORDELER_API_KEY ?? '';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returnerer en ISO 8601-timestamp med tidszoneoffset til brug som
 * virkningstid / registreringstid i Datafordeler bitemporale queries.
 *
 * @returns ISO-timestamp streng, f.eks. "2026-03-27T14:30:00+01:00"
 */
function nowISOTimestamp(): string {
  const now = new Date();
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const mm = String(Math.abs(offset) % 60).padStart(2, '0');
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${hh}:${mm}`
  );
}

/**
 * Sender en GraphQL-forespørgsel til Datafordeler MAT/v1 med API-nøgle.
 * Returnerer det rå data-objekt, eller null ved fejl/GraphQL-errors.
 *
 * @param query - GraphQL query streng
 * @returns Parsed JSON data-objekt eller null ved fejl
 */
async function fetchMATGraphQL(query: string): Promise<Record<string, unknown> | null> {
  if (!DF_API_KEY) return null;

  const url = proxyUrl(`${MAT_GQL_URL}?apiKey=${DF_API_KEY}`);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...proxyHeaders() },
      body: JSON.stringify({ query, variables: {} }),
      signal: AbortSignal.timeout(proxyTimeout()),
      next: { revalidate: 86400 },
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(
        `[MAT GQL] HTTP ${res.status} url=${url.replace(/apiKey=[^&]+/, 'apiKey=REDACTED')}`
      );
      console.error(`[MAT GQL] Body: "${txt.slice(0, 600)}"`);
      return null;
    }

    const json = (await res.json()) as {
      data?: Record<string, unknown>;
      errors?: unknown[];
    };

    if (json.errors?.length) {
      console.error('[MAT GQL] GraphQL errors:', JSON.stringify(json.errors).slice(0, 600));
      return null;
    }

    return json.data ?? null;
  } catch (err) {
    console.error('[MAT GQL] Fetch error:', err);
    return null;
  }
}

// ─── GraphQL queries ─────────────────────────────────────────────────────────

/**
 * Bygger den fulde MAT_SamletFastEjendom query med alle jordstykke-felter,
 * inkl. fredskov, strandbeskyttelse, klitfredning og jordrente.
 *
 * @param bfeNummer - BFE-nummer (heltal)
 * @param now - ISO-timestamp for bitemporale parametre
 * @returns GraphQL query streng
 */
function buildFullQuery(bfeNummer: number, now: string): string {
  return `{
    MAT_SamletFastEjendom(
      first: 1
      virkningstid: "${now}"
      registreringstid: "${now}"
      where: { BFEnummer: { eq: ${bfeNummer} } }
    ) {
      nodes {
        BFEnummer
        status
        erFaelleslod
        landbrugsnotering
        hovedejendomOpdeltIEjerlejligh
        arbejderbolig
        udskiltVej
        jordstykkeSamlesISamletFastEjendom(first: 50) {
          nodes {
            id_lokalId
            matrikelnummer
            registreretAreal
            arealtype
            vejareal
            faelleslod
            fredskov
            strandbeskyttelse
            klitfredning
            jordrente
            ejerlavLokalId
          }
        }
      }
    }
  }`;
}

/**
 * Bygger en simpel fallback-query uden fredskov/strandbeskyttelse/klitfredning/jordrente,
 * som bruges hvis den fulde query fejler pga. ukendte felter i skemaet.
 *
 * @param bfeNummer - BFE-nummer (heltal)
 * @param now - ISO-timestamp for bitemporale parametre
 * @returns GraphQL query streng
 */
function buildSimpleQuery(bfeNummer: number, now: string): string {
  return `{
    MAT_SamletFastEjendom(
      first: 1
      virkningstid: "${now}"
      registreringstid: "${now}"
      where: { BFEnummer: { eq: ${bfeNummer} } }
    ) {
      nodes {
        BFEnummer
        status
        erFaelleslod
        landbrugsnotering
        hovedejendomOpdeltIEjerlejligh
        arbejderbolig
        udskiltVej
        jordstykkeSamlesISamletFastEjendom(first: 50) {
          nodes {
            id_lokalId
            matrikelnummer
            registreretAreal
            arealtype
            vejareal
            faelleslod
            ejerlavLokalId
          }
        }
      }
    }
  }`;
}

// ─── Mapping ─────────────────────────────────────────────────────────────────

/**
 * Mapper et råt jordstykke-objekt fra MAT GraphQL til klient-venlig MatrikelJordstykke.
 *
 * @param raw - Rå jordstykke fra GraphQL-svar
 * @returns Normaliseret MatrikelJordstykke
 */
function mapJordstykke(raw: RawJordstykke): MatrikelJordstykke {
  return {
    id: raw.id_lokalId ?? '',
    matrikelnummer: raw.matrikelnummer ?? '',
    registreretAreal: raw.registreretAreal ?? null,
    arealtype: raw.arealtype ?? null,
    vejareal: raw.vejareal ?? null,
    faelleslod: raw.faelleslod ?? false,
    fredskov: raw.fredskov ?? null,
    strandbeskyttelse: raw.strandbeskyttelse ?? null,
    klitfredning: raw.klitfredning ?? null,
    jordrente: raw.jordrente ?? null,
    ejerlavskode: raw.ejerlavLokalId ?? null,
    ejerlavsnavn: null, // Ejerlav-navn kræver separat opslag — ejerlavskode er tilstrækkelig
  };
}

/**
 * Mapper et råt SamletFastEjendom-objekt fra MAT GraphQL til klient-venlig MatrikelEjendom.
 *
 * @param raw - Rå SamletFastEjendom fra GraphQL-svar
 * @returns Normaliseret MatrikelEjendom
 */
function mapEjendom(raw: RawSamletFastEjendom): MatrikelEjendom {
  const rawJordstykker = raw.jordstykkeSamlesISamletFastEjendom?.nodes ?? [];

  return {
    bfeNummer: raw.BFEnummer ?? 0,
    status: raw.status ?? null,
    erFaelleslod: raw.erFaelleslod ?? false,
    landbrugsnotering: raw.landbrugsnotering ?? null,
    opdeltIEjerlejligheder: raw.hovedejendomOpdeltIEjerlejligh ?? false,
    arbejderbolig: raw.arbejderbolig ?? false,
    udskiltVej: raw.udskiltVej ?? false,
    jordstykker: rawJordstykker.map(mapJordstykke),
  };
}

// ─── Route handler ───────────────────────────────────────────────────────────

/**
 * GET /api/matrikel?bfeNummer=XXXX
 *
 * Henter matrikeldata for en Samlet Fast Ejendom fra Datafordeler MAT/v1.
 *
 * @param request - Next.js request med bfeNummer query-param
 * @returns MatrikelResponse med matrikeldata eller fejlbesked
 */
export async function GET(request: NextRequest): Promise<NextResponse<MatrikelResponse>> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as NextResponse<MatrikelResponse>;

  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ matrikel: null, fejl: 'Unauthorized' }, { status: 401 });
  }

  if (!DF_API_KEY) {
    return NextResponse.json(
      { matrikel: null, fejl: 'DATAFORDELER_API_KEY er ikke konfigureret' },
      { status: 200 }
    );
  }

  const { searchParams } = request.nextUrl;
  const bfeNummerStr = searchParams.get('bfeNummer');

  if (!bfeNummerStr || !/^\d+$/.test(bfeNummerStr)) {
    return NextResponse.json(
      { matrikel: null, fejl: 'Ugyldigt eller manglende bfeNummer' },
      { status: 400 }
    );
  }

  const bfeNummer = parseInt(bfeNummerStr, 10);
  const now = nowISOTimestamp();

  try {
    // Trin 1: Prøv fuld query med alle felter
    let data = await fetchMATGraphQL(buildFullQuery(bfeNummer, now));

    // Trin 2: Fald tilbage til simpel query hvis fuld query fejlede
    if (!data) {
      console.warn(
        '[MAT] Fuld query fejlede — prøver simpel query uden fredskov/strandbeskyttelse/klitfredning/jordrente'
      );
      data = await fetchMATGraphQL(buildSimpleQuery(bfeNummer, now));
    }

    if (!data) {
      return NextResponse.json(
        { matrikel: null, fejl: 'Kunne ikke hente matrikeldata fra Datafordeler' },
        { status: 200 }
      );
    }

    // Udtræk SamletFastEjendom nodes
    const sfEjendom = data['MAT_SamletFastEjendom'] as
      | { nodes?: RawSamletFastEjendom[] }
      | undefined;
    const nodes = sfEjendom?.nodes;

    if (!nodes?.length) {
      // Ingen data fundet — ikke en fejl, bare tomt resultat
      return NextResponse.json(
        { matrikel: null, fejl: null },
        {
          status: 200,
          headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
        }
      );
    }

    const matrikel = mapEjendom(nodes[0]);

    return NextResponse.json(
      { matrikel, fejl: null },
      {
        status: 200,
        headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
      }
    );
  } catch (err) {
    console.error('[matrikel] Fejl:', err);
    return NextResponse.json({ matrikel: null, fejl: 'Ekstern API fejl' }, { status: 200 });
  }
}
