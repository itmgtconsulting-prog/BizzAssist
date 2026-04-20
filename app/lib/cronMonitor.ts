/**
 * Cron monitoring wrapper — combines heartbeat + Sentry monitor.
 *
 * BIZZ-621 + BIZZ-624: Unified observability for all cron routes. Every cron
 * wraps its handler in `withCronMonitor()` for belt-and-suspenders coverage:
 *
 *  - cron_heartbeats table (intern, realtime dashboard)
 *  - Sentry.withMonitor (ekstern, trending + alert-eskalering)
 *
 * Hvis én af dem fejler, fortsætter cronen — observability er fire-and-forget.
 *
 * Usage:
 *   export async function GET(req: NextRequest) {
 *     return withCronMonitor(
 *       { jobName: 'daily-report', schedule: '0 7 * * *', intervalMinutes: 1440 },
 *       async () => {
 *         // ... faktisk cron-logik ...
 *         return NextResponse.json({ ok: true });
 *       }
 *     );
 *   }
 *
 * @module app/lib/cronMonitor
 */

import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { recordHeartbeat } from '@/app/lib/cronHeartbeat';
import { logger } from '@/app/lib/logger';

/** Cron-konfiguration der matcher entry i vercel.json */
export interface CronMonitorConfig {
  /** Unikt job-navn (matcher recordHeartbeat-nøglen i cron_heartbeats-tabellen) */
  jobName: string;
  /** Crontab-expression fra vercel.json (fx '0 7 * * *') */
  schedule: string;
  /** Forventet interval i minutter — bruges af watchdog til overdue-detektion */
  intervalMinutes: number;
  /**
   * Max runtime i minutter før Sentry markerer som timeout. Default 10.
   * Vercel-crons har typisk 60s eller 300s limits — hold under det.
   */
  maxRuntimeMinutes?: number;
  /**
   * Margin (minutter) Sentry venter før den betragter en cron som missed.
   * Default 1 — skulle matcher crontab-nøjagtighed.
   */
  checkinMargin?: number;
}

/**
 * Wrapper for Next.js cron route handlers.
 * Udfører handleren inde i Sentry.withMonitor + recordHeartbeat på start/slut.
 *
 * @param config   - Job-identity + schedule + intervaller
 * @param handler  - Den faktiske cron-logik. Returnerer NextResponse.
 * @returns NextResponse fra handleren, eller 500 ved uventet fejl.
 */
export async function withCronMonitor(
  config: CronMonitorConfig,
  handler: () => Promise<NextResponse>
): Promise<NextResponse> {
  const { jobName, schedule, intervalMinutes, maxRuntimeMinutes = 10, checkinMargin = 1 } = config;

  const startedAt = Date.now();

  // Sentry.withMonitor wrapper — captures cron-checkin + alerts på missed/failed.
  // Fejler graceful hvis Sentry ikke er konfigureret.
  return Sentry.withMonitor(
    jobName,
    async () => {
      try {
        const response = await handler();
        const durationMs = Date.now() - startedAt;
        // Fire-and-forget: vi venter ikke på heartbeat-write
        void recordHeartbeat(jobName, 'success', durationMs, intervalMinutes);
        return response;
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[cron:${jobName}] fejl efter ${durationMs}ms:`, msg);
        void recordHeartbeat(jobName, 'error', durationMs, intervalMinutes, msg);
        // Re-throw så Sentry.withMonitor markerer check-in som error + captures
        // exception. Vercel får 500-response som swap dermed passer gennem.
        throw err;
      }
    },
    {
      schedule: { type: 'crontab', value: schedule },
      maxRuntime: maxRuntimeMinutes,
      checkinMargin,
    }
  );
}
