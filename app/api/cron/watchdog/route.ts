/**
 * GET /api/cron/watchdog
 *
 * BIZZ-1196: Proactive cron-health monitor. Runs every 30 minutes and:
 *   1. Checks cron_heartbeats for overdue or failed jobs
 *   2. Checks data-freshness thresholds for critical tables
 *   3. Sends email alert via Resend when issues are detected
 *   4. Captures Sentry alert for critical (3x missed) escalation
 *
 * Does NOT use withCronMonitor itself — a watchdog monitoring itself
 * would create a circular dependency. Writes its own heartbeat directly.
 *
 * @module api/cron/watchdog
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { recordHeartbeat } from '@/app/lib/cronHeartbeat';
import { RESEND_ENDPOINT } from '@/app/lib/serviceEndpoints';
import { companyInfo } from '@/app/lib/companyInfo';
import { findIncompleteTenants } from '@/lib/tenant/verifyTenantSchema';
import { sendCriticalAlert } from '@/app/lib/service-manager-alerts';
import { checkAllDataFreshness, type DomainFreshness } from '@/app/lib/dataFreshness';
import * as Sentry from '@sentry/nextjs';

export const maxDuration = 300;

const FROM_ADDRESS = `BizzAssist Watchdog <${companyInfo.noreplyEmail}>`;
const TO_ADDRESS = companyInfo.supportEmail;

// Data-freshness thresholds live in the canonical registry (app/lib/cron/
// registry.ts → DATA_SOURCES) and are evaluated by checkAllDataFreshness().
// BIZZ-2209: the watchdog no longer keeps its own inline column list — that
// duplicate drifted (wrong column names) and silently no-op'd for 5/6 tables.

// ── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Verify CRON_SECRET bearer + x-vercel-cron header in production.
 *
 * @param request - Incoming request
 * @returns true if authorised
 */
function verifyCronSecret(request: NextRequest): boolean {
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return safeCompare(auth, `Bearer ${secret}`);
}

// ── Heartbeat checks ────────────────────────────────────────────────────────

interface HeartbeatIssue {
  jobName: string;
  kind: 'overdue' | 'error' | 'degraded';
  detail: string;
}

/**
 * Check all cron_heartbeats rows for overdue or errored jobs.
 *
 * @returns Array of issues found
 */
async function checkHeartbeats(): Promise<HeartbeatIssue[]> {
  const admin = createAdminClient();
  const issues: HeartbeatIssue[] = [];

  try {
    const { data, error } = await (
      admin as unknown as {
        from: (t: string) => {
          select: (c: string) => Promise<{
            data: Array<{
              job_name: string;
              last_run_at: string;
              last_status: string;
              last_duration_ms: number;
              expected_interval_minutes: number;
              last_error: string | null;
              last_degraded_reason: string | null;
            }> | null;
            error: { message: string } | null;
          }>;
        };
      }
    )
      .from('cron_heartbeats')
      .select('*');

    if (error || !data) {
      logger.error('[watchdog] Failed to read heartbeats:', error?.message);
      return issues;
    }

    const now = Date.now();
    for (const row of data) {
      const lastRun = new Date(row.last_run_at).getTime();
      const expectedMs = row.expected_interval_minutes * 60 * 1000;
      // Alert after 2x expected interval
      const overdueMs = now - lastRun - expectedMs * 2;

      if (row.last_status === 'error') {
        issues.push({
          jobName: row.job_name,
          kind: 'error',
          detail: `Last run failed: ${row.last_error ?? 'unknown error'}`,
        });
      } else if (row.last_status === 'degraded') {
        // BIZZ-2209: ran without throwing but did no useful work / a dependency
        // failed — the signal that catches a silently no-op'ing cron.
        issues.push({
          jobName: row.job_name,
          kind: 'degraded',
          detail: `Degraded: ${row.last_degraded_reason ?? row.last_error ?? 'intet nyttigt arbejde udført'}`,
        });
      }

      // Grace period: minimum 30 min overdue before alerting.
      // Vercel's cron scheduler has ±15 min jitter — without grace,
      // high-frequency jobs (*/5, */30) trigger false alerts constantly.
      const GRACE_MS = 30 * 60 * 1000;
      if (overdueMs > GRACE_MS) {
        const overdueMin = Math.floor(overdueMs / 60000);
        issues.push({
          jobName: row.job_name,
          kind: 'overdue',
          detail: `Overdue by ${overdueMin} minutes (expected every ${row.expected_interval_minutes}m)`,
        });
      }
    }
  } catch (e) {
    logger.error('[watchdog] Heartbeat check error:', e);
  }

  return issues;
}

