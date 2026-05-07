/**
 * Cron: Monitor Email — /api/cron/monitor-email
 *
 * Runs every 5 minutes via Vercel Cron. Reads unread emails from the
 * monitor@pecuniait.com shared Microsoft 365 mailbox and triggers
 * auto-fix workflows or JIRA tickets based on the email category.
 *
 * Flow:
 *   1. Vercel Cron fires every 5 minutes (every-5-min cron schedule)
 *   2. Fetch unread emails from the shared mailbox via Microsoft Graph API
 *   3. Classify each email (github_ci_failure, vercel_deploy_failure,
 *      security_alert, uptime_alert, unknown)
 *   4. For each actionable email:
 *      a. Create a service_manager_scan record (scan_type: 'email_trigger')
 *      b. CI/deploy failures: POST to /api/admin/service-manager/auto-fix
 *         (max 3 auto-fix triggers per run to avoid overwhelming the system)
 *      c. Security alerts: create a JIRA ticket — NEVER auto-fix security issues
 *      d. Uptime alerts: send a critical alert email via sendCriticalAlert()
 *   5. Mark all processed emails as read
 *   6. Log all actions to service_manager_activity
 *   7. Return a JSON summary
 *
 * Safety guarantees (non-negotiable):
 *   - Max 3 auto-fix triggers per cron run (rate limit)
 *   - Security alerts NEVER trigger auto-fix — JIRA ticket only
 *   - All fix proposals remain 'proposed'; admin approval required to apply
 *   - Unknown emails are silently skipped (no action, no mark-as-read)
 *   - If env vars are missing, the cron exits early with a log — no error thrown
 *
 * Auth: Authorization: Bearer <CRON_SECRET> header only (BIZZ-181 pattern).
 * In production, also requires x-vercel-cron: 1 header from Vercel infrastructure.
 *
 * Env vars required:
 *   - CRON_SECRET                  — shared secret for this endpoint
 *   - MONITOR_EMAIL_TENANT_ID      — Azure AD tenant ID (GUID)
 *   - MONITOR_EMAIL_CLIENT_ID      — Azure AD app registration client ID (GUID)
 *   - MONITOR_EMAIL_CLIENT_SECRET  — Azure AD app registration client secret
 *   - MONITOR_EMAIL_ADDRESS        — shared mailbox (default: monitor@pecuniait.com)
 *   - NEXT_PUBLIC_APP_URL          — base URL of the app (for internal fetch to auto-fix)
 *   - JIRA_BASE_URL                — e.g. https://bizzassist.atlassian.net
 *   - JIRA_PROJECT_KEY             — e.g. BIZZ
 *   - JIRA_API_TOKEN               — Jira Cloud API token (Basic auth)
 *   - JIRA_USER_EMAIL              — email of the Jira user for Basic auth
 *   - RESEND_API_KEY               — for critical alert emails (optional — skips if missing)
 *
 * @module api/cron/monitor-email
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendCriticalAlert } from '@/lib/service-manager-alerts';
import { safeCompare } from '@/lib/safeCompare';
import {
  fetchUnreadEmails,
  markEmailAsRead,
  classifyEmail,
  type ClassifiedEmail,
  type GraphEmail,
} from '@/lib/monitorEmail';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';

/** Vercel Cron max duration (seconds) — Pro plan allows up to 300s */
export const maxDuration = 60;

/**
 * Maximum number of auto-fix triggers allowed per single cron run.
 * Prevents overwhelming the auto-fix endpoint when many CI failures arrive
 * simultaneously (e.g. after a bad push).
 */
const MAX_AUTO_FIX_TRIGGERS = 3;

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Verify the CRON_SECRET from the Authorization header only.
 * Query param fallback is not accepted (BIZZ-181).
 * In production, also verifies the x-vercel-cron: 1 header to prevent
 * external actors from triggering the cron endpoint directly.
 *
 * @param request - Incoming HTTP request.
 * @returns `true` if the request is authorised.
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

// ─── Activity logging ─────────────────────────────────────────────────────────

/**
 * Write an entry to the service_manager_activity audit log.
 * Non-fatal — failures are logged to console but do not abort the cron run.
 *
 * @param action  - Short action identifier string (e.g. 'email_classified').
 * @param details - Arbitrary JSON-serialisable details for the log entry.
 */
