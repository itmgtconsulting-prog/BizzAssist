/**
 * GET /api/cron/refresh-matrikel-cache
 *
 * BIZZ-1162: Ugentlig refresh af stale matrikel_cache entries.
 * Henter matrikeldata fra Datafordeler MAT GraphQL for BFEs
 * hvor stale_after < now().
 *
 * Cap: 500 BFE per kørsel. Matrikeldata er "frie data" (zone 0)
 * og kræver kun API-key — ingen rate-limiting nødvendig.
 *
 * Schedule: 0 5 * * 0 (søndag kl. 05:00 UTC)
 *
 * @module api/cron/refresh-matrikel-cache
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';

export const maxDuration = 300;

/** Max BFE per cron-kørsel */
const MAX_PER_RUN = 500;

/** Delay mellem Datafordeler kald */
const FETCH_DELAY_MS = 200;

/** Datafordeler MAT GraphQL endpoint */
const MAT_GQL_URL = 'https://graphql.datafordeler.dk/MAT/v1';

/**
 * Verify CRON_SECRET bearer + x-vercel-cron in production.
 *
 * @param request - Incoming request
 * @returns true if authorised
 */
function verifyCronSecret(request: NextRequest): boolean {
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return safeCompare(auth, `Bearer ${secret}`);
}

/**
 * Hent matrikeldata for en BFE fra Datafordeler MAT GraphQL.
 *
 * @param bfe - BFE-nummer
 * @param apiKey - Datafordeler API-key
 * @returns { ejendom, jordstykker } eller null ved fejl
 */
async function fetchMatrikelForBfe(
  bfe: number,
  apiKey: string
): Promise<{ ejendom: Record<string, unknown>; jordstykker: Record<string, unknown>[] } | null> {
  try {
    const now = new Date().toISOString();

    // Query SamletFastEjendom
    const ejendomQuery = `{
      MAT_SamletFastEjendom(BFEnummer: "${bfe}", status: "Gældende",
        virkningFra: "${now}", virkningTil: "${now}",
        registreringFra: "${now}", registreringTil: "${now}") {
        nodes {
          BFEnummer status erFaelleslod landbrugsnotering
          hovedejendomOpdeltIEjerlejligh arbejderbolig udskiltVej
        }
      }
    }`;

    const url = proxyUrl(MAT_GQL_URL);
    const headers = {
      ...proxyHeaders(),
      'Content-Type': 'application/json',
    };

    const ejendomRes = await fetch(`${url}?username=${apiKey}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: ejendomQuery }),
      signal: AbortSignal.timeout(proxyTimeout()),
    });

    if (!ejendomRes.ok) return null;
    const ejendomData = await ejendomRes.json();
    const ejendomNodes = ejendomData?.data?.MAT_SamletFastEjendom?.nodes;
    if (!ejendomNodes?.length) return null;

    // Query Jordstykker
    const jordstykkeQuery = `{
      MAT_Jordstykke(samletFastEjendomLokalId: "${bfe}", status: "Gældende",
        virkningFra: "${now}", virkningTil: "${now}",
        registreringFra: "${now}", registreringTil: "${now}") {
        nodes {
          id_lokalId matrikelnummer registreretAreal arealtype
          vejareal faelleslod ejerlavLokalId
        }
      }
    }`;

    const jordRes = await fetch(`${url}?username=${apiKey}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: jordstykkeQuery }),
      signal: AbortSignal.timeout(proxyTimeout()),
    });

    const jordData = jordRes.ok ? await jordRes.json() : null;
    const jordstykker = jordData?.data?.MAT_Jordstykke?.nodes ?? [];

    return { ejendom: ejendomNodes[0], jordstykker };
  } catch (err) {
    logger.warn(`[refresh-matrikel-cache] Fejl for BFE ${bfe}:`, err);
    return null;
  }
}

/**
 * Cron handler: refresh stale matrikel cache entries.
 *
 * @param request - Incoming request with CRON_SECRET auth
 * @returns JSON summary
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const apiKey = process.env.DATAFORDELER_API_KEY;
  if (!apiKey) {
    logger.warn('[refresh-matrikel-cache] DATAFORDELER_API_KEY not set — skipping');
    return NextResponse.json({ error: 'Credentials missing' }, { status: 200 });
  }

  return withCronMonitor(
    { jobName: 'refresh-matrikel-cache', schedule: '0 5 * * 0', intervalMinutes: 10080 },
    async () => {
      const admin = createAdminClient();
      const startTime = Date.now();

      // Find stale BFEs
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: staleBfes, error: staleErr } = await (admin as any)
        .from('matrikel_cache')
        .select('bfe_nummer')
        .lt('stale_after', new Date().toISOString())
        .order('stale_after', { ascending: true })
        .limit(MAX_PER_RUN);

      if (staleErr) {
        logger.error('[refresh-matrikel-cache] Query fejl:', staleErr.message);
        return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 200 });
      }

      const bfes = (staleBfes ?? []).map((r: { bfe_nummer: number }) => r.bfe_nummer);
      logger.log(`[refresh-matrikel-cache] ${bfes.length} stale BFEs`);

      let refreshed = 0;
      let errors = 0;

      for (const bfe of bfes) {
        // Time budget check
        if (Date.now() - startTime > maxDuration * 1000 - 30_000) {
          logger.log(`[refresh-matrikel-cache] Time budget efter ${refreshed} BFEs`);
          break;
        }

        try {
          const data = await fetchMatrikelForBfe(bfe, apiKey);
          if (data) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (admin as any).from('matrikel_cache').upsert(
              {
                bfe_nummer: bfe,
                ejendom: data.ejendom,
                jordstykker: data.jordstykker,
                fetched_at: new Date().toISOString(),
                stale_after: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
              },
              { onConflict: 'bfe_nummer' }
            );
            refreshed++;
          } else {
            errors++;
          }
        } catch {
          errors++;
        }

        await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
      }

      const summary = {
        refreshed,
        errors,
        total: bfes.length,
        durationMs: Date.now() - startTime,
      };
      logger.log('[refresh-matrikel-cache] Done:', summary);
      return NextResponse.json(summary);
    }
  );
}