// ── Data-freshness checks ───────────────────────────────────────────────────

interface FreshnessIssue {
  label: string;
  table: string;
  ageHours: number | null;
  maxHours: number;
  rowCount: number;
}

/**
 * Evaluate all registered data sources' freshness via checkAllDataFreshness()
 * (the single, schema-correct freshness engine). `config_error` results
 * (missing table/column) are separated so they can be escalated as critical —
 * a broken check is worse than stale data because it hides real staleness.
 *
 * @returns Stale-data issues + any misconfigured checks
 */
async function checkDataFreshness(): Promise<{
  issues: FreshnessIssue[];
  configErrors: DomainFreshness[];
}> {
  const results = await checkAllDataFreshness();
  const issues: FreshnessIssue[] = [];
  const configErrors: DomainFreshness[] = [];

  for (const r of results) {
    if (r.status === 'config_error') {
      configErrors.push(r);
    } else if (r.status === 'warning' || r.status === 'critical') {
      issues.push({
        label: r.domain,
        table: r.table,
        ageHours: r.hoursSinceUpdate,
        maxHours: r.status === 'critical' ? r.criticalThresholdHours : r.warningThresholdHours,
        rowCount: r.rowCount ?? 0,
      });
    }
  }

  return { issues, configErrors };
}

// ── Email alert ─────────────────────────────────────────────────────────────

/**
 * Send a watchdog alert email summarising all issues found.
 *
 * @param heartbeatIssues - Overdue/errored cron jobs
 * @param freshnessIssues - Stale data tables
 * @returns true if email was sent
 */
async function sendAlertEmail(
  heartbeatIssues: HeartbeatIssue[],
  freshnessIssues: FreshnessIssue[]
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn('[watchdog] RESEND_API_KEY not set — skipping alert email');
    return false;
  }

  const now = new Date().toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen' });

  let html = `<h2>⚠️ BizzAssist Watchdog Alert — ${now}</h2>`;

  if (heartbeatIssues.length > 0) {
    html += '<h3>Cron Job Issues</h3><table border="1" cellpadding="6" cellspacing="0">';
    html += '<tr><th>Job</th><th>Type</th><th>Detail</th></tr>';
    for (const issue of heartbeatIssues) {
      const color = issue.kind === 'error' ? '#dc2626' : '#f59e0b';
      html += `<tr><td>${issue.jobName}</td><td style="color:${color};font-weight:bold">${issue.kind.toUpperCase()}</td><td>${issue.detail}</td></tr>`;
    }
    html += '</table>';
  }

  if (freshnessIssues.length > 0) {
    html += '<h3>Stale Data</h3><table border="1" cellpadding="6" cellspacing="0">';
    html += '<tr><th>Dataset</th><th>Age</th><th>Threshold</th><th>Rows</th></tr>';
    for (const issue of freshnessIssues) {
      const ageStr = issue.ageHours !== null ? `${issue.ageHours}h` : 'NO DATA';
      html += `<tr><td>${issue.label}</td><td style="color:#dc2626;font-weight:bold">${ageStr}</td><td>${issue.maxHours}h</td><td>${issue.rowCount.toLocaleString()}</td></tr>`;
    }
    html += '</table>';
  }

  html += `<p style="color:#666;font-size:12px">${companyInfo.legalLineHtml}</p>`;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: TO_ADDRESS,
        subject: `[WATCHDOG] ${heartbeatIssues.length + freshnessIssues.length} issues detected`,
        html,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error('[watchdog] Resend API error:', res.status, body);
      return false;
    }

    logger.log('[watchdog] Alert email dispatched');
    return true;
  } catch (err) {
    logger.error('[watchdog] Failed to send alert email:', err);
    return false;
  }
}