async function logActivity(action: string, details: Record<string, unknown>): Promise<void> {
  try {
    await createAdminClient().from('service_manager_activity').insert({
      action,
      details,
      created_by: null, // Cron — no user session
    });
  } catch (err) {
    logger.error('[monitor-email] activity log error:', err);
  }
}

// ─── Supabase scan record ─────────────────────────────────────────────────────

/**
 * Persist a service_manager_scan record for an email-triggered scan.
 * Returns the generated scan UUID, or null if the insert failed.
 *
 * @param category      - Email category (used as context in the summary).
 * @param subject       - Original email subject line.
 * @param senderAddress - Sender email address.
 * @param issueMessage  - Human-readable issue description extracted from the email.
 * @returns Scan UUID string, or null on failure.
 */
async function createEmailScanRecord(
  category: string,
  subject: string,
  senderAddress: string,
  issueMessage: string
): Promise<string | null> {
  const admin = createAdminClient();

  const issue = {
    type: category === 'vercel_deploy_failure' ? 'build_error' : 'runtime_error',
    severity: 'error',
    message: issueMessage,
    source: category === 'vercel_deploy_failure' ? 'vercel_build' : 'vercel_logs',
    context: `Email fra ${senderAddress} — Emne: ${subject}`,
  };

  const { data, error } = await admin
    .from('service_manager_scans')
    .insert({
      scan_type: 'email_trigger',
      status: 'completed',
      triggered_by: null,
      issues_found: [issue],
      summary: `Email-trigger: ${category} — ${subject}`,
    })
    .select('id')
    .single();

  if (error || !data) {
    logger.error('[monitor-email] Kunne ikke oprette scan-record:', error?.message);
    return null;
  }

  return data.id as string;
}

// ─── Auto-fix trigger ─────────────────────────────────────────────────────────

/**
 * Trigger the auto-fix workflow by POSTing to the internal auto-fix endpoint.
 * The fix proposal is stored as 'proposed' — admin approval is always required.
 *
 * @param scanId     - UUID of the scan record to generate a fix for.
 * @param issueIndex - Index of the issue within the scan (always 0 for email scans).
 * @returns `true` if the auto-fix endpoint accepted the request.
 */
async function triggerAutoFix(scanId: string, issueIndex: number): Promise<boolean> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk';
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    logger.warn('[monitor-email] CRON_SECRET ikke sat — kan ikke kalde auto-fix internt');
    return false;
  }

  const url = `${appUrl}/api/admin/service-manager/auto-fix`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Use CRON_SECRET as bearer — the auto-fix endpoint uses admin auth, but
        // the service-scan cron already calls it the same way. The endpoint
        // validates the caller via Supabase admin client (server-side only).
        Authorization: `Bearer ${cronSecret}`,
        // Mark as internal cron call so the route can identify the trigger source
        'x-internal-cron': '1',
      },
      body: JSON.stringify({ scanId, issueIndex }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error(`[monitor-email] auto-fix endpoint returnerede HTTP ${res.status}: ${body}`);
      return false;
    }

    return true;
  } catch (err) {
    logger.error('[monitor-email] triggerAutoFix fejlede:', err);
    return false;
  }
}

// ─── JIRA ticket creation ─────────────────────────────────────────────────────

/**
 * Create a JIRA ticket for a security alert email.
 * Security alerts are NEVER auto-fixed — they always require human review.
 *
 * Requires env vars: JIRA_BASE_URL, JIRA_PROJECT_KEY, JIRA_API_TOKEN, JIRA_USER_EMAIL.
 * Silently skips if any are missing.
 *
 * @param classified - The classified security alert email.
 * @returns The created JIRA issue key (e.g. "BIZZ-205"), or null on failure.
 */
