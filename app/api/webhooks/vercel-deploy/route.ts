/**
 * Vercel Deploy Webhook — /api/webhooks/vercel-deploy
 *
 * HOW TO CONFIGURE IN VERCEL DASHBOARD:
 *   1. Go to Project Settings → Git → Deploy Hooks
 *      (or Integrations → Webhooks, depending on your plan)
 *   2. Add webhook URL:
 *      https://test.bizzassist.dk/api/webhooks/vercel-deploy?secret=<VERCEL_DEPLOY_WEBHOOK_SECRET>
 *   3. Add VERCEL_DEPLOY_WEBHOOK_SECRET to your Vercel environment variables
 *   4. Select event types: deployment.created, deployment.succeeded, deployment.error
 *
 * When a deployment fails (state=ERROR or event type=deployment.error), this endpoint:
 *   - Creates a service_manager_scans record (scan_type: 'deploy_webhook')
 *   - Fetches build error logs from the Vercel API
 *   - Asks Claude to propose a minimal fix for the build error
 *   - Evaluates auto-approval rules — if build_fix rule matches, triggers Release Agent
 *   - Sends an immediate critical alert email via Resend
 *   - Logs all actions to service_manager_activity
 *
 * When a deployment succeeds (state=READY or eventType=deployment.succeeded), logs success and returns 200.
 *
 * Auth: VERCEL_DEPLOY_WEBHOOK_SECRET env var, verified via:
 *   - ?secret= query param (recommended — include in webhook URL above)
 *   - X-Vercel-Signature HMAC-SHA1 header (Vercel's built-in signing)
 *
 * Env vars required:
 *   - VERCEL_DEPLOY_WEBHOOK_SECRET — shared secret, included in webhook URL
 *   - VERCEL_TOKEN                 — Vercel API token for fetching build logs
 *   - VERCEL_PROJECT_ID            — Vercel project ID
 *   - VERCEL_TEAM_ID               — (optional) Vercel team ID
 *   - BIZZASSIST_CLAUDE_KEY        — Anthropic API key for fix proposals
 *   - RESEND_API_KEY               — Resend API key for critical alert emails
 *   - NEXT_PUBLIC_APP_URL          — Base URL of the app
 *
 * @module api/webhooks/vercel-deploy
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendCriticalAlert } from '@/lib/service-manager-alerts';
import { sendCriticalSms } from '@/lib/sms';
import { evaluateAutoApproval, logAutoApproval } from '@/lib/service-manager-rules';

export const maxDuration = 30;

/** Vercel REST API base URL */
const VERCEL_API = 'https://api.vercel.com';

/** Maximum lines changed in a proposed fix — mirrors the cron and manual endpoints */
const MAX_LINES_CHANGED = 50;

/**
 * Diff patterns that indicate new functionality rather than bug fixes.
 * Any match causes the proposed fix to be automatically rejected.
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

/** Minimal scan issue shape — mirrors ScanIssue from service-manager/route.ts */
interface ScanIssue {
  type: 'build_error' | 'runtime_error' | 'type_error' | 'config_error';
  severity: 'error' | 'warning';
  message: string;
  source: 'vercel_build' | 'vercel_logs' | 'static';
  context?: string;
}

