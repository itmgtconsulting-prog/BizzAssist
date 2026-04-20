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
 * Auth: Authorization: Bearer <CRON_SECRET> header only — query param not accepted (BIZZ-181)
 *
 * Env vars required:
 *   - CRON_SECRET         — shared secret for this endpoint
 *   - VERCEL_API_TOKEN        — Vercel API token for deployment/log access
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
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import { companyInfo } from '@/app/lib/companyInfo';
import { RESEND_ENDPOINT } from '@/app/lib/serviceEndpoints';

/** Vercel Cron max duration (seconds) — Hobby plan limit */
export const maxDuration = 30;
const FROM_ADDRESS = `BizzAssist <${companyInfo.noreplyEmail}>`;
const TO_ADDRESS = companyInfo.supportEmail;

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
 * Verify the CRON_SECRET from the Authorization header only.
 * Query param fallback is not accepted — BIZZ-181.
 *
 * @param request - Incoming HTTP request
 * @returns true if the secret is valid
 */
function verifyCronSecret(request: NextRequest): boolean {
  // In production, require Vercel's cron header to prevent external triggering
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return safeCompare(auth, `Bearer ${secret}`);
}

// ─── Vercel API helpers ───────────────────────────────────────────────────────

/**
 * Build standard Vercel API request headers.
 *
 * @returns Headers object with Bearer auth token.
 */
