/**
 * Cron: Knowledge Cache Refresh — /api/cron/refresh-knowledge-cache
 *
 * BIZZ-1419 / BIZZ-2208: Natlig opdatering af dataintel.analytics_knowledge.
 * Bygger IKKE længere alle topics synkront (det timeoutede monolitisk >300s →
 * 504). I stedet enqueues ét job pr. topic i den durable job-kø; workeren
 * (process-job-queue) bygger dem ét ad gangen, hvert langt under 300s.
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
import { TOPIC_NAMES } from '@/app/lib/dataIntelligence/buildKnowledge';
import { enqueue } from '@/app/lib/jobQueue';
import { withCronMonitor } from '@/app/lib/cronMonitor';

export const runtime = 'nodejs';
export const maxDuration = 60;

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

  // BIZZ-2208: enqueue ét job pr. topic; workeren bygger dem asynkront.
  return withCronMonitor('refresh-knowledge-cache', async () => {
    let enqueued = 0;
    let skipped = 0;
    for (const topic of TOPIC_NAMES) {
      // dedupe_key sikrer at et endnu-ikke-kørt topic-job fra i går ikke
      // dubleres; når det er done kan topic'et enqueues igen.
      const added = await enqueue('knowledge-topic', {
        topic,
        dedupe_key: `knowledge-topic:${topic}`,
      });
      if (added) enqueued++;
      else skipped++;
    }

    logger.log(`[cron/refresh-knowledge-cache] enqueued=${enqueued} skipped=${skipped}`);

    return {
      response: NextResponse.json({ ok: true, enqueued, skipped, topics: TOPIC_NAMES.length }),
      metrics: { itemsProcessed: TOPIC_NAMES.length, itemsWritten: enqueued },
    };
  });
}
