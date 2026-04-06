/**
 * Cron: Service Manager Autonomous Scan — /api/cron/service-scan
 *
 * Runs every hour as a Vercel Cron job. Autonomously scans for errors and
 * proposes AI-generated fixes — all fixes remain pending until admin approval.
 *
 * Flow:
 *   1. Vercel Cron fires every hour (0 * * * *)
 *   2. Runs bug scan (Vercel deployments + runtime error logs)
 *   3. Creates a scan record (scan_type: 'scheduled') in service_manager_scans
 *   4. For each new error-severity issue (max 2 per run), calls Claude to
 *      propose a minimal fix and stores it as 'proposed' in service_manager_fixes
 *   5. Logs all activity to service_manager_activity
 *   6. Sends an alert email to support@pecuniait.com if new issues were found
 *
 * Safety guarantees (non-negotiable):
 *   - Fixes are NEVER applied automatically — all require admin approval
 *   - Max 2 fix proposals per cron run (respects 30-second maxDuration)
 *   - Duplicate detection: skips issues that already have an active fix proposal
 *   - Fix safety guards: same constraints as the manual auto-fix endpoint
 *     (max 50 lines changed, blocked patterns, bug-fix/config-fix only)
 *
 * Auth: CRON_SECRET Bearer token (Vercel Cron) or ?secret= query param (manual test)
 *
 * Env vars required:
 *   - CRON_SECRET         — shared secret for this endpoint
 *   - VERCEL_TOKEN        — Vercel API token for deployment/log access
 *   - VERCEL_PROJECT_ID   — Vercel project ID
 *   - VERCEL_TEAM_ID      — (optional) Vercel team ID
 *   - BIZZASSIST_CLAUDE_KEY — Anthropic API key for fix proposals
 *   - RESEND_API_KEY      — Resend API key for alert emails
 *   - NEXT_PUBLIC_APP_URL — Base URL of the app (for admin panel link in email)
 *
 * @module api/cron/service-scan
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendCriticalAlert, isCriticalIssue } from '@/lib/service-manager-alerts';

/** Vercel Cron max duration (seconds) — Hobby plan limit */
export const maxDuration = 30;

/** Resend API endpoint */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const FROM_ADDRESS = 'BizzAssist <noreply@bizzassist.dk>';
const TO_ADDRESS = 'support@pecuniait.com';

/** Base URL for the Vercel REST API */
const VERCEL_API = 'https://api.vercel.com';

/**
 * Maximum number of fix proposals to generate per cron run.
 * Caps total Claude API time to stay within maxDuration.
 */
const MAX_FIX_PROPOSALS_PER_RUN = 2;

/**
 * Maximum lines changed (additions + deletions) allowed in a proposed fix.
 * Mirrors the constraint in the manual auto-fix endpoint.
 */
const MAX_LINES_CHANGED = 50;

/**
 * Diff patterns that indicate new functionality rather than bug fixes.
 * Matches cause automatic rejection of the proposed fix.
 */
