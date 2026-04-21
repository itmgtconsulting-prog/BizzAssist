/**
 * GET /api/admin/cron-status
 *
 * BIZZ-621: Returnerer status for alle cron-jobs — kombinerer schedule-listen
 * fra vercel.json med heartbeat-data fra public.cron_heartbeats-tabellen.
 *
 * Response-form:
 * {
 *   summary: { total, ok, error, overdue, missing },
 *   crons: Array<{
 *     jobName, schedule, intervalMinutes,
 *     lastRunAt, lastStatus, lastDurationMs, lastError,
 *     status: 'ok' | 'error' | 'overdue' | 'missing'
 *   }>
 * }
 *
 * Admin-only (app_metadata.isAdmin).
 *
 * @returns Cron-status aggregat til /dashboard/admin/cron-status
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

/**
 * Master-liste af cron-jobs — skal matche vercel.json + withCronMonitor-
 * kaldene i hver cron-route. Én entry pr. unik job-navn (sitemap-phases
 * registreres som tre separate jobs via withCronMonitor).
 */
interface CronDef {
  jobName: string;
  schedule: string;
  intervalMinutes: number;
  /** Menneske-venlig beskrivelse til admin-UI */
  description: string;
}

const CRONS: CronDef[] = [
  {
    jobName: 'generate-sitemap-companies',
    schedule: '23 2 * * *',
    intervalMinutes: 24 * 60,
    description: 'Daglig sitemap-generering for CVR-sider',
  },
  {
    jobName: 'generate-sitemap-properties',
    schedule: '30 * * * *',
    intervalMinutes: 60,
    description: 'Timebaseret sitemap-generering for BFE-sider (hver :30)',
  },
  {
    jobName: 'generate-sitemap-vp-properties',
    schedule: '51 4 * * *',
    intervalMinutes: 24 * 60,
    description: 'Daglig sitemap for Vurderingsportalen-hits',
  },
  {
    jobName: 'poll-properties',
    schedule: '0 3 * * *',
    intervalMinutes: 24 * 60,
    description: 'Daglig polling af fulgte ejendomme',
  },
  {
    jobName: 'pull-bbr-events',
    schedule: '0 */6 * * *',
    intervalMinutes: 6 * 60,
    description: 'BBR hændelsesbesked-feed (hver 6. time)',
  },
  {
    jobName: 'deep-scan',
    schedule: '30 3 * * *',
    intervalMinutes: 24 * 60,
    description: 'Daglig deep-scan af alle aktive tenants',
  },
  {
    jobName: 'warm-cache',
    schedule: '0 4 * * *',
    intervalMinutes: 24 * 60,
    description: 'Daglig cache-priming af top-virksomheder',
  },
  {
    jobName: 'daily-report',
    schedule: '0 7 * * *',
    intervalMinutes: 24 * 60,
    description: 'Daglig admin-rapport via email',
  },
  {
    jobName: 'daily-status',
    schedule: '0 6 * * *',
    intervalMinutes: 24 * 60,
    description: 'Daglig infrastruktur-statusrapport',
  },
  {
    jobName: 'service-scan',
    schedule: '0 * * * *',
    intervalMinutes: 60,
    description: 'Timely scan af infrastruktur-services',
  },
  {
    jobName: 'monitor-email',
    schedule: '*/5 * * * *',
    intervalMinutes: 5,
    description: 'Overvågning af e-mail bounce/complaint-rate',
  },
  {
    jobName: 'ingest-ejf-bulk',
    schedule: '0 4 * * *',
    intervalMinutes: 24 * 60,
    description: 'Daglig EJF-bulk-ingestion (person→ejendom)',
  },
  {
    jobName: 'pull-tinglysning-aendringer',
    schedule: '15 3 * * *',
    intervalMinutes: 24 * 60,
    description: 'Daglig Tinglysning delta-sync — 5-dages rolling window opdaterer ejf_ejerskab',
  },
  {
    jobName: 'purge-old-data',
    schedule: '0 2 * * *',
    intervalMinutes: 24 * 60,
    description: 'Daglig GDPR-oprydning af search/activity > 12 mdr',
  },
  {
    jobName: 'ai-feedback-triage',
    schedule: '0 8 * * *',
    intervalMinutes: 24 * 60,
    description: 'Triage af bruger-feedback til AI-svar',
  },
];

