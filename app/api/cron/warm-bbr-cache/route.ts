/**
 * Cron: warm-bbr-cache — proaktivt BBR-cache for populære ejendomme.
 *
 * BIZZ-1016: Henter BBR-data for top-N mest besøgte ejendomme og gemmer
 * i cache_bbr (JSONB). Supplerer write-on-read fra BIZZ-1015.
 *
 * Flow:
 *   1. Hent top 200 BFE-numre fra bbr_ejendom_status (allerede cached)
 *   2. For hver: tjek om cache_bbr har frisk data (< 7 dage)
 *   3. Hvis stale/manglende: hent DAWA adresse-id → fetchBbrForAddress → gem
 *   4. Max 500 fetch per kørsel (Datafordeler rate limit)
 *
 * Schedule: dagligt kl. 04:30 UTC (efter pull-bbr-events)
 *
 * @module api/cron/warm-bbr-cache
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import { fetchBbrForAddress } from '@/app/lib/fetchBbrData';
import { fetchDawa } from '@/app/lib/dawa';
import { DAWA_BASE_URL } from '@/app/lib/serviceEndpoints';
import crypto from 'crypto';

/** Max ejendomme at cache per kørsel */
const MAX_PER_RUN = 200;

/** Cache staleness (7 dage) */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** Pause mellem fetch-kald (ms) for at respektere rate limits */
const THROTTLE_MS = 500;

/**
 * Verificer CRON_SECRET + x-vercel-cron header.
 *
 * @param request - Indkommende request
 * @returns true hvis autentificeret
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
 * Hent BFE-numre der skal caches — fra bbr_ejendom_status (allerede populeret).
 * Prioriterer ejendomme der ikke allerede har frisk cache.
 *
 * @returns Array af BFE-numre at cache
 */
async function fetchBfeToWarm(): Promise<number[]> {
  const admin = createAdminClient();

  // Hent BFE-numre fra bbr_ejendom_status der mangler eller har stale cache_bbr
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any).rpc('get_stale_bbr_cache_bfe', {
    p_cutoff: cutoff,
    p_limit: MAX_PER_RUN,
  });

  if (error) {
    // Fallback: hent bare fra bbr_ejendom_status (random udsnit)
    logger.warn('[warm-bbr-cache] RPC ikke tilgængelig, falder til direkte query:', error.message);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: fallback } = await (admin as any)
      .from('bbr_ejendom_status')
      .select('bfe_nummer')
      .limit(MAX_PER_RUN);

    return (fallback ?? []).map((r: { bfe_nummer: number }) => r.bfe_nummer);
  }

  return (data ?? []).map((r: { bfe_nummer: number }) => r.bfe_nummer);
}

/**
 * Resolve BFE → DAWA adgangsadresse-id (nødvendigt for fetchBbrForAddress).
 *
 * @param bfe - BFE-nummer
 * @returns DAWA adgangsadresse UUID eller null
 */
async function resolveDawaId(bfe: number): Promise<string | null> {
  try {
    const res = await fetchDawa(
      `${DAWA_BASE_URL}/bfe/${bfe}`,
      { signal: AbortSignal.timeout(8000), next: { revalidate: 86400 } },
      { caller: 'warm-bbr-cache.bfe-resolve' }
    );
    if (!res.ok) return null;

    const json = (await res.json()) as {
      beliggenhedsadresse?: { id?: string };
      jordstykker?: Array<{ husnumre?: Array<{ id?: string }> }>;
    };

    return json.beliggenhedsadresse?.id ?? json.jordstykker?.[0]?.husnumre?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * GET handler — kører som Vercel cron job.
 *
 * @param request - Indkommende Next.js request (auth header)
 * @returns JSON med { warmed, skipped, errors, total }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor(
    { jobName: 'warm-bbr-cache', schedule: '30 4 * * *', intervalMinutes: 1440 },
    async () => {
      const admin = createAdminClient();
      const bfeList = await fetchBfeToWarm();

      if (bfeList.length === 0) {
        return NextResponse.json({
          warmed: 0,
          skipped: 0,
          errors: 0,
          message: 'Ingen BFE at cache',
        });
      }

      let warmed = 0;
      let skipped = 0;
      let errors = 0;

      for (const bfe of bfeList) {
        try {
          // Tjek om cache allerede er frisk
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: existing } = await (admin as any)
            .from('cache_bbr')
            .select('synced_at')
            .eq('bfe_nummer', bfe)
            .single();

          if (existing?.synced_at) {
            const age = Date.now() - new Date(existing.synced_at).getTime();
            if (age < STALE_MS) {
              skipped++;
              continue;
            }
          }

          // Resolve DAWA id
          const dawaId = await resolveDawaId(bfe);
          if (!dawaId) {
            errors++;
            continue;
          }

          // Hent BBR data
          const result = await fetchBbrForAddress(dawaId);
          if (!result) {
            errors++;
            continue;
          }

          // Gem i cache_bbr
          const rawJson = JSON.stringify(result);
          const hash = crypto.createHash('sha256').update(rawJson).digest('hex');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (admin as any).from('cache_bbr').upsert(
            {
              bfe_nummer: bfe,
              raw_data: result,
              source_hash: hash,
              synced_at: new Date().toISOString(),
            },
            { onConflict: 'bfe_nummer' }
          );

          warmed++;

          // Throttle
          if (warmed % 10 === 0) {
            await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS));
          }
        } catch (err) {
          logger.warn(
            `[warm-bbr-cache] BFE ${bfe} fejl:`,
            err instanceof Error ? err.message : err
          );
          errors++;
        }
      }

      logger.log(`[warm-bbr-cache] Færdig: warmed=${warmed}, skipped=${skipped}, errors=${errors}`);

      return NextResponse.json({
        warmed,
        skipped,
        errors,
        total: bfeList.length,
      });
    }
  );
}
