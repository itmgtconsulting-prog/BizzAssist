/**
 * GET /api/cron/purge-cron-history
 *
 * BIZZ-2209: Prunes public.cron_run_history rows older than 90 days so the
 * observability time-series stays bounded. Runs daily.
 *
 * Auth: CRON_SECRET bearer + x-vercel-cron in prod.
 * Retention: 90 days of per-run cron history (no PII — only job names + metrics).
 *
 * @module api/cron/purge-cron-history
 */

import { NextRequest, NextResponse } from 'next/server';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import { createDefaultSqlRunner } from '@/app/lib/dataIntelligence/buildCatalog';

export const runtime = 'nodejs';
export const maxDuration = 60;

const RETENTION_DAYS = 90;

/**
 * Verify CRON_SECRET bearer + (in prod) Vercel cron header.
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
 * GET handler — deletes cron_run_history rows older than the retention window.
 *
 * @param request - Incoming request with CRON_SECRET auth
 * @returns JSON summary { ok, deleted }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor('purge-cron-history', async () => {
    const rpc = createDefaultSqlRunner();
    const rows = await rpc(
      `DELETE FROM public.cron_run_history
       WHERE run_at < now() - interval '${RETENTION_DAYS} days'
       RETURNING id;`
    );
    const deleted = rows.length;
    logger.log(`[purge-cron-history] slettede ${deleted} rækker > ${RETENTION_DAYS}d`);
    return {
      response: NextResponse.json({ ok: true, deleted }),
      metrics: { itemsProcessed: deleted, itemsWritten: deleted },
    };
  });
}
