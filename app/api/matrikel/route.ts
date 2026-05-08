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
import { z } from 'zod';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';
import { logger } from '@/app/lib/logger';
import { createAdminClient } from '@/lib/supabase/admin';

/** Zod schema for /api/matrikel query parameters */
const matrikelQuerySchema = z.object({
  bfeNummer: z.string().regex(/^\d+$/),
});

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
  ejerlavLokalId?: string;
}

interface RawEjerlav {
  id_lokalId?: string;
  ejerlavsnavn?: string;
  ejerlavskode?: number;
}

interface RawSamletFastEjendom {
  BFEnummer?: number;
  status?: string;
  erFaelleslod?: boolean;
  landbrugsnotering?: string;
  hovedejendomOpdeltIEjerlejligh?: boolean;
  arbejderbolig?: boolean;
  udskiltVej?: boolean;
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
      logger.error(
        `[MAT GQL] HTTP ${res.status} url=${url.replace(/apiKey=[^&]+/, 'apiKey=REDACTED')}`
      );
      logger.error(`[MAT GQL] Body: "${txt.slice(0, 600)}"`);
      return null;
    }

    const json = (await res.json()) as {
      data?: Record<string, unknown>;
      errors?: unknown[];
    };

    if (json.errors?.length) {
      logger.error('[MAT GQL] GraphQL errors:', JSON.stringify(json.errors).slice(0, 600));
      return null;
    }

    return json.data ?? null;
  } catch (err) {
    logger.error('[MAT GQL] Fetch error:', err);
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
/**
 * 2026-04-19 MAT schema update: jordstykkeSamlesISamletFastEjendom sub-query
 * removed from MAT_SamletFastEjendom. Fredskov/strandbeskyttelse/klitfredning/
 * jordrente fields also removed from MAT_Jordstykke. Now we query jordstykker
 * separately using samletFastEjendomLokalId filter (string!).
 */
function buildEjendomQuery(bfeNummer: number, now: string): string {
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
      }
    }
  }`;
}

/**
 * Separate query for jordstykker belonging to a SamletFastEjendom.
 * Uses samletFastEjendomLokalId filter (string) since the sub-query was removed.
 */
function buildJordstykkeQuery(bfeNummer: number, now: string): string {
  return `{
    MAT_Jordstykke(
      first: 50
      virkningstid: "${now}"
      registreringstid: "${now}"
      where: { samletFastEjendomLokalId: { eq: "${bfeNummer}" } }
    ) {
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
  }`;
}

/**
 * BIZZ-497: Fetch ejerlav names for a set of ejerlav lokalIds.
 */
function buildEjerlavQuery(lokalIds: string[], now: string): string {
  const quoted = lokalIds.map((id) => `"${id}"`).join(',');
  return `{
    MAT_Ejerlav(
      first: 50
      virkningstid: "${now}"
      registreringstid: "${now}"
      where: { id_lokalId: { in: [${quoted}] } }
    ) {
      nodes { id_lokalId ejerlavsnavn ejerlavskode }
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
function mapJordstykke(
  raw: RawJordstykke,
  ejerlavMap?: Map<string, RawEjerlav>
): MatrikelJordstykke {
  const ejerlav = raw.ejerlavLokalId ? ejerlavMap?.get(raw.ejerlavLokalId) : undefined;
  return {
    id: raw.id_lokalId ?? '',
    matrikelnummer: raw.matrikelnummer ?? '',
    registreretAreal: raw.registreretAreal ?? null,
    arealtype: raw.arealtype ?? null,
    vejareal: raw.vejareal ?? null,
    faelleslod: raw.faelleslod ?? false,
    // 2026-04-19: fredskov/strandbeskyttelse/klitfredning/jordrente fields
    // were removed from MAT_Jordstykke schema — keep null until replacement found
    fredskov: null,
    strandbeskyttelse: null,
    klitfredning: null,
    jordrente: null,
    ejerlavskode: raw.ejerlavLokalId ?? null,
    // BIZZ-497: Ejerlav-navn via separat MAT_Ejerlav lookup
    ejerlavsnavn: ejerlav?.ejerlavsnavn ?? null,
  };
}

/**
 * Mapper et råt SamletFastEjendom-objekt fra MAT GraphQL til klient-venlig MatrikelEjendom.
 *
 * @param raw - Rå SamletFastEjendom fra GraphQL-svar
 * @returns Normaliseret MatrikelEjendom
 */
function mapEjendom(
  raw: RawSamletFastEjendom,
  rawJordstykker: RawJordstykke[],
  ejerlavMap?: Map<string, RawEjerlav>
): MatrikelEjendom {
  return {
    bfeNummer: raw.BFEnummer ?? 0,
    status: raw.status ?? null,
    erFaelleslod: raw.erFaelleslod ?? false,
    landbrugsnotering: raw.landbrugsnotering ?? null,
    opdeltIEjerlejligheder: raw.hovedejendomOpdeltIEjerlejligh ?? false,
    arbejderbolig: raw.arbejderbolig ?? false,
    udskiltVej: raw.udskiltVej ?? false,
    jordstykker: rawJordstykker.map((j) => mapJordstykke(j, ejerlavMap)),
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

  // Validate query params with Zod schema
  const parsed = parseQuery(request, matrikelQuerySchema);
  if (!parsed.success) return parsed.response as NextResponse<MatrikelResponse>;

  const bfeNummer = parseInt(parsed.data.bfeNummer, 10);

  // BIZZ-1162: Cache-first lookup
  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: cached } = await (admin as any)
      .from('matrikel_cache')
      .select('ejendom, jordstykker, stale_after')
      .eq('bfe_nummer', bfeNummer)
      .maybeSingle();
    if (cached?.ejendom && cached.stale_after && new Date(cached.stale_after) > new Date()) {
      const matrikel: MatrikelEjendom = {
        ...cached.ejendom,
        jordstykker: cached.jordstykker ?? [],
      };
      return NextResponse.json(
        { matrikel, fejl: null },
        {
          status: 200,
          headers: {
            'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600',
            'X-Cache': 'HIT',
          },
        }
      );
    }
  } catch {
    // Cache-fejl må ALDRIG blokere live response
  }

  const now = nowISOTimestamp();

  try {
    // 2026-04-19 schema update: MAT_SamletFastEjendom no longer has
    // jordstykkeSamlesISamletFastEjendom sub-query. Run 2 queries in parallel:
    //   1. SamletFastEjendom metadata (status, erFaelleslod, etc.)
    //   2. MAT_Jordstykke filtered by samletFastEjendomLokalId (string!)
    const [ejendomData, jordstykkeData] = await Promise.all([
      fetchMATGraphQL(buildEjendomQuery(bfeNummer, now)),
      fetchMATGraphQL(buildJordstykkeQuery(bfeNummer, now)),
    ]);

    if (!ejendomData) {
      return NextResponse.json(
        { matrikel: null, fejl: 'Kunne ikke hente matrikeldata fra Datafordeler' },
        { status: 200 }
      );
    }

    const sfEjendom = ejendomData['MAT_SamletFastEjendom'] as
      | { nodes?: RawSamletFastEjendom[] }
      | undefined;
    const ejendomNodes = sfEjendom?.nodes;

    if (!ejendomNodes?.length) {
      return NextResponse.json(
        { matrikel: null, fejl: null },
        {
          status: 200,
          headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
        }
      );
    }

    const rawJordstykker =
      (jordstykkeData?.['MAT_Jordstykke'] as { nodes?: RawJordstykke[] } | undefined)?.nodes ?? [];

    // BIZZ-497: Hent ejerlav-navne for alle unikke ejerlavLokalId
    let ejerlavMap: Map<string, RawEjerlav> | undefined;
    const unikkeEjerlavIds = [
      ...new Set(rawJordstykker.map((j) => j.ejerlavLokalId).filter((id): id is string => !!id)),
    ];
    if (unikkeEjerlavIds.length > 0) {
      const ejerlavData = await fetchMATGraphQL(buildEjerlavQuery(unikkeEjerlavIds, now));
      const ejerlavNodes =
        (ejerlavData?.['MAT_Ejerlav'] as { nodes?: RawEjerlav[] } | undefined)?.nodes ?? [];
      ejerlavMap = new Map(ejerlavNodes.filter((n) => n.id_lokalId).map((n) => [n.id_lokalId!, n]));
    }

    const matrikel = mapEjendom(ejendomNodes[0], rawJordstykker, ejerlavMap);

    // BIZZ-1162: Skriv til cache (fire-and-forget)
    try {
      const admin = createAdminClient();
      const { jordstykker, ...ejendomData } = matrikel;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).from('matrikel_cache').upsert(
        {
          bfe_nummer: bfeNummer,
          ejendom: ejendomData,
          jordstykker,
          fetched_at: new Date().toISOString(),
          stale_after: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        },
        { onConflict: 'bfe_nummer' }
      );
    } catch {
      // Cache-write fejl logges men blokerer ikke
    }

    return NextResponse.json(
      { matrikel, fejl: null },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600',
          'X-Cache': 'MISS',
        },
      }
    );
  } catch (err) {
    logger.error('[matrikel] Fejl:', err);
    return NextResponse.json({ matrikel: null, fejl: 'Ekstern API fejl' }, { status: 200 });
  }
}