async function createJiraSecurityTicket(classified: ClassifiedEmail): Promise<string | null> {
  const jiraBase = process.env.JIRA_BASE_URL;
  const projectKey = process.env.JIRA_PROJECT_KEY;
  const apiToken = process.env.JIRA_API_TOKEN;
  const userEmail = process.env.JIRA_USER_EMAIL;

  if (!jiraBase || !projectKey || !apiToken || !userEmail) {
    logger.warn(
      '[monitor-email] JIRA env vars mangler — sikkerhedsalert-ticket springes over. ' +
        'Sæt JIRA_BASE_URL, JIRA_PROJECT_KEY, JIRA_API_TOKEN og JIRA_USER_EMAIL.'
    );
    return null;
  }

  const { email, metadata } = classified;
  const summary = `[Sikkerhedsalert] ${email.subject}`;
  const repoLine = metadata.repo ? `\n*Repository:* ${metadata.repo}` : '';
  const description = [
    `*Email-emne:* ${email.subject}`,
    `*Afsender:* ${metadata.senderAddress ?? email.from?.emailAddress?.address ?? 'ukendt'}`,
    `*Modtaget:* ${email.receivedDateTime}`,
    repoLine,
    '',
    '*Email-indhold (uddrag):*',
    '{{' + (metadata.errorSummary ?? '(ingen indhold)').slice(0, 1500) + '}}',
  ]
    .join('\n')
    .trim();

  const body = {
    fields: {
      project: { key: projectKey },
      summary,
      description,
      issuetype: { name: 'Bug' },
      priority: { name: 'High' },
      labels: ['sikkerhed', 'email-trigger', 'dependabot'],
    },
  };

  const credentials = Buffer.from(`${userEmail}:${apiToken}`).toString('base64');

  try {
    const res = await fetch(`${jiraBase}/rest/api/2/issue`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      logger.error(
        `[monitor-email] JIRA ticket-oprettelse mislykkedes: HTTP ${res.status} — ${errText}`
      );
      return null;
    }

    const data = (await res.json()) as { key: string };
    logger.log(`[monitor-email] JIRA ticket oprettet: ${data.key}`);
    return data.key ?? null;
  } catch (err) {
    logger.error('[monitor-email] createJiraSecurityTicket fejlede:', err);
    return null;
  }
}

// ─── Per-email processing ─────────────────────────────────────────────────────

/**
 * Summary record for a single processed email — returned in the cron response.
 */
interface ProcessedEmailSummary {
  /** Graph message ID */
  messageId: string;
  /** Email subject */
  subject: string;
  /** Determined category */
  category: string;
  /** Action taken */
  action: 'auto_fix_triggered' | 'jira_ticket_created' | 'critical_alert_sent' | 'skipped';
  /** Scan UUID if a scan record was created */
  scanId?: string;
  /** JIRA issue key if a ticket was created */
  jiraKey?: string;
}

/**
 * Process a single classified email and take the appropriate action:
 *   - github_ci_failure    → create scan record + trigger auto-fix (if under rate limit)
 *   - vercel_deploy_failure → create scan record + trigger auto-fix (if under rate limit)
 *   - security_alert       → create JIRA ticket + log activity
 *   - uptime_alert         → send critical alert email
 *   - unknown              → skip (do not mark as read)
 *
 * @param classified     - Classified email to process.
 * @param autoFixCount   - Current number of auto-fix triggers in this cron run (mutated via ref).
 * @param autoFixCounter - Object holding the mutable counter (pass by reference pattern).
 * @returns Summary record describing what was done.
 */
