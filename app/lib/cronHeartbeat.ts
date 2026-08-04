/**
 * Cron heartbeat helper — records execution of cron jobs.
 *
 * Each cron job calls recordHeartbeat() on completion. The watchdog cron
 * checks for stale heartbeats and alerts if a job hasn't run within its
 * expected interval.
 *
 * Uses public.cron_heartbeats table (created by migration).
 * Fire-and-forget — errors are logged but never re-thrown.
 *
 * BIZZ-305: Prevents silent cron failures from going undetected.
 *
 * @module app/lib/cronHeartbeat
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

/** Outcome of a cron run. `degraded` = ran without throwing but did no useful
 * work when work was expected, or an external dependency failed. */
export type CronStatus = 'success' | 'error' | 'degraded';

/** Work-done metrics reported by a cron handler (BIZZ-2209). */
export interface CronMetrics {
  /** Candidate/input items the run looked at. */
  itemsProcessed?: number;
  /** Items actually written/upserted. */
  itemsWritten?: number;
  /** Why the run is degraded (set when status === 'degraded'). */
  degradedReason?: string;
}

export interface HeartbeatRecord {
  job_name: string;
  last_run_at: string;
  last_status: CronStatus;
  last_duration_ms: number;
  expected_interval_minutes: number;
  last_error?: string;
  last_items_processed?: number | null;
  last_items_written?: number | null;
  last_degraded_reason?: string | null;
}

/**
 * Records a cron job heartbeat AND appends a cron_run_history time-series row.
 * Call at the end of each cron handler (withCronMonitor does this automatically).
 *
 * @param jobName - Unique job identifier (e.g. 'service-scan', 'daily-report')
 * @param status - success | error | degraded
 * @param durationMs - Execution duration in milliseconds
 * @param expectedIntervalMinutes - How often this job should run (for watchdog)
 * @param error - Error message if status is 'error'
 * @param metrics - Optional work-done metrics (items processed/written, degraded reason)
 */
export async function recordHeartbeat(
  jobName: string,
  status: CronStatus,
  durationMs: number,
  expectedIntervalMinutes: number,
  error?: string,
  metrics?: CronMetrics
): Promise<void> {
  try {
    const admin = createAdminClient();
    const nowIso = new Date().toISOString();
    const itemsProcessed = metrics?.itemsProcessed ?? null;
    const itemsWritten = metrics?.itemsWritten ?? null;
    const degradedReason = metrics?.degradedReason ?? null;

    // cron_heartbeats is not in generated Supabase types — cast to bypass type check.
    // Supabase client returns { error } instead of throwing — must check explicitly.
    const a = admin as unknown as {
      from: (t: string) => {
        upsert: (
          v: Record<string, unknown>,
          o?: { onConflict: string }
        ) => Promise<{ error: { message: string; code?: string } | null }>;
        insert: (v: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
      };
    };

    // 1. Upsert the latest-state heartbeat (one row per job).
    const result = await a.from('cron_heartbeats').upsert(
      {
        job_name: jobName,
        last_run_at: nowIso,
        last_status: status,
        last_duration_ms: durationMs,
        expected_interval_minutes: expectedIntervalMinutes,
        last_error: error ?? null,
        last_items_processed: itemsProcessed,
        last_items_written: itemsWritten,
        last_degraded_reason: degradedReason,
      },
      { onConflict: 'job_name' }
    );
    if (result.error) {
      logger.error(`[heartbeat] Supabase upsert failed for ${jobName}:`, result.error.message);
    }

    // 2. Append an immutable time-series row for trends + "0 work for N days".
    const hist = await a.from('cron_run_history').insert({
      job_name: jobName,
      run_at: nowIso,
      status,
      duration_ms: durationMs,
      items_processed: itemsProcessed,
      items_written: itemsWritten,
      degraded_reason: degradedReason,
      error: error ?? null,
    });
    if (hist.error) {
      logger.error(
        `[heartbeat] cron_run_history insert failed for ${jobName}:`,
        hist.error.message
      );
    }
  } catch (e) {
    logger.error(`[heartbeat] Failed to record heartbeat for ${jobName}:`, e);
  }
}

/**
 * Checks all heartbeats and returns jobs that are overdue or in error state.
 *
 * @returns Array of stale/failed heartbeat records
 */
export async function checkHeartbeats(): Promise<
  (HeartbeatRecord & { is_overdue: boolean; minutes_overdue: number })[]
> {
  try {
    const admin = createAdminClient();
    // cron_heartbeats is not in generated Supabase types — cast to bypass type check
    const { data, error } = await (
      admin as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            order: (
              col: string,
              opts: { ascending: boolean }
            ) => Promise<{ data: HeartbeatRecord[] | null; error: unknown }>;
          };
        };
      }
    )
      .from('cron_heartbeats')
      .select('*')
      .order('last_run_at', { ascending: false });

    if (error || !data) return [];

    const now = Date.now();
    return data.map((row: HeartbeatRecord) => {
      const lastRun = new Date(row.last_run_at).getTime();
      const expectedMs = row.expected_interval_minutes * 60 * 1000;
      const overdueMs = now - lastRun - expectedMs * 2; // Alert after 2x expected interval
      return {
        ...row,
        is_overdue: overdueMs > 0,
        minutes_overdue: overdueMs > 0 ? Math.floor(overdueMs / 60000) : 0,
      };
    });
  } catch (e) {
    logger.error('[heartbeat] Failed to check heartbeats:', e);
    return [];
  }
}
