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

export interface HeartbeatRecord {
  job_name: string;
  last_run_at: string;
  last_status: 'success' | 'error';
  last_duration_ms: number;
  expected_interval_minutes: number;
  last_error?: string;
}

/**
 * Records a cron job heartbeat. Call at the end of each cron handler.
 *
 * @param jobName - Unique job identifier (e.g. 'service-scan', 'daily-report')
 * @param status - Whether the job succeeded or failed
 * @param durationMs - Execution duration in milliseconds
 * @param expectedIntervalMinutes - How often this job should run (for watchdog)
 * @param error - Error message if status is 'error'
 */
export async function recordHeartbeat(
  jobName: string,
  status: 'success' | 'error',
  durationMs: number,
  expectedIntervalMinutes: number,
  error?: string
): Promise<void> {
  try {
    const admin = createAdminClient();
    // cron_heartbeats is not in generated Supabase types — cast to bypass type check
    await (
      admin as unknown as {
        from: (t: string) => {
          upsert: (
            v: Record<string, unknown>,
            o: { onConflict: string }
          ) => Promise<{ error: unknown }>;
        };
      }
    )
      .from('cron_heartbeats')
      .upsert(
        {
          job_name: jobName,
          last_run_at: new Date().toISOString(),
          last_status: status,
          last_duration_ms: durationMs,
          expected_interval_minutes: expectedIntervalMinutes,
          last_error: error ?? null,
        },
        { onConflict: 'job_name' }
      );
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
