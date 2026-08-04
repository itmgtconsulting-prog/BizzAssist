/**
 * GET /api/admin/cron-status
 *
 * BIZZ-621 / BIZZ-2209: Cron + data-source health for the admin dashboard.
 * Derives the job list from the CANONICAL registry (app/lib/cron/registry.ts)
 * — no more hardcoded list that drifts from vercel.json — and joins it with
 * cron_heartbeats (incl. work-metrics + degraded state) and the registry-driven
 * data-freshness SLOs.
 *
 * Response:
 * {
 *   summary: { total, ok, degraded, error, overdue, missing },
 *   crons: CronRow[],
 *   freshness: { summary, sources },
 *   heartbeatError: string | null
 * }
 *
 * Admin-only (app_metadata.isAdmin).
 *
 * @returns Cron + freshness aggregate for /dashboard/admin/cron-status
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import { CRON_JOBS } from '@/app/lib/cron/registry';
import { checkAllDataFreshness, summarizeFreshness } from '@/app/lib/dataFreshness';

/** Derived status for a cron based on heartbeat + expected interval. */
type CronStatus = 'ok' | 'degraded' | 'error' | 'overdue' | 'missing';

interface CronRow {
  jobName: string;
  schedule: string;
  intervalMinutes: number;
  category: string;
  description: string;
  lastRunAt: string | null;
  lastStatus: 'success' | 'error' | 'degraded' | null;
  lastDurationMs: number | null;
  lastError: string | null;
  itemsProcessed: number | null;
  itemsWritten: number | null;
  degradedReason: string | null;
  status: CronStatus;
}

interface HeartbeatRow {
  job_name: string;
  last_run_at: string | null;
  last_status: 'success' | 'error' | 'degraded' | null;
  last_duration_ms: number | null;
  last_error: string | null;
  last_items_processed: number | null;
  last_items_written: number | null;
  last_degraded_reason: string | null;
}

/**
 * GET handler — returns cron + freshness health. Never 500s on a heartbeat
 * query failure (returns the registry list with rows marked 'missing').
 *
 * @returns JSON aggregate for the admin dashboard
 */
export async function GET(): Promise<NextResponse> {
  try {
    // Admin-only
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const admin = createAdminClient();
    const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
    if (!freshUser?.user?.app_metadata?.isAdmin) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Heartbeats (best-effort — dashboard degrades gracefully if unreadable).
    let heartbeats: HeartbeatRow[] = [];
    let heartbeatError: string | null = null;
    try {
      const { data, error } = await admin
        .from('cron_heartbeats')
        .select(
          'job_name, last_run_at, last_status, last_duration_ms, last_error, last_items_processed, last_items_written, last_degraded_reason'
        )
        .returns<HeartbeatRow[]>();
      if (error) {
        heartbeatError = error.message;
        logger.error('[cron-status] heartbeat query fejl:', error.message);
      } else {
        heartbeats = data ?? [];
      }
    } catch (err) {
      heartbeatError = err instanceof Error ? err.message : 'heartbeat query threw';
      logger.error('[cron-status] heartbeat query exception:', err);
    }

    const byJob = new Map<string, HeartbeatRow>();
    for (const h of heartbeats) byJob.set(h.job_name, h);

    const now = Date.now();
    const crons: CronRow[] = CRON_JOBS.map((def) => {
      // Sitemap logs under rotating sub-names — match the freshest by prefix.
      let hb = byJob.get(def.jobName);
      if (!hb && def.heartbeatPrefix) {
        const subs = heartbeats
          .filter((h) => h.job_name.startsWith(def.heartbeatPrefix + '-'))
          .sort(
            (a, b) =>
              new Date(b.last_run_at ?? 0).getTime() - new Date(a.last_run_at ?? 0).getTime()
          );
        hb = subs[0];
      }

      if (!hb) {
        return {
          jobName: def.jobName,
          schedule: def.schedule,
          intervalMinutes: def.intervalMinutes,
          category: def.category,
          description: def.description,
          lastRunAt: null,
          lastStatus: null,
          lastDurationMs: null,
          lastError: null,
          itemsProcessed: null,
          itemsWritten: null,
          degradedReason: null,
          status: 'missing',
        };
      }

      const ageMinutes = hb.last_run_at
        ? (now - new Date(hb.last_run_at).getTime()) / 60_000
        : Infinity;
      const overdue = ageMinutes > def.intervalMinutes * 2 + 5;
      const status: CronStatus =
        hb.last_status === 'error'
          ? 'error'
          : hb.last_status === 'degraded'
            ? 'degraded'
            : overdue
              ? 'overdue'
              : 'ok';

      return {
        jobName: def.jobName,
        schedule: def.schedule,
        intervalMinutes: def.intervalMinutes,
        category: def.category,
        description: def.description,
        lastRunAt: hb.last_run_at,
        lastStatus: hb.last_status,
        lastDurationMs: hb.last_duration_ms,
        lastError: hb.last_error,
        itemsProcessed: hb.last_items_processed,
        itemsWritten: hb.last_items_written,
        degradedReason: hb.last_degraded_reason,
        status,
      };
    });

    const summary = {
      total: crons.length,
      ok: crons.filter((c) => c.status === 'ok').length,
      degraded: crons.filter((c) => c.status === 'degraded').length,
      error: crons.filter((c) => c.status === 'error').length,
      overdue: crons.filter((c) => c.status === 'overdue').length,
      missing: crons.filter((c) => c.status === 'missing').length,
    };

    // Data-freshness SLOs (registry-driven, schema-correct).
    let freshness: { summary: ReturnType<typeof summarizeFreshness>; sources: unknown[] } | null =
      null;
    try {
      const results = await checkAllDataFreshness();
      freshness = { summary: summarizeFreshness(results), sources: results };
    } catch (err) {
      logger.error('[cron-status] freshness-check fejl:', err);
    }

    return NextResponse.json(
      { summary, crons, freshness, heartbeatError },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    logger.error('[cron-status] Uventet fejl:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Intern serverfejl' },
      { status: 500 }
    );
  }
}