/** Vercel deploy webhook payload shape */
interface VercelWebhookBody {
  /** Event type, e.g. "deployment.error" or "deployment.succeeded" (some Vercel versions use `type`, others `eventType`) */
  type?: string;
  /** Alias for `type` — used by some Vercel webhook payload versions */
  eventType?: string;
  /** Nested event payload */
  payload?: {
    deployment?: {
      id?: string;
      url?: string;
      name?: string;
      /** READY | ERROR | BUILDING | CANCELED */
      state?: string;
      meta?: {
        githubCommitRef?: string;
        githubCommitMessage?: string;
        githubCommitAuthorName?: string;
      };
    };
    /** "production" | "preview" | null */
    target?: string | null;
    links?: { deployment?: string };
  };
  /** Some webhook versions include deployment directly at root */
  deployment?: {
    id?: string;
    state?: string;
    url?: string;
    meta?: {
      githubCommitRef?: string;
      githubCommitMessage?: string;
      githubCommitAuthorName?: string;
    };
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

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Verify the webhook request is from Vercel using one of two methods:
 *   1. ?secret= query param matches VERCEL_DEPLOY_WEBHOOK_SECRET exactly.
 *   2. X-Vercel-Signature header is a valid HMAC-SHA1 of the raw body.
 *
 * @param request - Incoming HTTP request.
 * @param rawBody - Raw request body string (required for HMAC verification).
 * @returns true if authentication passes.
 */
function verifyWebhookAuth(request: NextRequest, rawBody: string): boolean {
  const secret = process.env.VERCEL_DEPLOY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn(
      '[vercel-deploy] VERCEL_DEPLOY_WEBHOOK_SECRET is not set — rejecting all requests'
    );
    return false;
  }

  // Method 1: ?secret= query param (simple, embed in webhook URL)
  const querySecret = new URL(request.url).searchParams.get('secret');
  if (querySecret && querySecret === secret) return true;

  // Method 2: X-Vercel-Signature HMAC-SHA1 (Vercel's built-in signing)
  const sig = request.headers.get('x-vercel-signature');
  if (sig) {
    const expected = createHmac('sha1', secret).update(rawBody).digest('hex');
    return sig === expected;
  }

  return false;
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
 * Fetch build error events from a specific Vercel deployment.
 * Used to extract the actual build error message for Claude analysis.
 *
 * @param deploymentId - The Vercel deployment UID.
 * @returns Concatenated error log text, or empty string on failure.
 */
async function fetchBuildErrorLogs(deploymentId: string): Promise<string> {
  try {
    const qs = vercelParams({ direction: 'backward', limit: '50' });
    const res = await fetch(`${VERCEL_API}/v2/deployments/${deploymentId}/events?${qs}`, {
      headers: vercelHeaders(),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return '';

    interface VercelEvent {
      type: string;
      payload?: { text?: string; name?: string; entrypoint?: string };
    }
    const events = (await res.json()) as VercelEvent[];
    const errorLines = events
      .filter((e) => e.type === 'error' || e.type === 'build')
      .map((e) => e.payload?.text ?? e.payload?.name ?? '')
      .filter(Boolean)
      .slice(0, 20);

    return errorLines.join('\n');
  } catch {
    return '';
  }
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
 * Check if a diff contains any blocked patterns that indicate new functionality.
 *
 * @param diff - Unified diff string.
 * @returns Matched pattern description, or null if safe.
 */
function findBlockedPattern(diff: string): string | null {
  for (const pattern of BLOCKED_DIFF_PATTERNS) {
    if (pattern.test(diff)) {
      return `Blocked pattern: ${pattern.source}`;
    }
  }
  return null;
}

/**
 * Ask Claude to propose a minimal fix for a build error.
 * Uses a single-phase prompt (no file reading) to stay within the 30s maxDuration.
 *
 * @param issue - The ScanIssue representing the build failure.
 * @param buildLogs - Raw build error log text from Vercel.
 * @returns Structured fix response from Claude.
 */
async function proposeFixWithClaude(
  issue: ScanIssue,
  buildLogs: string
): Promise<ClaudeFixResponse> {
  const anthropic = new Anthropic({ apiKey: process.env.BIZZASSIST_CLAUDE_KEY ?? '' });

  const prompt = `You are a software bug-fix assistant for the BizzAssist Next.js application.
A Vercel deployment just failed with a build error. Propose a minimal fix.

Issue type: ${issue.type}
Message: ${issue.message}
Context: ${issue.context ?? 'none'}
${buildLogs ? `\nBuild log excerpt:\n${buildLogs.slice(0, 2000)}` : ''}

The project uses:
- Next.js 16 App Router (TypeScript)
- Supabase
- Tailwind CSS v4
- Source files: app/, lib/, components/

CRITICAL RULES (violations cause automatic rejection):
1. Change EXACTLY ONE file
2. Change at most ${MAX_LINES_CHANGED} lines total (additions + deletions)
3. NEVER add new exports, new React components, new pages, or new API routes
4. NEVER change CSS classes, colours, layout, or UI-facing properties
5. ONLY fix the specific build error — do not improve surrounding code

Respond with ONLY a JSON object — no markdown, no explanation outside JSON:
{
  "file_path": "<relative path from project root, e.g. app/api/foo/route.ts>",
  "proposed_diff": "<unified diff in standard patch format, or empty string if no safe fix possible>",
  "classification": "<'bug-fix' | 'config-fix' | 'rejected'>",
  "reasoning": "<1-3 sentence explanation of the fix, or why it is rejected>"
}

Classification rules:
- 'bug-fix': corrects wrong logic, null checks, type errors, import errors
- 'config-fix': fixes environment variable usage, configuration values
- 'rejected': too complex, requires new features, or cannot be safely fixed in ≤${MAX_LINES_CHANGED} lines`;

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
      result.reasoning = `Invalid classification from Claude. Original: ${result.reasoning}`;
    }
    return result;
  } catch {
    return {
      file_path: '',
      proposed_diff: '',
      classification: 'rejected',
      reasoning: `Claude did not return valid JSON. Raw: ${text.slice(0, 200)}`,
    };
  }
}

// ─── Activity logging ─────────────────────────────────────────────────────────

/**
 * Write an entry to the service_manager_activity audit log.
 * Non-fatal — the webhook handler continues even if logging fails.
 *
 * @param action - Action identifier string.
 * @param details - Arbitrary JSON context for the log entry.
 */
async function logActivity(action: string, details: Record<string, unknown>): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (createAdminClient() as any).from('service_manager_activity').insert({
      action,
      details,
      created_by: null, // System action — no user session
    });
  } catch (err) {
    console.error('[vercel-deploy] activity log error:', err);
  }
}

// ─── Release Agent trigger ────────────────────────────────────────────────────

/**
 * Trigger the Release Agent to create a hotfix branch and PR for an auto-approved fix.
 * Fire-and-forget — failures are logged but do not affect the webhook response.
 *
 * @param fixId - UUID of the auto-approved fix record.
 * @param scanId - UUID of the parent scan record.
 */
async function triggerReleaseAgent(fixId: string, scanId: string): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://test.bizzassist.dk';
  try {
    const res = await fetch(`${appUrl}/api/admin/release-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'hotfix',
        fixId,
        scanId,
        triggeredBy: 'deploy_webhook',
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('[vercel-deploy] Release Agent returned non-OK:', res.status, body);
    } else {
      console.log('[vercel-deploy] Release Agent triggered for hotfix, fix:', fixId);
    }
  } catch (err) {
    console.error('[vercel-deploy] Release Agent trigger failed:', err);
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * POST /api/webhooks/vercel-deploy
 *
 * Receives Vercel deployment webhooks. On build failure, immediately creates a
 * scan record, proposes a Claude fix, sends a critical alert, and logs activity —
 * bypassing the hourly cron lag.
 *
 * @param request - Incoming POST request from Vercel.
 * @returns 200 on success, 401 on auth failure, 500 on internal error.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Read raw body first — needed for HMAC verification before JSON parsing
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: 'Failed to read request body' }, { status: 400 });
  }

  // Auth check
  if (!verifyWebhookAuth(request, rawBody)) {
    console.warn('[vercel-deploy] Rejected unauthorized webhook request');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Parse payload
  let body: VercelWebhookBody;
  try {
    body = JSON.parse(rawBody) as VercelWebhookBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const now = new Date();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  // Normalise deployment info from either root or nested payload
  const depl = body.payload?.deployment ?? body.deployment ?? {};
  const deploymentId = depl.id ?? '';
  const deploymentState = depl.state ?? '';
  // Normalise event type — Vercel uses `type` in most versions but `eventType` in some
  const eventType = body.type ?? body.eventType ?? '';
  const target = body.payload?.target ?? null;

  const commitMessage = depl.meta?.githubCommitMessage ?? deploymentId;
  const commitRef = depl.meta?.githubCommitRef;
  const commitAuthor = depl.meta?.githubCommitAuthorName;

  // ── Handle successful deployments: just log and return ───────────────────
  const isReady =
    deploymentState === 'READY' ||
    eventType === 'deployment.succeeded' ||
    eventType === 'deployment.created';
  const isFailed =
    deploymentState === 'ERROR' || deploymentState === 'FAILED' || eventType === 'deployment.error';

  if (!isFailed) {
    if (isReady) {
      await logActivity('deploy_webhook_success', {
        deployment_id: deploymentId,
        event_type: eventType,
        state: deploymentState,
        target,
        commit_message: commitMessage,
        commit_ref: commitRef,
      });
      console.log('[vercel-deploy] Deployment succeeded:', deploymentId);
    } else {
      // Unknown event type — log and ignore
      await logActivity('deploy_webhook_ignored', {
        deployment_id: deploymentId,
        event_type: eventType,
        state: deploymentState,
      });
    }
    return NextResponse.json({ ok: true, action: 'logged' });
  }

  // ── Build failure handling ────────────────────────────────────────────────
  console.log('[vercel-deploy] Build failure detected:', deploymentId, deploymentState);

  // Fetch detailed build logs from Vercel API for better Claude context
  const buildLogs = deploymentId ? await fetchBuildErrorLogs(deploymentId) : '';

  // Construct the scan issue
  const issue: ScanIssue = {
    type: 'build_error',
    severity: 'error',
    message: `Build fejlede: ${commitMessage}`,
    source: 'vercel_build',
    context: [
      commitRef ? `Branch: ${commitRef}` : null,
      commitAuthor ? `Af: ${commitAuthor}` : null,
      `Deployment: ${deploymentId}`,
      target ? `Target: ${target}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  };

  const summary = `Deploy webhook: build fejlede på ${commitRef ?? 'ukendt branch'} (${deploymentId})`;

  // ── Create scan record ────────────────────────────────────────────────────
  const { data: scanData, error: scanInsertErr } = await admin
    .from('service_manager_scans')
    .insert({
      scan_type: 'deploy_webhook',
      status: 'completed',
      triggered_by: null,
      issues_found: [issue],
      summary,
    })
    .select('id')
    .single();

  if (scanInsertErr || !scanData) {
    console.error('[vercel-deploy] Failed to create scan record:', scanInsertErr?.message);
    return NextResponse.json({ error: 'Kunne ikke oprette scan-record' }, { status: 500 });
  }

  const scanId = scanData.id as string;

  await logActivity('deploy_webhook_failure_detected', {
    scan_id: scanId,
    deployment_id: deploymentId,
    event_type: eventType,
    state: deploymentState,
    commit_ref: commitRef,
    commit_message: commitMessage,
    commit_author: commitAuthor,
    target,
    has_build_logs: buildLogs.length > 0,
  });

  // ── Ask Claude to propose a fix ───────────────────────────────────────────
  let claudeResult: ClaudeFixResponse;
  try {
    claudeResult = await proposeFixWithClaude(issue, buildLogs);
  } catch (aiErr) {
    console.error('[vercel-deploy] Claude API error:', aiErr);
    // Non-fatal — continue with alert even if fix proposal fails
    claudeResult = {
      file_path: '',
      proposed_diff: '',
      classification: 'rejected',
      reasoning: `Claude API fejl: ${aiErr instanceof Error ? aiErr.message : 'Ukendt fejl'}`,
    };
  }

  // ── Apply safety guards ───────────────────────────────────────────────────
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

  // ── Evaluate auto-approval rules ──────────────────────────────────────────
  let initialStatus: 'proposed' | 'approved' | 'rejected' =
    finalClassification === 'rejected' ? 'rejected' : 'proposed';
  let autoApprovalRuleName: string | undefined;
  let autoApprovalRuleDescription: string | undefined;

  if (finalClassification !== 'rejected' && claudeResult.proposed_diff) {
    const lineCount = countChangedLines(claudeResult.proposed_diff);
    const autoResult = evaluateAutoApproval(
      issue,
      claudeResult.proposed_diff,
      lineCount,
      finalClassification
    );
    if (autoResult.autoApprove) {
      initialStatus = 'approved';
      autoApprovalRuleName = autoResult.ruleName;
      autoApprovalRuleDescription = autoResult.ruleDescription;
    }
  }

  // ── Persist fix proposal ──────────────────────────────────────────────────
  const { data: fixData, error: fixInsertErr } = await admin
    .from('service_manager_fixes')
    .insert({
      scan_id: scanId,
      issue_index: 0,
      file_path: claudeResult.file_path,
      proposed_diff: claudeResult.proposed_diff,
      classification: finalClassification,
      status: initialStatus,
      claude_reasoning: finalReasoning,
      rejection_reason: finalClassification === 'rejected' ? finalReasoning : null,
      reviewed_at: initialStatus === 'approved' ? now.toISOString() : undefined,
    })
    .select('id, status, classification')
    .single();

  const fixId = fixData?.id as string | undefined;

  if (fixInsertErr || !fixData) {
    console.error('[vercel-deploy] Failed to persist fix proposal:', fixInsertErr?.message);
  } else {
    await logActivity('auto_fix_proposed', {
      fix_id: fixId,
      scan_id: scanId,
      issue_index: 0,
      issue_type: issue.type,
      file_path: claudeResult.file_path,
      classification: finalClassification,
      lines_changed: claudeResult.proposed_diff ? countChangedLines(claudeResult.proposed_diff) : 0,
      auto_approved: initialStatus === 'approved',
      auto_approval_rule: autoApprovalRuleName ?? null,
      triggered_by: 'deploy_webhook',
    });

    // Log auto-approval audit entry
    if (initialStatus === 'approved' && autoApprovalRuleName && fixId) {
      await logAutoApproval(
        fixId,
        scanId,
        autoApprovalRuleName,
        autoApprovalRuleDescription ?? autoApprovalRuleName,
        {
          issue_type: issue.type,
          file_path: claudeResult.file_path,
          triggered_by: 'deploy_webhook',
          deployment_id: deploymentId,
        }
      );

      // Trigger Release Agent to create a hotfix branch and PR
      await triggerReleaseAgent(fixId, scanId);
    }
  }

  // ── Send critical alert email + SMS ──────────────────────────────────────
  await sendCriticalAlert({
    description: issue.message,
    affectedPath: claudeResult.file_path || undefined,
    scanId,
    issueType: issue.type,
    context: issue.context,
    detectedAt: now,
  });

  await sendCriticalSms(
    `\uD83D\uDEA8 BizzAssist: build-fejl \u2014 ${issue.message.slice(0, 90)}. Check admin panel.`
  );

  console.log(
    `[vercel-deploy] Done: scan=${scanId}, fix=${fixId ?? 'none'}, ` +
      `classification=${finalClassification}, autoApproved=${initialStatus === 'approved'}`
  );

  return NextResponse.json({
    ok: true,
    scanId,
    fixId: fixId ?? null,
    classification: finalClassification,
    autoApproved: initialStatus === 'approved',
    autoApprovalRule: autoApprovalRuleName ?? null,
  });
}
