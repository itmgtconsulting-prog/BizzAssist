/**
 * Durable job queue (BIZZ-2209) — lets work that can't finish inside Vercel's
 * 300s function limit run as bounded, resumable units instead of monolithic
 * crons that time out (e.g. refresh-knowledge-cache → 504). Producers enqueue
 * units; the `process-job-queue` worker claims a batch each run with
 * FOR UPDATE SKIP LOCKED, processes within a time budget, and marks done/failed.
 *
 * @module app/lib/jobQueue
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { createDefaultSqlRunner } from '@/app/lib/dataIntelligence/buildCatalog';
import { logger } from '@/app/lib/logger';

/** A claimed job row handed to a worker. */
export interface QueuedJob {
  id: number;
  job_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

/** Escape single quotes for SQL string literals. */
function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Enqueue a unit of work. Idempotent per (job_type, payload.dedupe_key) while a
 * matching job is still pending/running (unique index in migration 192).
 *
 * @param jobType - Handler key (e.g. 'knowledge-topic')
 * @param payload - Arbitrary JSON payload (may include `dedupe_key`)
 * @returns true if enqueued, false if a duplicate was skipped
 */
export async function enqueue(jobType: string, payload: Record<string, unknown>): Promise<boolean> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any).from('job_queue').insert({ job_type: jobType, payload });
  if (error) {
    // 23505 = unique_violation (dedupe) — expected, not a failure.
    if (error.code === '23505') return false;
    logger.error(`[jobQueue] enqueue failed for ${jobType}:`, error.message);
    throw new Error(`enqueue failed: ${error.message}`);
  }
  return true;
}

/**
 * Atomically claim up to `limit` runnable jobs (status='pending', due now).
 * Uses FOR UPDATE SKIP LOCKED so concurrent workers never grab the same row.
 *
 * @param workerId - Identifier for this worker invocation (for locked_by)
 * @param limit    - Max jobs to claim
 * @returns The claimed jobs (already marked 'running')
 */
export async function claimBatch(workerId: string, limit: number): Promise<QueuedJob[]> {
  const rpc = createDefaultSqlRunner();
  const sql = `
    UPDATE public.job_queue q
    SET status = 'running',
        locked_at = now(),
        locked_by = '${sqlEscape(workerId)}',
        attempts = attempts + 1,
        updated_at = now()
    FROM (
      SELECT id FROM public.job_queue
      WHERE status = 'pending' AND scheduled_for <= now() AND attempts < max_attempts
      ORDER BY scheduled_for
      LIMIT ${Math.max(1, Math.floor(limit))}
      FOR UPDATE SKIP LOCKED
    ) picked
    WHERE q.id = picked.id
    RETURNING q.id, q.job_type, q.payload, q.attempts, q.max_attempts;
  `;
  const rows = await rpc(sql);
  return rows as unknown as QueuedJob[];
}

/**
 * Reset jobs stuck in 'running' past a stale threshold (worker died mid-run)
 * back to 'pending' so they get retried. Call at worker start.
 *
 * @param staleMinutes - Age of locked_at after which a 'running' job is stale
 * @returns Number of jobs reclaimed
 */
export async function reclaimStale(staleMinutes = 15): Promise<number> {
  const rpc = createDefaultSqlRunner();
  const rows = await rpc(
    `UPDATE public.job_queue
     SET status = 'pending', locked_by = NULL, locked_at = NULL, updated_at = now()
     WHERE status = 'running' AND locked_at < now() - interval '${Math.max(1, Math.floor(staleMinutes))} minutes'
     RETURNING id;`
  );
  return rows.length;
}

/**
 * Mark a job as successfully completed.
 *
 * @param id     - Job id
 * @param result - Optional result payload stored on the row
 */
export async function completeJob(id: number, result?: Record<string, unknown>): Promise<void> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from('job_queue')
    .update({
      status: 'done',
      result: result ?? null,
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
}

/**
 * Mark a job as failed. Retries with exponential backoff while attempts remain;
 * otherwise moves to terminal 'error'.
 *
 * @param job     - The claimed job (needs attempts/max_attempts)
 * @param message - Error message
 */
export async function failJob(job: QueuedJob, message: string): Promise<void> {
  const admin = createAdminClient();
  const canRetry = job.attempts < job.max_attempts;
  const patch: Record<string, unknown> = {
    error: message.slice(0, 1000),
    updated_at: new Date().toISOString(),
  };
  if (canRetry) {
    // Backoff: 5min, 25min, ... (5^attempts minutes), reset to pending.
    const backoffMin = Math.min(60, 5 * job.attempts);
    patch.status = 'pending';
    patch.scheduled_for = new Date(Date.now() + backoffMin * 60_000).toISOString();
    patch.locked_by = null;
    patch.locked_at = null;
  } else {
    patch.status = 'error';
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('job_queue').update(patch).eq('id', job.id);
}
