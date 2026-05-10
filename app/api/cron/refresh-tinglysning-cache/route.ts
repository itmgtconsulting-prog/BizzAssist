/**
 * GET /api/cron/refresh-tinglysning-cache
 *
 * BIZZ-1162: Daglig refresh af stale tinglysning_cache entries.
 * Finder BFE-numre med stale_after < now() og genhenter fra
 * Tinglysningsrettens HTTP API via tlFetch.
 *
 * Cap: 200 BFE per kørsel, 2 req/sec rate limiting mod Tinglysningsretten.
 *
 * Schedule: 30 4 * * * (dagligt kl. 04:30 UTC)
 *
 * @module api/cron/refresh-tinglysning-cache
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import { tlFetch } from '@/app/lib/tlFetch';

export const maxDuration = 300;

/** Max BFE per cron-kørsel */
const MAX_PER_RUN = 200;

/** Delay mellem Tinglysning API-kald (500ms = 2 req/sec) */
const FETCH_DELAY_MS = 500;

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
 * Hent tinglysningsdata for en enkelt BFE via Tinglysningsrettens API.
 *
 * @param bfe - BFE-nummer
 * @returns Parsed data eller null ved fejl
 */
async function fetchTinglysningForBfe(bfe: number): Promise<Record<string, unknown> | null> {
  try {
    const searchRes = await tlFetch(`/ejendom/hovednoteringsnummer?hovednoteringsnummer=${bfe}`);
    if (searchRes.status !== 200) return null;

    const searchData = JSON.parse(searchRes.body);
    const items = searchData?.items ?? [];
    if (items.length === 0) return null;

    const item = items[0] as Record<string, unknown>;
    const uuid = String(item.uuid ?? '');

    // Hent summariske oplysninger
    const detailRes = await tlFetch(`/ejdsummarisk/${uuid}`);
    const extraData: Record<string, unknown> = {};
    if (detailRes.status === 200) {
      // Parse minimal fields — vi gemmer rå data
      try {
        // Returnér item + detail data som unified object
        return { ...item, uuid, ejdsummarisk: detailRes.body };
      } catch {
        return { ...item, uuid };
      }
    }

    return { ...item, uuid, ...extraData };
  } catch (err) {
    logger.warn(`[refresh-tinglysning-cache] Fejl for BFE ${bfe}:`, err);
    return null;
  }
}

/**
 * Cron handler: refresh stale tinglysning cache entries.
 *
 * @param request - Incoming request with CRON_SECRET auth
 * @returns JSON summary
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor(
    { jobName: 'refresh-tinglysning-cache', schedule: '30 4 * * *', intervalMinutes: 1440 },
    async () => {
      const admin = createAdminClient();
      const startTime = Date.now();

      // Find stale BFEs
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: staleBfes, error: staleErr } = await (admin as any)
        .from('tinglysning_cache')
        .select('bfe_nummer')
        .lt('stale_after', new Date().toISOString())
        .order('stale_after', { ascending: true })
        .limit(MAX_PER_RUN);

      if (staleErr) {
        logger.error('[refresh-tinglysning-cache] Query fejl:', staleErr.message);
        return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 200 });
      }

      const bfes = (staleBfes ?? []).map((r: { bfe_nummer: number }) => r.bfe_nummer);
      logger.log(`[refresh-tinglysning-cache] ${bfes.length} stale BFEs`);

      let refreshed = 0;
      let errors = 0;

      for (const bfe of bfes) {
        // Time budget check — stop 30s before maxDuration
        if (Date.now() - startTime > maxDuration * 1000 - 30_000) {
          logger.log(`[refresh-tinglysning-cache] Time budget efter ${refreshed} BFEs`);
          break;
        }

        try {
          const data = await fetchTinglysningForBfe(bfe);
          if (data) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (admin as any).from('tinglysning_cache').upsert(
              {
                bfe_nummer: bfe,
                data,
                fetched_at: new Date().toISOString(),
                stale_after: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
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

        // Rate limiting: 2 req/sec
        await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
      }

      const summary = {
        refreshed,
        errors,
        total: bfes.length,
        durationMs: Date.now() - startTime,
      };
      logger.log('[refresh-tinglysning-cache] Done:', summary);
      return NextResponse.json(summary);
    }
  );
}
