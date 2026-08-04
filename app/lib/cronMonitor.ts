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
import { NextResponse, after } from 'next/server';
import { recordHeartbeat, type CronMetrics, type CronStatus } from '@/app/lib/cronHeartbeat';
import { getCronJob } from '@/app/lib/cron/registry';
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
 * Flush en observability-write så den garanteret fuldfører EFTER responsen uden
 * at forsinke den.
 *
 * I prod kaldes cron-routes altid som HTTP-requests, så after() (next/server)
 * kører i request-scope og holder serverless-instansen i live til skrivningen er
 * flushet — modsat fire-and-forget void, som Vercel skar bort ved suspend.
 *
 * Uden for request-scope (unit/integration-tests der kalder handleren direkte)
 * kaster after() synkront; dér falder vi tilbage til at lade promiset køre
 * detached, så testene ikke afhænger af en Next request-kontekst.
 *
 * @param write - Det allerede-startede heartbeat-promise der skal flushes.
 */
function flushAfterResponse(write: Promise<void>): void {
  try {
    after(write);
  } catch {
    // Ingen request-scope (test-kontekst) — promiset resolver detached.
    void write;
  }
}

/**
 * Rigere handler-udfald (BIZZ-2209). En handler kan enten returnere en bar
 * NextResponse (legacy) eller dette objekt for at rapportere arbejds-metrikker
 * og eksplicit degradering.
 */
export interface CronHandlerResult {
  /** Svaret der returneres til Vercel. */
  response: NextResponse;
  /** Arbejds-metrikker (items processed/written). */
  metrics?: CronMetrics;
  /**
   * Markér kørslen som `degraded`. Sæt en string som årsag (fx "DAWA /bfe nede")
   * eller `true` for en generisk årsag. Bruges når jobbet kørte uden exception
   * men en ekstern afhængighed fejlede / intet nyttigt blev opnået.
   */
  degraded?: string | boolean;
}

/** Handler-signatur: må returnere en bar NextResponse eller et CronHandlerResult. */
type CronHandler = () => Promise<NextResponse | CronHandlerResult>;

/**
 * Resolvér job-konfiguration fra registeret (eneste sandhed) eller fra et
 * eksplicit config-objekt (legacy-kald). Registeret vinder for schedule/interval
 * så per-rute-værdier ikke kan drive ud af sync.
 */
function resolveConfig(
  config: CronMonitorConfig | string
): Required<
  Pick<
    CronMonitorConfig,
    'jobName' | 'schedule' | 'intervalMinutes' | 'maxRuntimeMinutes' | 'checkinMargin'
  >
> & { expectsWork: boolean } {
  const jobName = typeof config === 'string' ? config : config.jobName;
  const reg = getCronJob(jobName);
  const legacy = typeof config === 'string' ? undefined : config;
  return {
    jobName,
    schedule: reg?.schedule ?? legacy?.schedule ?? '* * * * *',
    intervalMinutes: reg?.intervalMinutes ?? legacy?.intervalMinutes ?? 60,
    maxRuntimeMinutes: legacy?.maxRuntimeMinutes ?? 10,
    checkinMargin: legacy?.checkinMargin ?? 1,
    expectsWork: reg?.expectsWork ?? false,
  };
}

/**
 * Wrapper for Next.js cron route handlers.
 * Kører handleren inde i Sentry.withMonitor + recordHeartbeat (via after()-flush).
 *
 * Status udledes: exception → `error`; eksplicit degraded eller (expectsWork &&
 * itemsProcessed===0) → `degraded`; ellers `success`. Arbejds-metrikker gemmes
 * på heartbeaten + i cron_run_history.
 *
 * @param config  - Job-navn (slås op i registeret) eller fuldt config-objekt (legacy)
 * @param handler - Cron-logik; returnerer NextResponse eller CronHandlerResult
 * @returns NextResponse fra handleren
 */
export async function withCronMonitor(
  config: CronMonitorConfig | string,
  handler: CronHandler
): Promise<NextResponse> {
  const { jobName, schedule, intervalMinutes, maxRuntimeMinutes, checkinMargin, expectsWork } =
    resolveConfig(config);

  const startedAt = Date.now();

  return Sentry.withMonitor(
    jobName,
    async () => {
      try {
        const raw = await handler();
        const isResult = raw instanceof NextResponse ? false : true;
        const response = isResult ? (raw as CronHandlerResult).response : (raw as NextResponse);
        const metrics = isResult ? (raw as CronHandlerResult).metrics : undefined;
        const explicitDegraded = isResult ? (raw as CronHandlerResult).degraded : undefined;
        const durationMs = Date.now() - startedAt;

        // Udled status: eksplicit degraded, eller expectsWork-job der ikke fandt
        // nogen kandidater (klassisk lydløs no-op — fx den frosne cache mid-maj).
        let status: CronStatus = 'success';
        let degradedReason: string | undefined;
        if (explicitDegraded) {
          status = 'degraded';
          degradedReason = typeof explicitDegraded === 'string' ? explicitDegraded : 'degraded';
        } else if (expectsWork && (metrics?.itemsProcessed ?? 0) === 0) {
          status = 'degraded';
          degradedReason = 'ingen kandidater behandlet — mulig broken afhængighed';
        }

        // BIZZ-2205: heartbeat-write flushes via after() (ikke fire-and-forget void),
        // så hurtigt-returnerende crons ikke taber skrivningen ved suspend.
        flushAfterResponse(
          recordHeartbeat(jobName, status, durationMs, intervalMinutes, undefined, {
            ...metrics,
            degradedReason: degradedReason ?? metrics?.degradedReason,
          })
        );
        return response;
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[cron:${jobName}] fejl efter ${durationMs}ms:`, msg);
        flushAfterResponse(recordHeartbeat(jobName, 'error', durationMs, intervalMinutes, msg));
        // Re-throw så Sentry.withMonitor markerer check-in som error + captures.
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