function vercelHeaders(): HeadersInit {
  return { Authorization: `Bearer ${process.env.VERCEL_API_TOKEN ?? ''}` };
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
  const hasVercelToken = !!process.env.VERCEL_API_TOKEN;
  const hasProjectId = !!process.env.VERCEL_PROJECT_ID;

  if (!hasVercelToken || !hasProjectId) {
    issues.push({
      type: 'config_error',
      severity: 'warning',
      message: 'Vercel-legitimationsoplysninger mangler',
      source: 'static',
      context: [
        !hasVercelToken ? 'VERCEL_API_TOKEN ikke sat' : null,
        !hasProjectId ? 'VERCEL_PROJECT_ID ikke sat' : null,
      ]
        .filter(Boolean)
        .join(', '),
    });
    return {
      issues,
      summary:
        'Scan afbrudt: manglende Vercel-konfiguration. Tilføj VERCEL_API_TOKEN og VERCEL_PROJECT_ID i miljøvariabler.',
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
      context: 'Vercel API returnerede fejl. Tjek at VERCEL_API_TOKEN er gyldigt.',
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
    await createAdminClient().from('service_manager_activity').insert({
      action,
      details,
      created_by: null, // Cron runs without a user session
    });
  } catch (err) {
    logger.error('[service-scan] activity log error:', err);
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
    logger.warn('[service-scan] RESEND_API_KEY ikke sat — alert-email springes over');
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
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error('[service-scan] Resend API fejl:', res.status, body);
    } else {
      logger.log('[service-scan] Alert-email sendt');
    }
  } catch (err) {
    logger.error('[service-scan] Kunne ikke sende alert-email:', err);
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * GET /api/cron/service-scan
 *
 * Hourly autonomous scan. Runs the bug scan, proposes fixes for new error-severity
 * issues, logs all activity, and sends an alert email if problems are found.
 *
 * Triggered by Vercel Cron ("0 * * * *") or manually with Authorization: Bearer <CRON_SECRET>.
 *
 * @param request - Incoming HTTP request
 * @returns JSON summary of the scan run
 */
export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // BIZZ-305/621/624: heartbeat + Sentry cron-monitoring via shared wrapper.
  // Tidligere inline recordHeartbeat erstattet af withCronMonitor.
  return withCronMonitor(
    { jobName: 'service-scan', schedule: '0 * * * *', intervalMinutes: 60 },
    async () => {
      const now = new Date();
      const admin = createAdminClient();

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
        logger.error('[service-scan] runScan threw:', scanErr);
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

      // ── 1b. BIZZ-306: External API + infrastructure health checks ─────────────
      try {
        const healthRes = await fetch(`${request.nextUrl.origin}/api/health?deep=true`, {
          headers: { cookie: request.headers.get('cookie') ?? '' },
          signal: AbortSignal.timeout(15000),
        });
        if (healthRes.ok) {
          const health = await healthRes.json();

          // Check external APIs
          const apis = health.checks?.external_apis ?? {};
          for (const [name, info] of Object.entries(apis) as [
            string,
            { status: string; latency_ms: number },
          ][]) {
            if (info.status === 'down') {
              issues.push({
                type: 'config_error',
                severity: 'error',
                message: `Ekstern API nede: ${name}`,
                source: 'static',
                context: `Latency: ${info.latency_ms}ms`,
              });
            } else if (info.status === 'slow') {
              issues.push({
                type: 'config_error',
                severity: 'warning',
                message: `Ekstern API langsom: ${name} (${info.latency_ms}ms)`,
                source: 'static',
              });
            }
          }

          // Check certificates
          const certs = health.checks?.certificates ?? [];
          for (const cert of certs as {
            name: string;
            status: string;
            daysRemaining: number | null;
          }[]) {
            if (cert.status === 'expired' || cert.status === 'critical') {
              issues.push({
                type: 'config_error',
                severity: 'error',
                message: `Certifikat ${cert.status}: ${cert.name} (${cert.daysRemaining ?? 0} dage)`,
                source: 'static',
                context: 'certificate_expiry',
              });
            } else if (cert.status === 'warning') {
              issues.push({
                type: 'config_error',
                severity: 'warning',
                message: `Certifikat udløber snart: ${cert.name} (${cert.daysRemaining} dage)`,
                source: 'static',
                context: 'certificate_expiry',
              });
            }
          }

          // Check Redis
          if (health.checks?.redis === 'error') {
            issues.push({
              type: 'config_error',
              severity: 'error',
              message: 'Upstash Redis ikke tilgængelig',
              source: 'static',
            });
          }

          // Update summary if new issues found
          const infraIssues = issues.filter(
            (i) => i.source === 'static' && i.message.includes('API')
          );
          if (infraIssues.length > 0) {
            summary += ` | Infrastruktur: ${infraIssues.length} problemer fundet.`;
          }
        }
      } catch {
        // Health check failure is non-fatal
        logger.error('[service-scan] Deep health check failed (non-fatal)');
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
        logger.error('[service-scan] Kunne ikke oprette scan-record:', scanInsertErr?.message);
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

      for (
        let idx = 0;
        idx < issues.length && proposedFixCount < MAX_FIX_PROPOSALS_PER_RUN;
        idx++
      ) {
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
          logger.log(
            `[service-scan] Issue ${idx} already has active fix ${existingData.id} — skipping`
          );
          continue;
        }

        // Ask Claude to propose a fix
        let claudeResult: ClaudeFixResponse;
        try {
          claudeResult = await proposeFixWithClaude(issue, summary);
        } catch (aiErr) {
          logger.error(`[service-scan] Claude API error for issue ${idx}:`, aiErr);
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
          logger.error('[service-scan] Kunne ikke gemme fix-forslag:', fixInsertErr?.message);
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
          lines_changed: claudeResult.proposed_diff
            ? countChangedLines(claudeResult.proposed_diff)
            : 0,
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

      // ── 6. BIZZ-623: Cron-heartbeat-trigger ─────────────────────────────────
      // Tjek public.cron_heartbeats for jobs der fejler (last_status='error')
      // ELLER er forsinkede (last_run_at > 2× expected_interval). For hver fejl,
      // opret en separat service_manager_scans-row med scan_type='cron_failure'
      // så Service Manager-agenten kan foreslå en fix. Dedup: skip hvis vi
      // allerede har lavet en cron_failure-scan for samme job inden for de
      // sidste 4 timer (undgår spam fra persistent fejlede jobs).
      const cronFailureScans = await checkCronHeartbeatsAndCreateScans(admin, now);
      if (cronFailureScans > 0) {
        logger.log(
          `[service-scan] Oprettede ${cronFailureScans} cron_failure-scan(s) fra heartbeat-check`
        );
      }

      // ── 7. BIZZ-611: EJF bulk-ingest freshness check ───────────────────────
      // Alert hvis seneste ingest-run ikke er afsluttet efter 24t (stuck) eller
      // hvis seneste succeseful run processerede < 100 rækker (sandsynlig fejl
      // i data-kilden). Bruges til at fange stille ingest-regressions uden at
      // admin skal overvåge Supabase manuelt.
      const ejfIngestIssues = await checkEjfIngestHealthAndCreateScans(admin, now);
      if (ejfIngestIssues > 0) {
        logger.log(`[service-scan] Oprettede ${ejfIngestIssues} EJF-ingest-issue-scan(s)`);
      }

      // ── 8. BIZZ-623 Trigger 2: infra_down detection ─────────────────────────
      // Probe infrastructure-services (datafordeler, upstash, resend, cvr etc.)
      // og log hver probe til service_probe_history. Når 2 KONSEKUTIVE probes
      // af samme service er "down", opretter vi service_manager_scans-row med
      // scan_type='infra_down' så Service Manager kan notificere + oprette
      // JIRA-ticket (infra-action, ikke kode-fix). 2-konsekutive filter
      // forhindrer falske positive fra single-probe-glitches.
      const infraDownScans = await probeInfraAndDetectDowns(admin, request.nextUrl.origin, now);
      if (infraDownScans > 0) {
        logger.log(`[service-scan] Oprettede ${infraDownScans} infra_down scan(s)`);
      }

      logger.log(
        `[service-scan] Done: ${issues.length} issues, ${errorIssues.length} errors, ${proposedFixCount} fixes proposed, ${cronFailureScans} cron-failures, ${ejfIngestIssues} ejf-issues, ${infraDownScans} infra-down`
      );

      // Heartbeat-write + Sentry check-in håndteres af withCronMonitor —
      // BIZZ-305's inline recordHeartbeat er fjernet da det nu er centralt.

      return NextResponse.json({
        ok: true,
        scanId,
        issueCount: issues.length,
        errorCount: errorIssues.length,
        warningCount: issues.filter((i) => i.severity === 'warning').length,
        fixesProposed: proposedFixCount,
        fixes: fixResults,
        cronFailureScans,
        ejfIngestIssues,
        infraDownScans,
        summary,
      });
    }
  );
}

/**
 * BIZZ-623: Tjek cron_heartbeats for fejlede eller forsinkede jobs og opret
 * en service_manager_scans-row med scan_type='cron_failure' per unikke fejl.
 *
 * Dedup: vi opretter ikke en ny scan for samme job hvis vi allerede har lavet
 * en cron_failure-scan for det job inden for de sidste 4 timer. Det forhindrer
 * at en persistent fejlet cron spammer scan-listen hver time.
 *
 * Acceptance (BIZZ-623): "Cron der fejler 2 gange i træk udløser
 * service_manager_scans med scan_type='cron_failure' inden for 30 min."
 * Vi er konservative og fyrer allerede på første failure så agenten får
 * chancen for at analysere ASAP — dedup-vinduet forhindrer spam.
 *
 * @param admin - Supabase admin-client
 * @param now - Reference-tidspunkt (bruges til overdue-beregning + dedup)
 * @returns Antal cron_failure-scans der blev oprettet
 */
async function checkCronHeartbeatsAndCreateScans(
  admin: ReturnType<typeof createAdminClient>,
  now: Date
): Promise<number> {
  interface HeartbeatRow {
    job_name: string;
    last_run_at: string | null;
    last_status: 'success' | 'error' | null;
    last_duration_ms: number | null;
    expected_interval_minutes: number | null;
    last_error: string | null;
  }

  let heartbeats: HeartbeatRow[] = [];
  try {
    const { data, error } = await admin
      .from('cron_heartbeats')
      .select(
        'job_name, last_run_at, last_status, last_duration_ms, expected_interval_minutes, last_error'
      )
      .returns<HeartbeatRow[]>();
    if (error) {
      logger.error('[service-scan] cron_heartbeats query fejl:', error.message);
      return 0;
    }
    heartbeats = data ?? [];
  } catch (err) {
    // fx PGRST205 hvis migration 041 ikke er kørt — ikke fatalt
    logger.error('[service-scan] cron_heartbeats query exception:', err);
    return 0;
  }

  if (heartbeats.length === 0) return 0;

  // Find jobs der er enten error eller overdue
  const failing: Array<{
    jobName: string;
    reason: 'error' | 'overdue';
    detail: string;
    lastRunAt: string | null;
    lastError: string | null;
  }> = [];

  for (const hb of heartbeats) {
    if (hb.last_status === 'error') {
      failing.push({
        jobName: hb.job_name,
        reason: 'error',
        detail: `Seneste run fejlede: ${hb.last_error ?? 'uspecificeret fejl'}`,
        lastRunAt: hb.last_run_at,
        lastError: hb.last_error,
      });
      continue;
    }
    if (hb.last_run_at && hb.expected_interval_minutes) {
      const ageMinutes = (now.getTime() - new Date(hb.last_run_at).getTime()) / 60_000;
      // Overdue tærskel: 2× forventet interval + 5 min grace (samme som
      // cron-status dashboard for at undgå forskellig behandling).
      if (ageMinutes > hb.expected_interval_minutes * 2 + 5) {
        failing.push({
          jobName: hb.job_name,
          reason: 'overdue',
          detail: `Sidst kørt for ${Math.round(ageMinutes)} min siden (forventet hver ${hb.expected_interval_minutes} min)`,
          lastRunAt: hb.last_run_at,
          lastError: null,
        });
      }
    }
  }

  if (failing.length === 0) return 0;

  // Dedup: check om der allerede er en cron_failure-scan for samme job inden
  // for de sidste 4 timer. Vi sammenligner mod summary-feltet der indeholder
  // job-navnet i format "[cron_failure] <jobName>: ...".
  const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();
  // Cast via `as never` — Supabase types er genereret før migration 050
  // tilføjede 'cron_failure' til scan_type-enum. Skift når types regenereres.
  const { data: recentCronScans } = await admin
    .from('service_manager_scans')
    .select('summary')
    .eq('scan_type', 'cron_failure' as never)
    .gte('created_at', fourHoursAgo);

  const alreadyScanned = new Set<string>();
  for (const s of recentCronScans ?? []) {
    const summaryStr = (s as { summary?: string }).summary ?? '';
    const match = summaryStr.match(/\[cron_failure\]\s+([\w-]+):/);
    if (match) alreadyScanned.add(match[1]);
  }

  let created = 0;
  for (const f of failing) {
    if (alreadyScanned.has(f.jobName)) {
      logger.log(
        `[service-scan] Cron-failure-scan for ${f.jobName} findes allerede (< 4t) — skipper`
      );
      continue;
    }

    const issue = {
      type: f.reason === 'error' ? 'runtime_error' : 'config_error',
      severity: 'error',
      message: `Cron job '${f.jobName}' ${f.reason === 'error' ? 'fejlede' : 'er forsinket'}`,
      source: 'cron_heartbeat',
      context: f.detail,
    };

    const summary = `[cron_failure] ${f.jobName}: ${f.detail}`;
    const { error: insertErr } = await admin.from('service_manager_scans').insert({
      scan_type: 'cron_failure',
      status: 'completed',
      triggered_by: null,
      issues_found: [issue],
      summary,
    });
    if (insertErr) {
      logger.error(
        `[service-scan] Kunne ikke oprette cron_failure-scan for ${f.jobName}:`,
        insertErr.message
      );
      continue;
    }
    created++;
  }

  return created;
}

/**
 * BIZZ-611: Tjek public.ejf_ingest_runs for sundhedsproblemer med EJF bulk-
 * ingestion og opret cron_failure-scans hvis noget ser galt ud.
 *
 * Detekterer 2 kategorier:
 *   1. Stuck run: seneste række har finished_at=NULL og started_at > 24t siden.
 *      Betyder at cronen gik ned eller Vercel timeout'ede uden at skrive
 *      resultat — data er sandsynligvis ikke opdateret.
 *   2. Suspicious low volume: seneste SUCCESSFUL run (finished_at != NULL,
 *      error = NULL) har rows_processed < 100. Forventet bulk-ingest henter
 *      millioner af rækker — <100 betyder at source-file var tom, URL returnerede
 *      fejl, eller parser afviste formatet.
 *
 * Dedup (samme 4t-vindue som cron-failure-check) forhindrer spam ved persistent
 * problem. Oprettes som scan_type='cron_failure' så Service Manager-agenten
 * (BIZZ-623) kan klassificere + foreslå fix eller oprette JIRA-ticket.
 *
 * @param admin - Supabase admin-client
 * @param now - Reference-tidspunkt
 * @returns Antal ejf-ingest-issue-scans der blev oprettet
 */
async function checkEjfIngestHealthAndCreateScans(
  admin: ReturnType<typeof createAdminClient>,
  now: Date
): Promise<number> {
  interface IngestRow {
    id: number;
    started_at: string;
    finished_at: string | null;
    rows_processed: number | null;
    error: string | null;
  }

  let recentRuns: IngestRow[] = [];
  try {
    // ejf_ingest_runs er ikke i generated Supabase types — cast
    const { data, error } = await (
      admin as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            order: (
              col: string,
              opts: { ascending: boolean }
            ) => {
              limit: (n: number) => Promise<{ data: IngestRow[] | null; error: unknown }>;
            };
          };
        };
      }
    )
      .from('ejf_ingest_runs')
      .select('id, started_at, finished_at, rows_processed, error')
      .order('started_at', { ascending: false })
      .limit(5);
    if (error) {
      // PGRST205 hvis migration 046 ikke er kørt — ikke fatalt, bare return 0
      logger.error('[service-scan] ejf_ingest_runs query fejl:', error);
      return 0;
    }
    recentRuns = data ?? [];
  } catch (err) {
    logger.error('[service-scan] ejf_ingest_runs exception:', err);
    return 0;
  }

  if (recentRuns.length === 0) return 0;

  const issues: Array<{ reason: 'stuck' | 'low_volume'; detail: string }> = [];

  // 1) Stuck run: seneste har finished_at=NULL og er > 24 t gammel
  const latest = recentRuns[0];
  if (!latest.finished_at) {
    const ageHours = (now.getTime() - new Date(latest.started_at).getTime()) / 3_600_000;
    if (ageHours > 24) {
      issues.push({
        reason: 'stuck',
        detail: `ingest_run id=${latest.id} startede for ${ageHours.toFixed(1)} t siden og er ikke afsluttet (finished_at IS NULL)`,
      });
    }
  }

  // 2) Low volume: seneste SUCCESSFUL (finished_at != NULL og ingen error)
  // processede < 100 rækker. Bulk-ingest forventes at hente millioner.
  const latestSuccess = recentRuns.find((r) => r.finished_at && !r.error);
  if (latestSuccess && (latestSuccess.rows_processed ?? 0) < 100) {
    issues.push({
      reason: 'low_volume',
      detail: `ingest_run id=${latestSuccess.id} processede kun ${latestSuccess.rows_processed ?? 0} rækker (forventet millioner) — sandsynlig kilde-fejl eller tom dump-fil`,
    });
  }

  if (issues.length === 0) return 0;

  // Dedup mod sidste 4t af scans for at undgå spam
  const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();
  const { data: recentScans } = await admin
    .from('service_manager_scans')
    .select('summary')
    .eq('scan_type', 'cron_failure' as never)
    .gte('created_at', fourHoursAgo);
  const alreadyScanned = new Set<string>();
  for (const s of recentScans ?? []) {
    const summaryStr = (s as { summary?: string }).summary ?? '';
    const match = summaryStr.match(/\[ejf_ingest_(stuck|low_volume)\]/);
    if (match) alreadyScanned.add(match[1]);
  }

  let created = 0;
  for (const iss of issues) {
    if (alreadyScanned.has(iss.reason)) continue;
    const issue = {
      type: 'runtime_error',
      severity: 'error',
      message: `EJF bulk-ingest ${iss.reason === 'stuck' ? 'hænger' : 'fik for lidt data'}`,
      source: 'ejf_ingest_runs',
      context: iss.detail,
    };
    const summary = `[ejf_ingest_${iss.reason}] ingest-ejf-bulk: ${iss.detail}`;
    const { error: insertErr } = await admin.from('service_manager_scans').insert({
      scan_type: 'cron_failure',
      status: 'completed',
      triggered_by: null,
      issues_found: [issue],
      summary,
    });
    if (insertErr) {
      logger.error(`[service-scan] Kunne ikke oprette ejf-ingest-scan:`, insertErr.message);
      continue;
    }
    created++;
  }

  return created;
}

