/**
 * Cron: Knowledge Cache Refresh — /api/cron/refresh-knowledge-cache
 *
 * BIZZ-1419: Natlig opdatering af dataintel.analytics_knowledge. Kører alle
 * topic-builders i topics.ts (BIZZ-1413..1418). Fejl i én topic stopper ikke
 * andre.
 *
 * Schedule: 30 3 * * * UTC (dagligt 03:30 — efter catalog 03:00).
 *
 * Manuel trigger: GET med Authorization: Bearer $CRON_SECRET
 *
 * @module api/cron/refresh-knowledge-cache
 */

import { NextRequest, NextResponse } from 'next/server';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { buildAndUpsertKnowledge } from '@/app/lib/dataIntelligence/buildKnowledge';
import { withCronMonitor } from '@/app/lib/cronMonitor';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Verificér CRON_SECRET + (i prod) Vercel cron-header. */
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
 * GET handler — kører knowledge refresh og returnerer per-topic summary.
 *
 * @returns 200 + JSON summary | 401 hvis auth fejler
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // BIZZ-1971: heartbeat + Sentry cron-monitoring
  return withCronMonitor(
    { jobName: 'refresh-knowledge-cache', schedule: '30 3 * * *', intervalMinutes: 1440 },
    async () => {
      const start = Date.now();
      try {
        const { results } = await buildAndUpsertKnowledge();
        const totalRows = results.reduce((sum, r) => sum + r.rows, 0);
        const failed = results.filter((r) => r.error).length;
        const durationMs = Date.now() - start;

        logger.log('[cron/refresh-knowledge-cache]', {
          topics: results.length,
          totalRows,
          failed,
          durationMs,
        });

        return NextResponse.json({
          ok: failed === 0,
          topics: results.length,
          totalRows,
          failed,
          durationMs,
          results,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Ukendt fejl';
        logger.error('[cron/refresh-knowledge-cache] fatal:', msg);
        return NextResponse.json(
          { ok: false, error: 'Ekstern API fejl', durationMs: Date.now() - start },
          { status: 500 }
        );
      }
    }
  );
}