async function processEmail(
  classified: ClassifiedEmail,
  autoFixCounter: { count: number }
): Promise<ProcessedEmailSummary> {
  const { email, category, metadata } = classified;
  const base: Omit<ProcessedEmailSummary, 'action'> = {
    messageId: email.id,
    subject: email.subject,
    category,
  };

  // ── Unknown — skip silently ───────────────────────────────────────────────
  if (category === 'unknown') {
    return { ...base, action: 'skipped' };
  }

  // ── GitHub CI failure ─────────────────────────────────────────────────────
  if (category === 'github_ci_failure') {
    const issueMessage = metadata.workflowName
      ? `GitHub CI fejlede: "${metadata.workflowName}"${metadata.repo ? ` (${metadata.repo})` : ''}`
      : `GitHub CI fejlede: ${email.subject}`;

    const scanId = await createEmailScanRecord(
      category,
      email.subject,
      metadata.senderAddress ?? '',
      issueMessage
    );

    if (scanId) {
      await logActivity('email_ci_failure_detected', {
        scan_id: scanId,
        repo: metadata.repo,
        workflow: metadata.workflowName,
        run_url: metadata.runUrl,
        subject: email.subject,
      });

      // Trigger auto-fix only if under rate limit
      if (autoFixCounter.count < MAX_AUTO_FIX_TRIGGERS) {
        const triggered = await triggerAutoFix(scanId, 0);
        if (triggered) {
          autoFixCounter.count++;
          await logActivity('auto_fix_triggered_from_email', {
            scan_id: scanId,
            category,
            subject: email.subject,
            auto_fix_count: autoFixCounter.count,
            triggered_by: 'monitor-email-cron',
          });
          return { ...base, action: 'auto_fix_triggered', scanId };
        }
      } else {
        logger.warn(
          `[monitor-email] Rate-limit nået (${MAX_AUTO_FIX_TRIGGERS}) — ` +
            `auto-fix springes over for: ${email.subject}`
        );
      }
    }

    return { ...base, action: 'skipped', scanId: scanId ?? undefined };
  }

  // ── Vercel deploy failure ─────────────────────────────────────────────────
  if (category === 'vercel_deploy_failure') {
    const issueMessage = metadata.vercelProject
      ? `Vercel deployment fejlede: "${metadata.vercelProject}" (${metadata.errorType ?? 'deploy_failure'})`
      : `Vercel deployment fejlede: ${email.subject}`;

    const scanId = await createEmailScanRecord(
      category,
      email.subject,
      metadata.senderAddress ?? '',
      issueMessage
    );

    if (scanId) {
      await logActivity('email_deploy_failure_detected', {
        scan_id: scanId,
        project: metadata.vercelProject,
        deployment_url: metadata.deploymentUrl,
        error_type: metadata.errorType,
        subject: email.subject,
      });

      if (autoFixCounter.count < MAX_AUTO_FIX_TRIGGERS) {
        const triggered = await triggerAutoFix(scanId, 0);
        if (triggered) {
          autoFixCounter.count++;
          await logActivity('auto_fix_triggered_from_email', {
            scan_id: scanId,
            category,
            subject: email.subject,
            auto_fix_count: autoFixCounter.count,
            triggered_by: 'monitor-email-cron',
          });
          return { ...base, action: 'auto_fix_triggered', scanId };
        }
      } else {
        logger.warn(
          `[monitor-email] Rate-limit nået (${MAX_AUTO_FIX_TRIGGERS}) — ` +
            `auto-fix springes over for: ${email.subject}`
        );
      }
    }

    return { ...base, action: 'skipped', scanId: scanId ?? undefined };
  }

  // ── Security alert — JIRA ticket only, no auto-fix ────────────────────────
  if (category === 'security_alert') {
    const jiraKey = await createJiraSecurityTicket(classified);

    await logActivity('email_security_alert_detected', {
      jira_key: jiraKey,
      repo: metadata.repo,
      subject: email.subject,
      sender: metadata.senderAddress,
      auto_fix_triggered: false, // intentional — security issues require human review
    });

    return { ...base, action: 'jira_ticket_created', jiraKey: jiraKey ?? undefined };
  }

  // ── Uptime alert — send critical alert email ──────────────────────────────
  if (category === 'uptime_alert') {
    // Create a synthetic scanId string for the alert (no real scan record needed)
    const pseudoScanId = `email-uptime-${Date.now()}`;

    await sendCriticalAlert({
      description: email.subject,
      affectedPath: undefined,
      scanId: pseudoScanId,
      issueType: 'runtime_error',
      context: `Email-uptime-alert fra ${metadata.senderAddress ?? 'ukendt afsender'}`,
      detectedAt: new Date(email.receivedDateTime),
    });

    await logActivity('email_uptime_alert_detected', {
      subject: email.subject,
      sender: metadata.senderAddress,
      received_at: email.receivedDateTime,
    });

    return { ...base, action: 'critical_alert_sent' };
  }

  // Fallback (should not be reached given exhaustive category handling above)
  return { ...base, action: 'skipped' };
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * GET /api/cron/monitor-email
 *
 * Reads unread emails from the monitor@pecuniait.com shared mailbox,
 * classifies them, triggers appropriate workflows, and marks them as read.
 *
 * Triggered by Vercel Cron (every 5 minutes) or manually with
 * Authorization: Bearer <CRON_SECRET>.
 *
 * Returns a JSON summary of processed emails and actions taken.
 *
 * @param request - Incoming HTTP request.
 * @returns JSON summary of the email monitoring run.
 */
export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // BIZZ-621 + BIZZ-624: heartbeat + Sentry cron-monitoring.
  return withCronMonitor(
    { jobName: 'monitor-email', schedule: '*/5 * * * *', intervalMinutes: 5 },
    async () => {
      try {
        const now = new Date();
        logger.log(`[monitor-email] Cron startet kl. ${now.toISOString()}`);

        // ── Early exit if Graph API credentials are missing ───────────────────────
        const missingVars = (
          [
            'MONITOR_EMAIL_TENANT_ID',
            'MONITOR_EMAIL_CLIENT_ID',
            'MONITOR_EMAIL_CLIENT_SECRET',
          ] as const
        ).filter((key) => !process.env[key]);

        if (missingVars.length > 0) {
          logger.warn(
            `[monitor-email] Manglende env vars: ${missingVars.join(', ')} — cron afslutter tidligt.`
          );
          return NextResponse.json({
            ok: true,
            skipped: true,
            reason: `Manglende env vars: ${missingVars.join(', ')}`,
            processed: 0,
          });
        }

        // ── 1. Fetch unread emails ────────────────────────────────────────────────
        let emails: GraphEmail[];
        try {
          emails = await fetchUnreadEmails(20);
        } catch (err) {
          logger.error('[monitor-email] fetchUnreadEmails kastede en fejl:', err);
          return NextResponse.json(
            {
              ok: false,
              error: 'Kunne ikke hente emails fra mailboxen',
            },
            { status: 500 }
          );
        }

        if (emails.length === 0) {
          logger.log('[monitor-email] Ingen ulæste emails fundet — cron afsluttes.');
          return NextResponse.json({ ok: true, processed: 0, emails: [] });
        }

        logger.log(
          `[monitor-email] ${emails.length} ulæst(e) email(s) fundet — starter klassificering`
        );

        // ── 2. Classify all emails ────────────────────────────────────────────────
        const classified = emails.map((email) => classifyEmail(email));

        // Log classification summary
        const categoryCounts = classified.reduce<Record<string, number>>((acc, c) => {
          acc[c.category] = (acc[c.category] ?? 0) + 1;
          return acc;
        }, {});
        logger.log('[monitor-email] Klassificering:', categoryCounts);

        // ── 3. Process each actionable email ─────────────────────────────────────
        const autoFixCounter = { count: 0 };
        const results: ProcessedEmailSummary[] = [];
        const toMarkAsRead: string[] = [];

        for (const c of classified) {
          // Skip unknown emails — do not mark as read so they can be reviewed manually
          if (c.category === 'unknown') {
            results.push({
              messageId: c.email.id,
              subject: c.email.subject,
              category: 'unknown',
              action: 'skipped',
            });
            continue;
          }

          try {
            const summary = await processEmail(c, autoFixCounter);
            results.push(summary);
            // Mark as read regardless of whether action succeeded — prevents infinite retries
            toMarkAsRead.push(c.email.id);
          } catch (err) {
            logger.error(`[monitor-email] processEmail fejlede for "${c.email.subject}":`, err);
            // Still mark as read to avoid re-processing a broken email on every tick
            toMarkAsRead.push(c.email.id);
            results.push({
              messageId: c.email.id,
              subject: c.email.subject,
              category: c.category,
              action: 'skipped',
            });
          }
        }

        // ── 4. Mark processed emails as read ─────────────────────────────────────
        const markResults = await Promise.allSettled(toMarkAsRead.map((id) => markEmailAsRead(id)));
        const markedCount = markResults.filter(
          (r) => r.status === 'fulfilled' && r.value === true
        ).length;

        logger.log(
          `[monitor-email] Markerede ${markedCount}/${toMarkAsRead.length} emails som læst`
        );

        // ── 5. Log overall run summary ────────────────────────────────────────────
        const actionCounts = results.reduce<Record<string, number>>((acc, r) => {
          acc[r.action] = (acc[r.action] ?? 0) + 1;
          return acc;
        }, {});

        await logActivity('monitor_email_cron_completed', {
          emails_fetched: emails.length,
          emails_classified: classified.length,
          emails_marked_read: markedCount,
          auto_fix_triggers: autoFixCounter.count,
          category_counts: categoryCounts,
          action_counts: actionCounts,
          run_at: now.toISOString(),
        });

        logger.log(
          `[monitor-email] Done: ${emails.length} emails, ` +
            `${autoFixCounter.count} auto-fix triggers, ` +
            `${markedCount} markeret læst`
        );

        return NextResponse.json({
          ok: true,
          processed: classified.length,
          markedAsRead: markedCount,
          autoFixTriggered: autoFixCounter.count,
          categoryCounts,
          actionCounts,
          emails: results,
        });
      } catch (err) {
        logger.error('[monitor-email] Uventet fejl i cron-handler:', err);
        return NextResponse.json(
          {
            ok: false,
            error: 'Internal server error',
            message: err instanceof Error ? err.message : String(err),
          },
          { status: 500 }
        );
      }
    }
  );
}