/** Afledt status for en cron baseret på heartbeat + forventet interval */
type CronStatus = 'ok' | 'error' | 'overdue' | 'missing';

interface CronRow {
  jobName: string;
  schedule: string;
  intervalMinutes: number;
  description: string;
  lastRunAt: string | null;
  lastStatus: 'success' | 'error' | null;
  lastDurationMs: number | null;
  lastError: string | null;
  status: CronStatus;
}

export async function GET(): Promise<NextResponse> {
  // BIZZ-621: Wrap i try/catch så manglende tabel (PGRST205) eller RLS-fejl
  // ikke resulterer i HTTP 500 for hele dashboardet. Vi returnerer altid
  // 200 med CRONS-listen — rækker markeres som "missing" når heartbeat-
  // tabellen ikke kan læses.
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

    // Hent alle heartbeats på én gang. Supabase-typerne regenereres ikke
    // automatisk efter migration 041, så vi caster til eksplicit shape.
    interface HeartbeatRow {
      job_name: string;
      last_run_at: string | null;
      last_status: 'success' | 'error' | null;
      last_duration_ms: number | null;
      last_error: string | null;
    }
    let heartbeats: HeartbeatRow[] = [];
    let heartbeatError: string | null = null;
    try {
      const { data, error } = await admin
        .from('cron_heartbeats')
        .select('job_name, last_run_at, last_status, last_duration_ms, last_error')
        .returns<HeartbeatRow[]>();
      if (error) {
        heartbeatError = error.message;
        logger.error('[cron-status] heartbeat query fejl:', error.message);
      } else {
        heartbeats = data ?? [];
      }
    } catch (err) {
      // fx PGRST205 "table not found" hvis migration 041 ikke er kørt
      heartbeatError = err instanceof Error ? err.message : 'heartbeat query threw';
      logger.error('[cron-status] heartbeat query exception:', err);
    }

    const byJob = new Map<string, HeartbeatRow>();
    for (const h of heartbeats) byJob.set(h.job_name, h);

    const now = Date.now();
    const crons: CronRow[] = CRONS.map((def) => {
      const hb = byJob.get(def.jobName);
      if (!hb) {
        return {
          jobName: def.jobName,
          schedule: def.schedule,
          intervalMinutes: def.intervalMinutes,
          description: def.description,
          lastRunAt: null,
          lastStatus: null,
          lastDurationMs: null,
          lastError: null,
          status: 'missing',
        };
      }
      const ageMinutes = hb.last_run_at
        ? (now - new Date(hb.last_run_at).getTime()) / 60_000
        : Infinity;
      // Overdue hvis sidste run er > 2× forventet interval + 5 min grace
      const overdue = ageMinutes > def.intervalMinutes * 2 + 5;
      const status: CronStatus = hb.last_status === 'error' ? 'error' : overdue ? 'overdue' : 'ok';

      return {
        jobName: def.jobName,
        schedule: def.schedule,
        intervalMinutes: def.intervalMinutes,
        description: def.description,
        lastRunAt: hb.last_run_at,
        lastStatus: hb.last_status as 'success' | 'error',
        lastDurationMs: hb.last_duration_ms,
        lastError: hb.last_error,
        status,
      };
    });

    const summary = {
      total: crons.length,
      ok: crons.filter((c) => c.status === 'ok').length,
      error: crons.filter((c) => c.status === 'error').length,
      overdue: crons.filter((c) => c.status === 'overdue').length,
      missing: crons.filter((c) => c.status === 'missing').length,
    };

    return NextResponse.json(
      {
        summary,
        crons,
        // BIZZ-621: Inkludér evt. heartbeat-fejl så UI kan vise en banner
        // i stedet for at dashboardet går ned. Når null er alt OK.
        heartbeatError,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    // Sidste-linje-sikkerhed: hvis noget uventet fejler (fx auth eller
    // Supabase-connection), returnér 500 med generisk fejl — men KUN her,
    // ikke ved heartbeat-query-fejl.
    logger.error('[cron-status] Uventet fejl:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Intern serverfejl' },
      { status: 500 }
    );
  }
}
