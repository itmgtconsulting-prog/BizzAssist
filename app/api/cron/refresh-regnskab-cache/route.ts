/**
 * GET /api/cron/refresh-regnskab-cache
 *
 * BIZZ-1193: Daglig inkrementel refresh af regnskab_cache.
 * Finder CVR-numre med fetched_at ældre end 6 måneder og genhenter
 * via intern /api/regnskab/xbrl endpoint (som opdaterer cache automatisk).
 *
 * Cap: 200 CVR per kørsel, 2 req/sec rate limiting.
 *
 * Schedule: 0 5 * * * (dagligt kl. 05:00 UTC)
 *
 * @module api/cron/refresh-regnskab-cache
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';

export const maxDuration = 300;

/** Max CVR per cron-kørsel */
const MAX_PER_RUN = 200;

/** Delay mellem intern API-kald (500ms = 2 req/sec) */
const FETCH_DELAY_MS = 500;

/** Stale threshold — genhent regnskaber ældre end 180 dage */
const STALE_DAYS = 180;

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
 * Cron handler: refresh stale regnskab_cache entries.
 *
 * @param request - Incoming request with CRON_SECRET auth
 * @returns JSON summary
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor(
    { jobName: 'refresh-regnskab-cache', schedule: '0 5 * * *', intervalMinutes: 1440 },
    async () => {
      const admin = createAdminClient();
      const startTime = Date.now();
      const staleCutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

      // Find stale CVR'er
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: staleCvrs, error: staleErr } = await (admin as any)
        .from('regnskab_cache')
        .select('cvr')
        .lt('fetched_at', staleCutoff)
        .order('fetched_at', { ascending: true })
        .limit(MAX_PER_RUN);

      if (staleErr) {
        logger.error('[refresh-regnskab-cache] Query fejl:', staleErr.message);
        return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 200 });
      }

      const cvrs = (staleCvrs ?? []).map((r: { cvr: string }) => r.cvr);
      logger.log(`[refresh-regnskab-cache] ${cvrs.length} stale CVR'er`);

      let refreshed = 0;
      let errors = 0;

      // Intern fetch mod /api/regnskab/xbrl — den opdaterer automatisk cache
      const host = request.headers.get('host') ?? 'localhost:3000';
      const base = host.startsWith('localhost') ? `http://${host}` : `https://${host}`;
      const cookie = request.headers.get('cookie') ?? '';

      for (const cvr of cvrs) {
        // Time budget check
        if (Date.now() - startTime > maxDuration * 1000 - 30_000) {
          logger.log(`[refresh-regnskab-cache] Time budget efter ${refreshed} CVR`);
          break;
        }

        try {
          const res = await fetch(`${base}/api/regnskab/xbrl?cvr=${cvr}`, {
            headers: { cookie },
            signal: AbortSignal.timeout(15000),
          });
          if (res.ok) {
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
        total: cvrs.length,
        durationMs: Date.now() - startTime,
      };
      logger.log('[refresh-regnskab-cache] Done:', summary);
      return NextResponse.json(summary);
    }
  );
}
