/**
 * Durable job-queue drain + knowledge-enqueue helpers (BIZZ-2221).
 *
 * Vercel's scheduler kører kun ~38 af projektets crons; de 2 nyeste
 * (process-job-queue + refresh-knowledge-cache) blev aldrig fyret automatisk,
 * selvom endpointsene virker. I stedet for at afhænge af Vercel-scheduling
 * "piggybacker" vi kø-driften på watchdog-cronen (fyrer pålideligt hver 30. min):
 * watchdog kalder drainJobQueue() hver kørsel + enqueueKnowledgeTopicsIfDue()
 * én gang dagligt. Route-filerne bevares (manuel trigger + genbrug af samme
 * funktioner).
 *
 * @module app/lib/jobDrain
 */
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import { claimBatch, completeJob, failJob, reclaimStale, enqueue } from '@/app/lib/jobQueue';
import { runJob } from '@/app/lib/jobHandlers';
import { TOPIC_NAMES } from '@/app/lib/dataIntelligence/buildKnowledge';

/** Jobs claimed per DB round-trip. */
const BATCH_SIZE = 4;

/** Result of a drain pass. */
export interface DrainResult {
  processed: number;
  failed: number;
  reclaimed: number;
}

/**
 * Reclaims stale jobs, then claims + runs queued work until the queue is empty
 * or the time budget expires. Same logik som process-job-queue-routen — nu
 * genbrugelig så watchdog kan drive køen uden en separat Vercel-cron.
 *
 * @param budgetMs - Tidsbudget i millisekunder (stopper med at claime nyt arbejde derefter)
 * @returns Antal processed/failed/reclaimed
 */
export async function drainJobQueue(budgetMs: number): Promise<DrainResult> {
  const workerId = `worker-${Date.now()}`;
  const deadline = Date.now() + budgetMs;
  let processed = 0;
  let failed = 0;

  const reclaimed = await reclaimStale().catch((e) => {
    logger.error('[jobDrain] reclaimStale fejl:', e);
    return 0;
  });

  while (Date.now() < deadline) {
    const jobs = await claimBatch(workerId, BATCH_SIZE);
    if (jobs.length === 0) break; // queue empty
    for (const job of jobs) {
      try {
        const result = await runJob(job);
        await completeJob(job.id, result);
        processed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[jobDrain] job ${job.id} (${job.job_type}) fejlede:`, msg);
        await failJob(job, msg);
        failed++;
      }
    }
  }

  logger.log(`[jobDrain] reclaimed=${reclaimed} processed=${processed} failed=${failed}`);
  return { processed, failed, reclaimed };
}

/** Result of a knowledge-enqueue attempt. */
export interface KnowledgeEnqueueResult {
  due: boolean;
  enqueued: number;
  skipped: number;
}

/**
 * Enqueuer ét job pr. knowledge-topic — men KUN hvis der ikke allerede er
 * enqueued knowledge-topics inden for `minHours` (så watchdogs 30-min-cadence
 * ikke genopbygger cachen konstant; knowledge er dagligt). dedupe_key i enqueue
 * forhindrer stadig dubletter af et endnu-ikke-kørt topic.
 *
 * @param minHours - Minimum timer mellem enqueue-runder (default 20 ≈ dagligt)
 * @returns { due, enqueued, skipped }
 */
export async function enqueueKnowledgeTopicsIfDue(minHours = 20): Promise<KnowledgeEnqueueResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  const cutoff = new Date(Date.now() - minHours * 60 * 60 * 1000).toISOString();
  const { data: recent } = await admin
    .from('job_queue')
    .select('id')
    .eq('job_type', 'knowledge-topic')
    .gte('created_at', cutoff)
    .limit(1);

  if (recent && recent.length > 0) {
    return { due: false, enqueued: 0, skipped: 0 };
  }

  let enqueued = 0;
  let skipped = 0;
  for (const topic of TOPIC_NAMES) {
    const added = await enqueue('knowledge-topic', {
      topic,
      dedupe_key: `knowledge-topic:${topic}`,
    });
    if (added) enqueued++;
    else skipped++;
  }
  logger.log(`[jobDrain] knowledge enqueue: ${enqueued} enqueued, ${skipped} skipped`);
  return { due: true, enqueued, skipped };
}