// ── Alert-cooldown ────────────────────────────────────────────────────────────

/** Cooldown for gentagne alerts om det SAMME issue-sæt (BIZZ-2209). */
const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 timer

/**
 * Afgør om der skal sendes alert-mail nu, med cooldown så et VEDVARENDE issue
 * (fx en degraderet cron der venter på ekstern fix) ikke mailer hver 30. min.
 * State gemmes i public.data_sync_status (source_name='watchdog_alert'):
 * last_success = seneste mail-tid, last_error = seneste issue-signatur. Mailer
 * straks ved en NY signatur; re-mailer et uændret sæt højst hver ALERT_COOLDOWN_MS.
 *
 * @param signature - Stabil signatur over de aktuelle issues
 * @returns true hvis der skal sendes mail nu (og state opdateres)
 */
async function shouldSendAlert(signature: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = admin as any;
    const { data } = await a
      .from('data_sync_status')
      .select('last_success, last_error')
      .eq('source_name', 'watchdog_alert')
      .maybeSingle();

    const now = Date.now();
    const sameIssues = data?.last_error === signature;
    const lastMs = data?.last_success ? new Date(data.last_success).getTime() : 0;
    if (sameIssues && now - lastMs < ALERT_COOLDOWN_MS) return false; // samme sæt, i cooldown

    await a.from('data_sync_status').upsert(
      {
        source_name: 'watchdog_alert',
        last_success: new Date().toISOString(),
        last_error: signature,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'source_name' }
    );
    return true;
  } catch (e) {
    logger.warn('[watchdog] alert-cooldown-tjek fejlede — sender alligevel:', e);
    return true;
  }
}

// ── Main handler ────────────────────────────────────────────────────────────