const BLOCKED_DIFF_PATTERNS: RegExp[] = [
  /^\+{1,3}.*\bnew\s+file\b/im,
  /^\+{1,3}\s*export\s+(default\s+)?function\s+\w+Page\s*\(/im,
  /^\+{1,3}\s*export\s+(default\s+)?function\s+\w+Layout\s*\(/im,
  /^\+{1,3}\s*(?:const|let|var)\s+\w+Route\b/im,
  /^\+{1,3}\s*createPage\s*\(/im,
  /^\+{1,3}\s*app\.(?:get|post|put|delete|patch)\s*\(/im,
];

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single issue found during a scan — mirrors ScanIssue from service-manager/route.ts */
interface ScanIssue {
  type: 'build_error' | 'runtime_error' | 'type_error' | 'config_error';
  severity: 'error' | 'warning';
  message: string;
  source: 'vercel_build' | 'vercel_logs' | 'static';
  context?: string;
}

/** A Vercel deployment record — minimal shape used by this cron */
interface VercelDeployment {
  uid: string;
  state: 'READY' | 'ERROR' | 'BUILDING' | 'CANCELED' | 'QUEUED' | string;
  target: 'production' | 'preview' | null;
  meta: {
    githubCommitRef?: string;
    githubCommitMessage?: string;
    githubCommitAuthorName?: string;
  };
}

/** A single Vercel deployment event */
interface VercelEvent {
  type: string;
  created: number;
  payload: {
    text?: string;
    name?: string;
    entrypoint?: string;
    statusCode?: number;
  };
}

/** Structured fix proposal returned by Claude */
interface ClaudeFixResponse {
  /** Relative path to the file that needs to be changed */
  file_path: string;
  /** Unified diff in standard patch format */
  proposed_diff: string;
  /** Fix classification — rejected if unsafe */
  classification: 'bug-fix' | 'config-fix' | 'rejected';
  /** 1-3 sentence explanation */
  reasoning: string;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

/**
 * Verify the CRON_SECRET from the Authorization header (Vercel Cron)
 * or the ?secret= query parameter (manual test).
 *
 * @param request - Incoming HTTP request
 * @returns true if the secret is valid
 */
function verifyCronSecret(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

// ─── Vercel API helpers ───────────────────────────────────────────────────────

/**
 * Build standard Vercel API request headers.
 *
 * @returns Headers object with Bearer auth token.
 */
function vercelHeaders(): HeadersInit {
  return { Authorization: `Bearer ${process.env.VERCEL_TOKEN ?? ''}` };
}

/**
 * Build Vercel API query params, including optional teamId.
 *
 * @param extra - Additional params to merge in.
 * @returns URLSearchParams string ready to append to a URL.
 */
function vercelParams(extra: Record<string, string> = {}): string {
  const p: Record<string, string> = { ...extra };
  if (process.env.VERCEL_TEAM_ID) p.teamId = process.env.VERCEL_TEAM_ID;
  return new URLSearchParams(p).toString();
}

/**
 * Fetch the most recent deployments for the configured Vercel project.
 *
 * @returns Array of deployments, or null on error.
 */
async function getDeployments(): Promise<VercelDeployment[] | null> {
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!projectId) return null;

  try {
    const qs = vercelParams({ projectId, limit: '10' });
    const res = await fetch(`${VERCEL_API}/v6/deployments?${qs}`, {
      headers: vercelHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.deployments ?? []) as VercelDeployment[];
  } catch {
    return null;
  }
}

/**
 * Fetch function error events from a specific Vercel deployment.
 *
 * @param deploymentId - The Vercel deployment UID.
 * @returns Array of error events, or empty array on failure.
 */
async function getDeploymentErrors(deploymentId: string): Promise<VercelEvent[]> {
  try {
    const qs = vercelParams({ direction: 'backward', limit: '100' });
    const res = await fetch(`${VERCEL_API}/v2/deployments/${deploymentId}/events?${qs}`, {
      headers: vercelHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const events: VercelEvent[] = await res.json();
    return events.filter(
      (e) => e.type === 'error' || (e.payload?.statusCode && e.payload.statusCode >= 500)
    );
  } catch {
    return [];
  }
}

// ─── Scan logic ───────────────────────────────────────────────────────────────

/**
 * Run all scan checks and aggregate issues.
 *
 * Checks performed:
 *   1. Vercel credential presence (config_error if missing)
 *   2. Failed Vercel deployments (build_error)
 *   3. Runtime errors in the most recent production deployment (runtime_error)
 *
 * @returns Object with issues array and human-readable summary.
 */
async function runScan(): Promise<{ issues: ScanIssue[]; summary: string }> {
  const issues: ScanIssue[] = [];

  // ── 1. Check credentials ──────────────────────────────────────────────────
  const hasVercelToken = !!process.env.VERCEL_TOKEN;
  const hasProjectId = !!process.env.VERCEL_PROJECT_ID;

  if (!hasVercelToken || !hasProjectId) {
    issues.push({
      type: 'config_error',
      severity: 'warning',
      message: 'Vercel-legitimationsoplysninger mangler',
      source: 'static',
      context: [
        !hasVercelToken ? 'VERCEL_TOKEN ikke sat' : null,
        !hasProjectId ? 'VERCEL_PROJECT_ID ikke sat' : null,
      ]
        .filter(Boolean)
        .join(', '),
    });
    return {
      issues,
      summary:
        'Scan afbrudt: manglende Vercel-konfiguration. Tilføj VERCEL_TOKEN og VERCEL_PROJECT_ID i miljøvariabler.',
    };
  }

  // ── 2. Check recent deployments for build failures ────────────────────────
  const deployments = await getDeployments();

  if (!deployments) {
    issues.push({
      type: 'config_error',
      severity: 'warning',
      message: 'Kunne ikke hente Vercel-deployments',
      source: 'vercel_build',
      context: 'Vercel API returnerede fejl. Tjek at VERCEL_TOKEN er gyldigt.',
    });
  } else {
    const failedBuilds = deployments.filter((d) => d.state === 'ERROR');
    for (const d of failedBuilds) {
      issues.push({
        type: 'build_error',
        severity: 'error',
        message: `Build fejlede: ${d.meta?.githubCommitMessage ?? d.uid}`,
        source: 'vercel_build',
        context: [
          d.meta?.githubCommitRef ? `Branch: ${d.meta.githubCommitRef}` : null,
          d.meta?.githubCommitAuthorName ? `Af: ${d.meta.githubCommitAuthorName}` : null,
          `Deployment: ${d.uid}`,
        ]
          .filter(Boolean)
          .join(' · '),
      });
    }

    // ── 3. Check runtime errors in the latest production deployment ──────────
    const latestProd = deployments.find((d) => d.target === 'production' && d.state === 'READY');
    if (latestProd) {
      const errorEvents = await getDeploymentErrors(latestProd.uid);
      const seen = new Set<string>();
      for (const ev of errorEvents) {
        const msg = ev.payload?.text ?? ev.payload?.name ?? 'Ukendt runtime-fejl';
        if (seen.has(msg)) continue;
        seen.add(msg);
        issues.push({
          type: 'runtime_error',
          severity: 'error',
          message: msg,
          source: 'vercel_logs',
          context: ev.payload?.entrypoint ? `Funktion: ${ev.payload.entrypoint}` : undefined,
        });
      }
    }
  }

  // ── 4. Build summary ──────────────────────────────────────────────────────
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;

  let summary: string;
  if (issues.length === 0) {
    summary = 'Ingen problemer fundet. Systemet ser ud til at køre korrekt.';
  } else {
    const parts: string[] = [];
    if (errors > 0) parts.push(`${errors} fejl`);
    if (warnings > 0) parts.push(`${warnings} advarsler`);
    summary = `Fandt ${parts.join(' og ')}.`;
  }

  return { issues, summary };
}

// ─── Fix proposal helpers ─────────────────────────────────────────────────────

/**
 * Count the number of changed lines (+/-) in a unified diff string.
 * Ignores diff header lines (---/+++ /@@).
 *
 * @param diff - Unified diff string.
 * @returns Total count of added + removed lines.
 */
function countChangedLines(diff: string): number {
  return diff
    .split('\n')
    .filter(
      (line) =>
        (line.startsWith('+') || line.startsWith('-')) &&
        !line.startsWith('---') &&
        !line.startsWith('+++')
    ).length;
}

/**
 * Check if a diff contains any blocked patterns indicating new functionality.
 *
 * @param diff - Unified diff string.
 * @returns Matched pattern description, or null if safe.
 */
function findBlockedPattern(diff: string): string | null {
  for (const pattern of BLOCKED_DIFF_PATTERNS) {
    if (pattern.test(diff)) {
      return `Blocked pattern matched: ${pattern.source}`;
    }
  }
  return null;
}

/**
 * Ask Claude to identify the affected file and propose a minimal fix for a
 * scan issue using a single API call (combined identification + fix generation).
 *
 * @param issue - The ScanIssue to fix.
 * @param summary - Overall scan summary for context.
 * @returns Structured fix response from Claude.
 */
async function proposeFixWithClaude(issue: ScanIssue, summary: string): Promise<ClaudeFixResponse> {
  const anthropic = new Anthropic({ apiKey: process.env.BIZZASSIST_CLAUDE_KEY ?? '' });

  const prompt = `You are a software bug-fix assistant for the BizzAssist Next.js application.
A scheduled production scan found the following issue:

Issue type: ${issue.type}
Severity: ${issue.severity}
Message: ${issue.message}
Source: ${issue.source}
Context: ${issue.context ?? 'none'}
Scan summary: ${summary}

The project uses:
- Next.js 16 App Router (TypeScript)
- Supabase
- Tailwind CSS v4
- Source files are under: app/, lib/, components/

CRITICAL RULES (violations cause automatic rejection):
1. Change EXACTLY ONE file
2. Change at most ${MAX_LINES_CHANGED} lines total (additions + deletions)
3. NEVER add new exports, new React components, new pages, or new API routes
4. NEVER change CSS classes, colours, layout, or any UI-facing properties
5. ONLY fix the specific error described — do not "improve" surrounding code

Respond with ONLY a JSON object — no markdown wrapper, no explanation outside the JSON:
{
  "file_path": "<relative path from project root, e.g. app/api/foo/route.ts>",
  "proposed_diff": "<unified diff in standard patch format, or empty string if no safe fix possible>",
  "classification": "<'bug-fix' | 'config-fix' | 'rejected'>",
  "reasoning": "<1-3 sentence explanation of the fix, or why it is rejected>"
}

Classification rules:
- 'bug-fix': corrects wrong logic, null checks, type errors, import errors
- 'config-fix': fixes environment variable usage, configuration values, headers
- 'rejected': would require adding features, changing UI, or is too complex to safely fix in ≤${MAX_LINES_CHANGED} lines

If you cannot produce a safe, minimal fix → classify as 'rejected' and explain why.`;

  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  try {
    const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();
    const result = JSON.parse(cleaned) as ClaudeFixResponse;
    if (!['bug-fix', 'config-fix', 'rejected'].includes(result.classification)) {
      result.classification = 'rejected';
      result.reasoning = `Invalid classification from Claude: ${result.classification}. Original: ${result.reasoning}`;
    }
    return result;
  } catch {
    return {
      file_path: '',
      proposed_diff: '',
      classification: 'rejected',
      reasoning: `Claude did not return valid JSON. Raw response: ${text.slice(0, 200)}`,
    };
  }
}

// ─── Activity logging ─────────────────────────────────────────────────────────

/**
 * Write an entry to the service_manager_activity audit log.
 * Failures are non-fatal — the cron continues even if logging fails.
 *
 * @param action - Action identifier string.
 * @param details - Arbitrary JSON details for the log entry.
 */
async function logActivity(action: string, details: Record<string, unknown>): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (createAdminClient() as any).from('service_manager_activity').insert({
      action,
      details,
      created_by: null, // Cron runs without a user session
    });
  } catch (err) {
    console.error('[service-scan] activity log error:', err);
  }
}

// ─── Email alert ──────────────────────────────────────────────────────────────

/**
 * Build the HTML alert email body for new scan issues.
 * Matches the BizzAssist design system (navy background, blue accent).
 *
 * @param issues - All issues found in this scan.
 * @param scanId - The UUID of the scan record.
 * @param proposedFixCount - Number of fix proposals generated.
 * @param now - Timestamp of this scan run.
 * @returns HTML string ready to send.
 */
function buildAlertHtml(
  issues: ScanIssue[],
  scanId: string,
  proposedFixCount: number,
  now: Date
): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bizzassist.dk';
  const adminUrl = `${appUrl}/dashboard/admin/service-manager`;

  const datetimeStr = now.toLocaleString('da-DK', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Copenhagen',
  });

  const issueRows = issues
    .map((issue) => {
      const severityColor = issue.severity === 'error' ? '#ef4444' : '#f59e0b';
      const typeLabel =
        issue.type === 'build_error'
          ? 'Build-fejl'
          : issue.type === 'runtime_error'
            ? 'Runtime-fejl'
            : issue.type === 'config_error'
              ? 'Konfigurationsfejl'
              : 'Type-fejl';

      return `
        <tr>
          <td style="padding: 10px 14px; border-bottom: 1px solid #0f172a;">
            <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: ${severityColor}22; color: ${severityColor}; text-transform: uppercase; letter-spacing: 0.05em;">${typeLabel}</span>
            <div style="margin-top: 6px; color: #e2e8f0; font-size: 13px; line-height: 1.5;">${issue.message}</div>
            ${issue.context ? `<div style="margin-top: 4px; color: #94a3b8; font-size: 11px;">${issue.context}</div>` : ''}
          </td>
        </tr>`;
    })
    .join('');

  return `
<!DOCTYPE html>
<html lang="da">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 20px; background: #060d1a;">
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #e2e8f0; padding: 36px; border-radius: 12px; border: 1px solid #1e293b;">

  <!-- Header -->
  <div style="margin-bottom: 28px; padding-bottom: 20px; border-bottom: 1px solid #1e293b;">
    <h1 style="color: #ffffff; font-size: 20px; margin: 0 0 4px 0; font-weight: 700;">BizzAssist</h1>
    <p style="color: #64748b; font-size: 12px; margin: 0 0 16px 0;">Service Manager Agent</p>
    <div style="display: flex; align-items: center; gap: 10px;">
      <div style="width: 10px; height: 10px; border-radius: 50%; background: #ef4444; flex-shrink: 0;"></div>
      <h2 style="color: #ef4444; font-size: 18px; margin: 0; font-weight: 600;">${issues.length} ny${issues.length === 1 ? '' : 'e'} fejl fundet</h2>
    </div>
    <p style="color: #94a3b8; font-size: 13px; margin: 8px 0 0 0;">${datetimeStr}</p>
  </div>

  <!-- Issues -->
  <div style="margin-bottom: 24px;">
    <h3 style="color: #94a3b8; font-size: 11px; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">Fundne problemer</h3>
    <div style="background: #1e293b; border-radius: 8px; overflow: hidden;">
      <table style="width: 100%; border-collapse: collapse;">
        <tbody>${issueRows}</tbody>
      </table>
    </div>
  </div>

  <!-- Fix proposals -->
  <div style="margin-bottom: 28px; background: #162032; border-radius: 8px; padding: 16px;">
    <p style="margin: 0; color: #94a3b8; font-size: 13px; line-height: 1.6;">
      <strong style="color: #e2e8f0;">${proposedFixCount}</strong> automatiske fix-forslag er genereret og klar til gennemsyn.
      Alle fixes kræver din godkendelse, f&oslash;r de anvendes.
    </p>
    <p style="margin: 8px 0 0 0; color: #64748b; font-size: 11px;">Scan-ID: ${scanId}</p>
  </div>

  <!-- CTA -->
  <div style="text-align: center; margin-bottom: 28px;">
    <a href="${adminUrl}" style="display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 14px; padding: 12px 28px; border-radius: 8px;">
      Gennemse i Admin Panel
    </a>
  </div>

  <!-- Footer -->
  <hr style="border: none; border-top: 1px solid #1e293b; margin: 0 0 16px 0;" />
  <p style="color: #475569; font-size: 11px; margin: 0; line-height: 1.6;">
    BizzAssist &mdash; Pecunia IT ApS &mdash; S&oslash;byvej 11, 2650 Hvidovre &mdash; CVR 44718502<br/>
    Automatisk alert fra Service Manager Agent &mdash; m&aring; ikke videresendes
  </p>

</div>
</body>
</html>`;
}

/**
 * Send an alert email via Resend when new scan issues are found.
 * Silently skips if RESEND_API_KEY is not configured (dev environment).
 *
 * @param issues - All issues found in this scan.
 * @param scanId - The UUID of the scan record.
 * @param proposedFixCount - Number of fix proposals generated.
 * @param now - Timestamp of this scan run.
 */
async function sendAlertEmail(
  issues: ScanIssue[],
  scanId: string,
  proposedFixCount: number,
  now: Date
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log('[service-scan] RESEND_API_KEY ikke sat — alert-email springes over');
    return;
  }

  const subject = `BizzAssist Service Manager \u2014 ${issues.length} ny${issues.length === 1 ? '' : 'e'} fejl fundet`;
  const html = buildAlertHtml(issues, scanId, proposedFixCount, now);

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
        subject,
        html,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('[service-scan] Resend API fejl:', res.status, body);
    } else {
      console.log('[service-scan] Alert-email sendt til', TO_ADDRESS);
    }
  } catch (err) {
    console.error('[service-scan] Kunne ikke sende alert-email:', err);
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * GET /api/cron/service-scan
 *
 * Hourly autonomous scan. Runs the bug scan, proposes fixes for new error-severity
 * issues, logs all activity, and sends an alert email if problems are found.
 *
 * Triggered by Vercel Cron ("0 * * * *") or manually via ?secret=<CRON_SECRET>.
 *
 * @param request - Incoming HTTP request
 * @returns JSON summary of the scan run
 */
export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  // ── 1. Run the bug scan ───────────────────────────────────────────────────
  let issues: ScanIssue[];
  let summary: string;
  let scanStatus: 'completed' | 'failed';

  try {
    const result = await runScan();
    issues = result.issues;
    summary = result.summary;
    scanStatus = 'completed';
  } catch (scanErr) {
    console.error('[service-scan] runScan threw:', scanErr);
    issues = [
      {
        type: 'config_error',
        severity: 'error',
        message: 'Scan afbrudt af uventet fejl',
        source: 'static',
        context: scanErr instanceof Error ? scanErr.message : 'Ukendt fejl',
      },
    ];
    summary = 'Scan mislykkedes pga. intern fejl.';
    scanStatus = 'failed';
  }

  // ── 2. Persist scan record ────────────────────────────────────────────────
  const { data: scanData, error: scanInsertErr } = await admin
    .from('service_manager_scans')
    .insert({
      scan_type: 'scheduled',
      status: scanStatus,
      triggered_by: null, // Cron — no user
      issues_found: issues,
      summary,
    })
    .select('id')
    .single();

  if (scanInsertErr || !scanData) {
    console.error('[service-scan] Kunne ikke oprette scan-record:', scanInsertErr?.message);
    return NextResponse.json({ error: 'Kunne ikke oprette scan-record' }, { status: 500 });
  }

  const scanId = scanData.id as string;

  await logActivity('scheduled_scan_completed', {
    scan_id: scanId,
    status: scanStatus,
    issue_count: issues.length,
    error_count: issues.filter((i) => i.severity === 'error').length,
    warning_count: issues.filter((i) => i.severity === 'warning').length,
  });

  // ── 3. Propose fixes for new error-severity issues ────────────────────────
  const errorIssues = issues.filter((i) => i.severity === 'error');
  let proposedFixCount = 0;
  const fixResults: { issueIndex: number; fixId: string; classification: string }[] = [];

  for (let idx = 0; idx < issues.length && proposedFixCount < MAX_FIX_PROPOSALS_PER_RUN; idx++) {
    const issue = issues[idx];
    if (issue.severity !== 'error') continue;

    // Skip if an active fix proposal already exists for this exact message
    // (prevents re-proposing the same fix on every hourly run)
    const { data: existingData } = await admin
      .from('service_manager_fixes')
      .select('id, status')
      .eq('issue_index', idx)
      .in('status', ['proposed', 'approved'])
      // Look for fixes from the last 48 hours with the same message
      .gte('created_at', new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString())
      .maybeSingle();

    if (existingData) {
      console.log(
        `[service-scan] Issue ${idx} already has active fix ${existingData.id} — skipping`
      );
      continue;
    }

    // Ask Claude to propose a fix
    let claudeResult: ClaudeFixResponse;
    try {
      claudeResult = await proposeFixWithClaude(issue, summary);
    } catch (aiErr) {
      console.error(`[service-scan] Claude API error for issue ${idx}:`, aiErr);
      continue;
    }

    // Apply safety guards
    let finalClassification = claudeResult.classification;
    let finalReasoning = claudeResult.reasoning;

    if (finalClassification !== 'rejected' && claudeResult.proposed_diff) {
      const lineCount = countChangedLines(claudeResult.proposed_diff);
      if (lineCount > MAX_LINES_CHANGED) {
        finalClassification = 'rejected';
        finalReasoning = `Afvist: ${lineCount} linjer ændret (maks ${MAX_LINES_CHANGED}). ${finalReasoning}`;
      }

      if (finalClassification !== 'rejected') {
        const blocked = findBlockedPattern(claudeResult.proposed_diff);
        if (blocked) {
          finalClassification = 'rejected';
          finalReasoning = `Afvist pga. blokeret mønster. ${blocked}. ${finalReasoning}`;
        }
      }
    }

    if (finalClassification !== 'rejected' && !claudeResult.proposed_diff.trim()) {
      finalClassification = 'rejected';
      finalReasoning = `Afvist: Claude returnerede et tomt diff. ${finalReasoning}`;
    }

    // Persist the fix proposal
    const { data: fixData, error: fixInsertErr } = await admin
      .from('service_manager_fixes')
      .insert({
        scan_id: scanId,
        issue_index: idx,
        file_path: claudeResult.file_path,
        proposed_diff: claudeResult.proposed_diff,
        classification: finalClassification,
        status: finalClassification === 'rejected' ? 'rejected' : 'proposed',
        claude_reasoning: finalReasoning,
        rejection_reason: finalClassification === 'rejected' ? finalReasoning : null,
      })
      .select('id, status, classification')
      .single();

    if (fixInsertErr || !fixData) {
      console.error('[service-scan] Kunne ikke gemme fix-forslag:', fixInsertErr?.message);
      continue;
    }

    fixResults.push({
      issueIndex: idx,
      fixId: fixData.id as string,
      classification: finalClassification,
    });

    await logActivity('auto_fix_proposed', {
      fix_id: fixData.id,
      scan_id: scanId,
      issue_index: idx,
      issue_type: issue.type,
      file_path: claudeResult.file_path,
      classification: finalClassification,
      lines_changed: claudeResult.proposed_diff ? countChangedLines(claudeResult.proposed_diff) : 0,
      triggered_by: 'cron',
    });

    if (finalClassification !== 'rejected') {
      proposedFixCount++;
    }
  }

  // ── 4. Send immediate critical alerts for high-severity issues ───────────
  // These fire before the general alert email so critical failures get
  // dedicated, immediately-actionable notifications with their own subject line.
  const criticalIssues = errorIssues.filter((issue) =>
    isCriticalIssue(issue.type, issue.message, issue.context)
  );

  for (const critical of criticalIssues) {
    await sendCriticalAlert({
      description: critical.message,
      affectedPath: critical.context?.includes('Funktion: ')
        ? critical.context.replace('Funktion: ', '')
        : undefined,
      scanId,
      issueType: critical.type,
      context: critical.context,
      detectedAt: now,
    });
  }

  // ── 5. Send general alert email if any error issues were found ────────────
  if (errorIssues.length > 0) {
    await sendAlertEmail(issues, scanId, proposedFixCount, now);
  }

  console.log(
    `[service-scan] Done: ${issues.length} issues, ${errorIssues.length} errors, ${proposedFixCount} fixes proposed`
  );

  return NextResponse.json({
    ok: true,
    scanId,
    issueCount: issues.length,
    errorCount: errorIssues.length,
    warningCount: issues.filter((i) => i.severity === 'warning').length,
    fixesProposed: proposedFixCount,
    fixes: fixResults,
    summary,
  });
}
