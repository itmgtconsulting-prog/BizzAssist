/**
 * data_sync_status writer (BIZZ-2209).
 *
 * A single helper every data-producing cron calls so `public.data_sync_status`
 * (migration 082) becomes the authoritative record of "when did source X last
 * successfully sync, and how many rows did it write". Freshness monitoring reads
 * the cache tables directly (dataFreshness.ts), but this row captures the JOB's
 * self-reported outcome — the two together catch a cron that "succeeds" while
 * writing nothing (the mid-May silent freeze).
 *
 * @module app/lib/dataSyncStatus
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

/** Outcome reported by a data-producing cron for one source. */
export interface SyncOutcome {
  /** Rows written/upserted this run. */
  rowsSynced?: number;
  /** Total rows in the source (optional snapshot). */
  rowsTotal?: number;
  /** Wall-clock duration in ms. */
  durationMs?: number;
  /** Error message if the sync failed (null/undefined = success). */
  error?: string | null;
}

/**
 * Upsert a data source's sync status. Fire-and-forget safe (logs, never throws).
 *
 * @param sourceName - Stable source key (matches DataSource.sourceName)
 * @param outcome    - Rows synced / total / duration / error
 */
export async function recordSyncStatus(sourceName: string, outcome: SyncOutcome): Promise<void> {
  try {
    const admin = createAdminClient();
    const nowIso = new Date().toISOString();
    const ok = !outcome.error;
    const row: Record<string, unknown> = {
      source_name: sourceName,
      last_sync_at: nowIso,
      rows_synced: outcome.rowsSynced ?? 0,
      last_error: outcome.error ?? null,
      sync_duration_ms: outcome.durationMs ?? null,
      updated_at: nowIso,
    };
    if (ok) row.last_success = nowIso;
    if (outcome.rowsTotal !== undefined) row.rows_total = outcome.rowsTotal;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (admin as any)
      .from('data_sync_status')
      .upsert(row, { onConflict: 'source_name' });
    if (error) {
      logger.error(`[dataSyncStatus] upsert failed for ${sourceName}:`, error.message);
    }
  } catch (e) {
    logger.error(`[dataSyncStatus] failed for ${sourceName}:`, e);
  }
}