/**
 * GET /api/cron/watchdog
 *
 * Checks cron heartbeats and data freshness, alerts on issues.
 *
 * @param request - Incoming request with CRON_SECRET auth
 * @returns JSON summary of checks performed
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();

  try {
    const [heartbeatIssues, freshness] = await Promise.all([
      checkHeartbeats(),
      checkDataFreshness(),
    ]);
    const freshnessIssues = freshness.issues;

    // BIZZ-2209: A misconfigured freshness check (missing table/column) is a
    // CRITICAL config bug — it silently hid 81 days of stale cache before. Alert
    // service-manager immediately + include in the email as fake "issues".
    if (freshness.configErrors.length > 0) {
      const detail = freshness.configErrors
        .map((c) => `${c.table}.${c.timestampColumn}`)
        .join(', ');
      logger.error('[watchdog] Friskheds-config-fejl:', detail);
      await sendCriticalAlert({
        description: `${freshness.configErrors.length} data-friskhedstjek fejl-konfigureret`,
        affectedPath: 'app/lib/cron/registry.ts',
        scanId: 'watchdog-freshness-config',
        issueType: 'config_error',
        context: `Datakilder med ikke-eksisterende tabel/kolonne: ${detail}. Ret DATA_SOURCES i registeret.`,
      }).catch((e) => logger.error('[watchdog] config-alert fejlede:', e));
      for (const c of freshness.configErrors) {
        freshnessIssues.push({
          label: `⚠ CONFIG-FEJL: ${c.domain}`,
          table: c.table,
          ageHours: null,
          maxHours: 0,
          rowCount: 0,
        });
      }
    }

    // BIZZ-2196/2203: Tenant-schema-komplethed foldet ind her (detect + alarmér)
    // i stedet for en separat cron — Vercel-scheduleren stopper ved 40 crons
    // (BIZZ-2203). Watchdog kører hvert 30. min, hvilket er en bedre kadence end
    // den tidligere daglige verify-tenant-schemas-cron. Auto-reparation sker
    // fortsat i provisionTenantForUser (post-provision); her alarmeres service
    // manager hvis en eksisterende tenant er drevet ufuldstændig.
    let incompleteSchemas: string[] = [];
    try {
      const incomplete = await findIncompleteTenants();
      if (incomplete && incomplete.length > 0) {
        incompleteSchemas = incomplete.map((t) => t.schemaName);
        await sendCriticalAlert({
          description: `${incomplete.length} tenant-schema(er) ufuldstændige`,
          affectedPath: 'app/api/cron/watchdog/route.ts',
          scanId: 'watchdog-tenant-schemas',
          issueType: 'config_error',
          context: `Manglende kerne-tabeller pr. tenant: ${incomplete
            .map((t) => `${t.schemaName}(${t.missing.join('/')})`)
            .join(
              '; '
            )}. Kør public.provision_tenant_all_features('<schema>','<tenant_uuid>') for at reparere.`,
        });
      }
    } catch (schemaErr) {
      logger.error('[watchdog] tenant-schema-tjek fejlede:', schemaErr);
    }

    const totalIssues = heartbeatIssues.length + freshnessIssues.length;

    // Send alert email only if there are issues — men med cooldown (BIZZ-2209):
    // watchdoggen kører hvert 30. min, og et VEDVARENDE issue (fx en degraderet
    // cron eller stale cache der venter på ekstern fix) må ikke maile hver 30.
    // min → 48 mails/dag. Vi mailer straks ved et NYT issue-sæt, og re-mailer et
    // uændret sæt højst hver 4. time.
    let emailSent = false;
    if (totalIssues > 0) {
      const issueSignature = [
        ...heartbeatIssues.map((i) => `${i.jobName}:${i.kind}`),
        ...freshnessIssues.map((i) => `fresh:${i.table}`),
      ]
        .sort()
        .join('|');
      const shouldAlert = await shouldSendAlert(issueSignature);
      emailSent = shouldAlert ? await sendAlertEmail(heartbeatIssues, freshnessIssues) : false;

      // Escalate critical issues to Sentry (3+ heartbeat issues = critical)
      const criticalCount = heartbeatIssues.filter((i) => i.kind === 'overdue').length;
      if (criticalCount >= 3) {
        Sentry.captureMessage(`[watchdog] ${criticalCount} cron jobs overdue — escalating`, {
          level: 'error',
          tags: { watchdog: 'critical' },
          extra: {
            overdue_jobs: heartbeatIssues.filter((i) => i.kind === 'overdue').map((i) => i.jobName),
            stale_tables: freshnessIssues.map((i) => i.table),
          },
        });
      }
    }

    const durationMs = Date.now() - startedAt;
    // Write own heartbeat directly (no withCronMonitor to avoid circular dep)
    void recordHeartbeat('watchdog', 'success', durationMs, 30);

    logger.log(
      `[watchdog] Check complete: ${totalIssues} issues (${heartbeatIssues.length} heartbeat, ${freshnessIssues.length} freshness), email=${emailSent}, ${durationMs}ms`
    );

    return NextResponse.json({
      ok: true,
      issues: totalIssues,
      heartbeat: heartbeatIssues,
      freshness: freshnessIssues,
      incompleteSchemas,
      emailSent,
      durationMs,
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    void recordHeartbeat('watchdog', 'error', durationMs, 30, String(err));
    logger.error('[watchdog] Unexpected error:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 200 });
  }
}
