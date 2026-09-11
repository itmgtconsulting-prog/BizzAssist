/**
 * GET /api/cron/process-job-queue
 *
 * BIZZ-2209: Durable-queue worker. Every 5 min it reclaims stale jobs, then
 * claims and runs batches of queued work (FOR UPDATE SKIP LOCKED) within a
 * ~250s time budget — so heavy work that would blow the 300s function limit
 * (e.g. knowledge-cache) drains across several invocations instead of timing
 * out. Reports work metrics via withCronMonitor (degraded if nothing ran but
 * jobs were pending is NOT flagged here — an empty queue is normal).
 *
 * Auth: CRON_SECRET bearer + x-vercel-cron in prod.
 * Retention: job_queue rows are terminal once done/error; no PII stored.
 *
 * @module api/cron/process-job-queue
 */

import { NextRequest, NextResponse } from 'next/server';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import { drainJobQueue } from '@/app/lib/jobDrain';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Stop claiming new work once we're this close to the function limit. */
const TIME_BUDGET_MS = 250_000;

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
 * GET handler — drains the job queue within the time budget.
 *
 * @param request - Incoming request with CRON_SECRET auth
 * @returns JSON summary { ok, processed, failed, reclaimed }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor('process-job-queue', async () => {
    // BIZZ-2221: drain-logikken deles nu med watchdog (piggyback) via jobDrain.
    const { processed, failed, reclaimed } = await drainJobQueue(TIME_BUDGET_MS);

    logger.log(
      `[process-job-queue] reclaimed=${reclaimed} processed=${processed} failed=${failed}`
    );

    return {
      response: NextResponse.json({ ok: true, processed, failed, reclaimed }),
      metrics: { itemsProcessed: processed + failed, itemsWritten: processed },
      // A batch where every job failed is a degraded run worth surfacing.
      degraded: processed === 0 && failed > 0 ? `${failed} jobs fejlede` : undefined,
    };
  });
}