/**
 * BIZZ-623 Trigger 2: Probe infrastructure services via /api/admin/service-
 * status, log each result to service_probe_history, and when 2 consecutive
 * probes for the SAME service return is_down=true, create a service_manager_
 * scans row with scan_type='infra_down'.
 *
 * 2-konsekutive filter er kernen i acceptance-kriteriet "Ingen falske positive
 * ved single-probe-glitch". Dedup: 4-timers vindue per service så en
 * persistent down-service ikke spammer scan-listen.
 *
 * @param admin - Supabase admin-client
 * @param baseUrl - Origin til at kalde /api/admin/service-status?probe=...
 * @param now - Reference-tidspunkt til dedup
 * @returns Antal infra_down-scans der blev oprettet
 */
async function probeInfraAndDetectDowns(
  admin: ReturnType<typeof createAdminClient>,
  baseUrl: string,
  now: Date
): Promise<number> {
  const serviceIds = ['datafordeler', 'upstash', 'resend', 'cvr', 'brave', 'mediastack', 'twilio'];

  // Step 1: probe each service + log to service_probe_history
  for (const svc of serviceIds) {
    let isDown = true;
    let httpStatus = 0;
    let detail: string | null = null;
    try {
      const secret = process.env.CRON_SECRET ?? '';
      const res = await fetch(
        `${baseUrl}/api/admin/service-status?probe=${encodeURIComponent(svc)}`,
        {
          headers: secret ? { Authorization: `Bearer ${secret}` } : {},
          signal: AbortSignal.timeout(8000),
        }
      );
      httpStatus = res.status;
      if (res.ok) {
        const data = (await res.json()) as { ok?: boolean; detail?: string };
        isDown = !data.ok;
        detail = data.detail ?? null;
      } else {
        detail = `probe HTTP ${res.status}`;
      }
    } catch (err) {
      detail = err instanceof Error ? err.name : 'probe_exception';
    }

    // Log probe result — service_probe_history ikke i generated types, cast
    try {
      await (
        admin as unknown as {
          from: (t: string) => {
            insert: (row: Record<string, unknown>) => Promise<{ error: unknown }>;
          };
        }
      )
        .from('service_probe_history')
        .insert({
          service_id: svc,
          is_down: isDown,
          http_status: httpStatus || null,
          detail,
        });
    } catch (err) {
      logger.error('[service-scan] probe_history insert:', err);
    }
  }

  // Step 2: for hver service — hent 2 seneste probes og tjek for 2× down
  const downServices: Array<{ serviceId: string; lastDetail: string | null }> = [];
  interface ProbeRow {
    service_id: string;
    is_down: boolean;
    detail: string | null;
    probed_at: string;
  }
  for (const svc of serviceIds) {
    try {
      const { data } = await (
        admin as unknown as {
          from: (t: string) => {
            select: (c: string) => {
              eq: (
                k: string,
                v: string
              ) => {
                order: (
                  col: string,
                  opts: { ascending: boolean }
                ) => {
                  limit: (n: number) => Promise<{ data: ProbeRow[] | null; error: unknown }>;
                };
              };
            };
          };
        }
      )
        .from('service_probe_history')
        .select('service_id, is_down, detail, probed_at')
        .eq('service_id', svc)
        .order('probed_at', { ascending: false })
        .limit(2);
      const rows = data ?? [];
      if (rows.length >= 2 && rows[0].is_down && rows[1].is_down) {
        downServices.push({ serviceId: svc, lastDetail: rows[0].detail });
      }
    } catch {
      // Best-effort — enkelt service's historik-fejl afbryder ikke resten.
    }
  }

  if (downServices.length === 0) return 0;

  // Step 3: dedup mod seneste 4t scans (samme mønster som cron_failure)
  const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();
  const { data: recentScans } = await admin
    .from('service_manager_scans')
    .select('summary')
    .eq('scan_type', 'infra_down' as never)
    .gte('created_at', fourHoursAgo);
  const alreadyScanned = new Set<string>();
  for (const s of recentScans ?? []) {
    const summaryStr = (s as { summary?: string }).summary ?? '';
    const m = summaryStr.match(/\[infra_down\]\s+([\w-]+):/);
    if (m) alreadyScanned.add(m[1]);
  }

  let created = 0;
  for (const d of downServices) {
    if (alreadyScanned.has(d.serviceId)) continue;
    const issue = {
      type: 'infra_outage',
      severity: 'error',
      message: `Infra-service '${d.serviceId}' er nede`,
      source: 'service_probe',
      context: `2 konsekutive probe-fejl. Seneste detail: ${d.lastDetail ?? 'ukendt'}`,
    };
    const summary = `[infra_down] ${d.serviceId}: 2 konsekutive probe-fejl`;
    const { error } = await admin.from('service_manager_scans').insert({
      scan_type: 'infra_down',
      status: 'completed',
      triggered_by: null,
      issues_found: [issue],
      summary,
    });
    if (error) {
      logger.error(`[service-scan] Kunne ikke oprette infra_down for ${d.serviceId}:`, error);
      continue;
    }
    created++;
  }

  return created;
}
