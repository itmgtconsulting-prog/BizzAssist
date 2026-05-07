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
import * as Sentry from '@sentry/nextjs';

export const maxDuration = 300;

const FROM_ADDRESS = `BizzAssist Watchdog <${companyInfo.noreplyEmail}>`;
const TO_ADDRESS = companyInfo.supportEmail;

// ── Data-freshness thresholds (hours) ────────────────────────────────────────

interface FreshnessCheck {
  /** Human-readable label */
  label: string;
  /** Table to check */
  table: string;
  /** Column with the last-updated timestamp */
  column: string;
  /** Max allowed age in hours before warning */
  maxHours: number;
}

const FRESHNESS_CHECKS: FreshnessCheck[] = [
  { label: 'CVR Virksomheder', table: 'cvr_virksomhed', column: 'sidst_hentet', maxHours: 48 },
  { label: 'BBR Ejendomsstatus', table: 'cache_bbr', column: 'updated_at', maxHours: 48 },
  { label: 'EJF Ejerskab', table: 'ejf_ejerskab', column: 'updated_at', maxHours: 48 },
  { label: 'CVR Deltagere', table: 'cvr_deltager', column: 'berigelse_sidst', maxHours: 48 },
  { label: 'DAR Adresser', table: 'cache_dar', column: 'updated_at', maxHours: 168 }, // 7 days
  { label: 'VUR Vurderinger', table: 'cache_vur', column: 'updated_at', maxHours: 336 }, // 14 days
];

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
  kind: 'overdue' | 'error';
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
      }

      if (overdueMs > 0) {
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
 * Check data-freshness thresholds for critical cache tables.
 * Uses Supabase Management API to avoid type issues with dynamic tables.
 *
 * @returns Array of stale data issues
 */
async function checkDataFreshness(): Promise<FreshnessIssue[]> {
  const admin = createAdminClient();
  const issues: FreshnessIssue[] = [];

  for (const check of FRESHNESS_CHECKS) {
    try {
      // Check if table exists and get latest timestamp + count
      const { data, error } = await (
        admin as unknown as {
          from: (t: string) => {
            select: (
              c: string,
              o: { count: string; head: boolean }
            ) => {
              order: (
                col: string,
                opts: { ascending: boolean }
              ) => {
                limit: (n: number) => Promise<{
                  data: Array<Record<string, unknown>> | null;
                  error: { message: string } | null;
                  count: number | null;
                }>;
              };
            };
          };
        }
      )
        .from(check.table)
        .select(check.column, { count: 'exact', head: false })
        .order(check.column, { ascending: false })
        .limit(1);

      if (error) {
        // Table might not exist yet — not an issue per se
        logger.warn(`[watchdog] Freshness check skipped for ${check.table}:`, error.message);
        continue;
      }

      const rowCount = (data as unknown as { count?: number })?.count ?? data?.length ?? 0;
      if (rowCount === 0) {
        issues.push({
          label: check.label,
          table: check.table,
          ageHours: null,
          maxHours: check.maxHours,
          rowCount: 0,
        });
        continue;
      }

      const latestRow = data?.[0];
      const latestTs = latestRow?.[check.column] as string | null;
      if (!latestTs) continue;

      const ageMs = Date.now() - new Date(latestTs).getTime();
      const ageHours = Math.floor(ageMs / 3600000);

      if (ageHours > check.maxHours) {
        issues.push({
          label: check.label,
          table: check.table,
          ageHours,
          maxHours: check.maxHours,
          rowCount: typeof rowCount === 'number' ? rowCount : 0,
        });
      }
    } catch (e) {
      logger.warn(`[watchdog] Freshness check failed for ${check.table}:`, e);
    }
  }

  return issues;
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
    const [heartbeatIssues, freshnessIssues] = await Promise.all([
      checkHeartbeats(),
      checkDataFreshness(),
    ]);

    const totalIssues = heartbeatIssues.length + freshnessIssues.length;

    // Send alert email only if there are issues
    let emailSent = false;
    if (totalIssues > 0) {
      emailSent = await sendAlertEmail(heartbeatIssues, freshnessIssues);

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
