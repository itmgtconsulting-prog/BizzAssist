/**
 * Job-type handlers for the durable job queue (BIZZ-2209).
 *
 * Maps a `job_type` to an async handler that processes one queued unit of work
 * and returns a small result object. Each handler MUST finish well within the
 * worker's per-job time budget (a few tens of seconds), so heavy work is split
 * into many small jobs at enqueue time rather than one monolithic run.
 *
 * @module app/lib/jobHandlers
 */

import { buildAndUpsertSingleTopic } from '@/app/lib/dataIntelligence/buildKnowledge';
import type { QueuedJob } from '@/app/lib/jobQueue';

/** A handler processes one job's payload and returns a JSON-serialisable result. */
export type JobHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * Registry of job-type → handler. Add new heavy-work types here.
 */
export const JOB_HANDLERS: Record<string, JobHandler> = {
  /** Build + upsert one knowledge-cache topic (BIZZ-2208 split). */
  'knowledge-topic': async (payload) => {
    const topic = String(payload.topic ?? '');
    if (!topic) throw new Error('knowledge-topic: mangler payload.topic');
    const rows = await buildAndUpsertSingleTopic(topic);
    return { topic, rows };
  },
};

/**
 * Dispatch a claimed job to its registered handler.
 *
 * @param job - The claimed job
 * @returns The handler result
 * @throws if no handler is registered for the job_type
 */
export async function runJob(job: QueuedJob): Promise<Record<string, unknown>> {
  const handler = JOB_HANDLERS[job.job_type];
  if (!handler) throw new Error(`Ingen handler for job_type: ${job.job_type}`);
  return handler(job.payload ?? {});
}
