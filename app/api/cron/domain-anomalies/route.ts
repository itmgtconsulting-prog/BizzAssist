/**
 * Domain isolation anomaly detection cron — /api/cron/domain-anomalies
 *
 * BIZZ-722 Gap 2: Daily job that queries `domain_suspicious_access` and
 * emails super-admins if any rows surface. An anomaly means an actor took
 * an action on a domain they are NOT a current member of — i.e. a potential
 * isolation breach (removed member whose session wasn't invalidated, RLS
 * bypass, or a bug in a guarded API route).
 *
 * Security:
 *   - Requires Authorization: Bearer <CRON_SECRET> header
 *   - In Vercel production also requires x-vercel-cron: 1 header
 *   - Uses admin client (service_role) — no user session
 *
 * Retention: only checks audit log entries from the last 24 hours to keep
 * alert volume manageable. Long-standing anomalies are surfaced on the first
 * daily run and suppressed thereafter until a new event occurs.
 *
 * Schedule: 0 4 * * * (4am nightly — after purge-old-data)
 *
 * @module api/cron/domain-anomalies
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { RESEND_ENDPOINT } from '@/app/lib/serviceEndpoints';

export const maxDuration = 300;

/** Shape of one row from public.domain_suspicious_access. */
interface SuspiciousAccessRow {
  log_id: string;
  domain_id: string;
  actor_user_id: string;
  action: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  domain_name: string;
}

/**
 * Validates the cron bearer token and (in production) the Vercel cron header.
 * Prevents unauthenticated external callers from triggering the anomaly scan.
 *
 * @param request - Incoming edge request
 * @returns true if request is authorised to run the cron
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

/**
 * Sends an alert email to super-admins via Resend.
 * Silent fallback if RESEND_API_KEY is missing — logs only.
 *
 * @param rows - Suspicious rows surfaced in the last 24h
 */
async function sendAnomalyAlert(rows: SuspiciousAccessRow[]): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const recipient = process.env.DOMAIN_ANOMALY_ALERT_EMAIL || 'itmgtconsulting@gmail.com';

  if (!apiKey) {
    logger.warn('[cron/domain-anomalies] RESEND_API_KEY not set — skipping alert email');
    return;
  }

  const rowsHtml = rows
    .map(
      (r) => `
      <tr>
        <td>${r.created_at}</td>
        <td>${r.domain_name} (<code>${r.domain_id.substring(0, 8)}…</code>)</td>
        <td><code>${r.actor_user_id.substring(0, 8)}…</code></td>
        <td>${r.action}</td>
      </tr>`
    )
    .join('');

  const html = `
    <h2>Domain Isolation Anomaly Detected</h2>
    <p><strong>${rows.length}</strong> audit-log entries show actions by non-members on a domain within the last 24 hours.</p>
    <p>This indicates a potential isolation breach (removed member session, RLS bypass, or guard regression).</p>
    <table border="1" cellpadding="6" cellspacing="0">
      <thead><tr><th>When</th><th>Domain</th><th>Actor</th><th>Action</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <p>Investigate via: <code>SELECT * FROM public.domain_suspicious_access LIMIT 100;</code></p>
  `;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM_ADDRESS || 'BizzAssist Security <noreply@bizzassist.dk>',
        to: recipient,
        subject: `[BIZZASSIST SECURITY] Domain isolation anomaly — ${rows.length} events in 24h`,
        html,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      logger.error('[cron/domain-anomalies] Resend API error:', res.status);
    }
  } catch (err) {
    logger.error('[cron/domain-anomalies] Failed to send alert email:', err);
  }
}

/**
 * GET /api/cron/domain-anomalies — scan last 24h of domain audit log for
 * entries where the actor is NOT a current member of the domain. Alerts
 * super-admins if any are found.
 *
 * @param request - Incoming request (must carry CRON_SECRET bearer)
 * @returns JSON summary { ok, anomalies_found, emailed }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (admin as any)
    .from('domain_suspicious_access')
    .select('*')
    .gte('created_at', since)
    .limit(500)) as { data: SuspiciousAccessRow[] | null; error: { message: string } | null };

  if (error) {
    logger.error('[cron/domain-anomalies] Query failed:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  const rows = data ?? [];
  let emailed = false;

  if (rows.length > 0) {
    await sendAnomalyAlert(rows);
    emailed = true;
    logger.warn(`[cron/domain-anomalies] ${rows.length} anomalies detected + alert sent`);
  }

  return NextResponse.json({
    ok: true,
    anomalies_found: rows.length,
    since,
    emailed,
  });
}
