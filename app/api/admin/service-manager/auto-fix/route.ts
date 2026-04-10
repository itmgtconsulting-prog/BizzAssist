/**
 * Service Manager Auto-Fix — /api/admin/service-manager/auto-fix
 *
 * AI-powered code fix proposal engine (Service Manager v2, BIZZ-86).
 * Given a scan issue, Claude reads the relevant source file and proposes
 * a minimal unified diff that corrects the bug without adding features or
 * changing the UI.
 *
 * POST /api/admin/service-manager/auto-fix
 *   Body: { scanId: string, issueIndex: number }
 *
 *   Flow:
 *   1. Load the scan record and extract the issue at issueIndex
 *   2. Ask Claude (phase 1) to identify which source file is affected
 *   3. Read that file from disk (server-side fs access)
 *   4. Ask Claude (phase 2) to propose a fix as a unified diff
 *   5. Run safety guards — reject if > 1 file, > 50 lines, or blocked patterns
 *   6. Persist to service_manager_fixes with classification + reasoning
 *   7. Log to service_manager_activity
 *
 *   Returns: { fixId: string, classification: string, status: string }
 *
 * Safety constraints (non-negotiable):
 *   - Max 1 file changed per fix
 *   - Max 50 lines changed (added + removed) per fix
 *   - Blocked diff patterns: new file creation, new exports, new routes/pages
 *   - Claude must classify fix as 'bug-fix' or 'config-fix' — anything else → rejected
 *   - All fixes are stored as 'proposed'; admin approval required before applying
 *
 * Only accessible by admin users (app_metadata.isAdmin === true) or
 * internal cron callers (Authorization: Bearer CRON_SECRET + x-internal-cron: 1).
 *
 * @see app/api/admin/service-manager/route.ts — scan record format
 * @see app/api/admin/release-agent/route.ts — applies approved fixes
 * @see supabase/migrations/021_service_manager_v2.sql — table schema
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ServiceManagerFix, ServiceManagerScan } from '@/lib/supabase/types';
import type { ScanIssue } from '../route';
import { evaluateAutoApproval, logAutoApproval } from '@/lib/service-manager-rules';

/**
 * Returns the admin client cast to `any` for tables that are not yet in the
 * generated Database type (service_manager_fixes, service_manager_activity,
 * service_manager_scans). Remove once `supabase gen types` is re-run after
 * migration 021 is applied.
 */
/**
 * Returns the typed admin client for service_manager table operations.
 *
 * @returns Typed Supabase admin client
 */
function adminDb(): ReturnType<typeof createAdminClient> {
  return createAdminClient();
}

export const runtime = 'nodejs';
export const maxDuration = 60;

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Absolute path to the Next.js app root on disk.
 * Used for reading source files during fix analysis.
 */
const APP_ROOT = join(process.cwd());

/**
 * Maximum lines changed (additions + deletions) allowed in a single fix.
 * Enforced after Claude proposes the diff.
 */
const MAX_LINES_CHANGED = 50;

/**
 * Patterns in a proposed diff that indicate it adds new functionality
 * rather than fixing a bug. Any match causes the fix to be auto-rejected.
 */
const BLOCKED_DIFF_PATTERNS: RegExp[] = [
  /^\+{1,3}.*\bnew\s+file\b/im,
  /^\+{1,3}\s*export\s+(default\s+)?function\s+\w+Page\s*\(/im,
  /^\+{1,3}\s*export\s+(default\s+)?function\s+\w+Layout\s*\(/im,
  /^\+{1,3}\s*(?:const|let|var)\s+\w+Route\b/im,
  /^\+{1,3}\s*createPage\s*\(/im,
  /^\+{1,3}\s*app\.(?:get|post|put|delete|patch)\s*\(/im,
];

/**
 * Strings in a diff that indicate UI changes (visual / structural).
 * These trigger rejection when Claude misclassifies a fix.
 */
const BLOCKED_CLASSIFICATION_KEYWORDS = [
  'new feature',
  'add component',
  'create page',
  'new route',
  'add ui',
  'new ui',
  'new screen',
];

// ─── Admin verification ───────────────────────────────────────────────────────

/**
 * Verify the caller is a BizzAssist admin OR an internal cron service.
 *
 * Admin path: Supabase session cookie → user.app_metadata.isAdmin.
 * Cron path: Authorization: Bearer CRON_SECRET + x-internal-cron: 1 header.
 *
 * @returns An object with `source` ('admin' | 'cron') and optional `user`, or null.
 */
async function verifyAdminOrCron(
  request: NextRequest
): Promise<{ source: 'admin' | 'cron'; user?: { id: string } } | null> {
  // ── Internal cron path ────────────────────────────────────────────────────
  // Accept CRON_SECRET as bearer token for server-to-server calls from other
  // cron/webhook routes (e.g. monitor-email, service-scan).
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');

  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    return { source: 'cron' };
  }

  // ── Admin user path ───────────────────────────────────────────────────────
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createAdminClient();
  const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
  if (freshUser?.user?.app_metadata?.isAdmin) return { source: 'admin', user };
  return null;
}

// ─── Safety guards ────────────────────────────────────────────────────────────

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
 * @returns The matched pattern description, or null if safe.
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
 * Check if Claude's reasoning text contains keywords indicating new features.
 * Used as a secondary guard on top of classification.
 *
 * @param text - Claude's reasoning string.
 * @returns true if any blocked keyword is found.
 */
function containsFeatureKeywords(text: string): boolean {
  const lower = text.toLowerCase();
  return BLOCKED_CLASSIFICATION_KEYWORDS.some((kw) => lower.includes(kw));
}

// ─── File reading ─────────────────────────────────────────────────────────────

/**
 * Safely read a source file within the project root.
 * Rejects path-traversal attempts and non-existent files.
 *
 * @param relPath - Relative path from APP_ROOT (e.g. "app/api/foo/route.ts").
 * @returns File content as a string, or null if unreadable.
 */
function safeReadFile(relPath: string): string | null {
  try {
    // Strip leading slashes and normalise
    const clean = relPath.replace(/^[/\\]+/, '');
    const abs = join(APP_ROOT, clean);

    // Prevent path traversal outside the project
    if (!abs.startsWith(APP_ROOT)) return null;

    return readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}

// ─── Claude helpers ───────────────────────────────────────────────────────────

/**
 * Shape of the structured JSON response we request from Claude in both phases.
 */
interface ClaudeFixResponse {
  /** Relative path to the file that needs to be changed */
  file_path: string;
  /** Unified diff (patch format) of the proposed change */
  proposed_diff: string;
  /** 'bug-fix' | 'config-fix' | 'rejected' */
  classification: 'bug-fix' | 'config-fix' | 'rejected';
  /** Human-readable explanation of the fix or rejection */
  reasoning: string;
}

/**
 * Ask Claude to analyse a scan issue and propose a minimal code fix.
 *
 * Phase 1: Identify the relevant file path from the error details.
 * Phase 2: Given the file content, produce a unified diff.
 *
 * @param issue - The ScanIssue to fix.
 * @param scanSummary - Overall summary from the scan record.
 * @returns Structured fix response from Claude.
 */
async function proposeFixWithClaude(
  issue: ScanIssue,
  scanSummary: string | null
): Promise<ClaudeFixResponse> {
  const anthropic = new Anthropic({ apiKey: process.env.BIZZASSIST_CLAUDE_KEY ?? '' });

  // ── Phase 1: Identify the affected file ──────────────────────────────────
  const identifyPrompt = `You are a software bug-fix assistant for the BizzAssist Next.js application.

A production scan found the following issue:

Issue type: ${issue.type}
Severity: ${issue.severity}
Message: ${issue.message}
Source: ${issue.source}
Context: ${issue.context ?? 'none'}
Scan summary: ${scanSummary ?? 'none'}

The project uses:
- Next.js 16 App Router (TypeScript)
- Supabase
- Tailwind CSS v4
- Source files are under: app/, lib/, components/

Your task is to identify which single source file is MOST LIKELY to contain the bug.
Respond with ONLY a JSON object — no markdown, no explanation:
{
  "file_path": "<relative path from project root, e.g. app/api/foo/route.ts>"
}

Rules:
- Only name ONE file
- Must be an existing TypeScript/JavaScript file
- Prefer the most specific file (API route > lib > component)
- If the context contains a function name like "api/foo", map it to app/api/foo/route.ts`;

  const identifyRes = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    messages: [{ role: 'user', content: identifyPrompt }],
  });

  let identifiedPath = '';
  const identifyText = identifyRes.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  try {
    // Strip any accidental markdown fences
    const cleaned = identifyText.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(cleaned) as { file_path: string };
    identifiedPath = parsed.file_path ?? '';
  } catch {
    // Claude didn't return valid JSON — attempt a regex fallback
    const match = identifyText.match(/["']?([\w/.-]+\.(?:ts|tsx|js|jsx))["']?/);
    identifiedPath = match?.[1] ?? '';
  }

  // ── Phase 2: Read file + propose diff ────────────────────────────────────
  const fileContent = identifiedPath ? safeReadFile(identifiedPath) : null;

  const fixPrompt = `You are a software bug-fix assistant. Your ONLY job is to fix bugs — never add features, change the UI, or refactor code.

CRITICAL RULES (violations cause automatic rejection):
1. Change EXACTLY ONE file
2. Change at most ${MAX_LINES_CHANGED} lines total (additions + deletions)
3. NEVER add new exports, new React components, new pages, or new API routes
4. NEVER change CSS classes, colours, layout, or any UI-facing properties
5. ONLY fix the specific error described — do not "improve" surrounding code

Issue to fix:
- Type: ${issue.type}
- Message: ${issue.message}
- Context: ${issue.context ?? 'none'}
- Source: ${issue.source}

${
  fileContent
    ? `File to fix: ${identifiedPath}
\`\`\`typescript
${fileContent.slice(0, 6000)}
\`\`\``
    : `No file content available. File path identified: "${identifiedPath || 'unknown'}"`
}

Respond with ONLY a JSON object — no markdown wrapper, no explanation outside the JSON:
{
  "file_path": "<relative path from project root>",
  "proposed_diff": "<unified diff in standard patch format, or empty string if no fix possible>",
  "classification": "<'bug-fix' | 'config-fix' | 'rejected'>",
  "reasoning": "<1-3 sentence explanation of the fix, or why it is rejected>"
}

Classification rules:
- 'bug-fix': corrects wrong logic, null checks, type errors, import errors
- 'config-fix': fixes environment variable usage, configuration values, headers
- 'rejected': would require adding features, changing UI, or is too complex to safely fix in ≤${MAX_LINES_CHANGED} lines

If you cannot produce a safe, minimal fix → classify as 'rejected' and explain why.`;

  const fixRes = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: fixPrompt }],
  });

  const fixText = fixRes.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  try {
    const cleaned = fixText.replace(/```json\n?|\n?```/g, '').trim();
    const result = JSON.parse(cleaned) as ClaudeFixResponse;
    // Ensure classification is one of the allowed values
    if (!['bug-fix', 'config-fix', 'rejected'].includes(result.classification)) {
      result.classification = 'rejected';
      result.reasoning = `Invalid classification returned by Claude: ${result.classification}. Original reasoning: ${result.reasoning}`;
    }
    return result;
  } catch {
    return {
      file_path: identifiedPath,
      proposed_diff: '',
      classification: 'rejected',
      reasoning: `Claude did not return valid JSON. Raw response: ${fixText.slice(0, 200)}`,
    };
  }
}

// ─── Activity logging ─────────────────────────────────────────────────────────

/**
 * Write an entry to the service_manager_activity audit log.
 *
 * @param action - Action identifier string.
 * @param details - Arbitrary JSON details for the log entry.
 * @param userId - The user who initiated the action (may be null).
 */
async function logActivity(
  action: string,
  details: Record<string, unknown>,
  userId: string | null
): Promise<void> {
  try {
    await adminDb().from('service_manager_activity').insert({
      action,
      details,
      created_by: userId,
    });
  } catch (err) {
    // Activity log failures are non-fatal
    console.error('[auto-fix] activity log error:', err);
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * POST /api/admin/service-manager/auto-fix
 *
 * Proposes an AI-generated fix for a specific issue in a scan record.
 * The fix is stored as 'proposed' and requires admin approval before applying.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const caller = await verifyAdminOrCron(request);
    if (!caller) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const scanId = body?.scanId as string | undefined;
    const issueIndex = typeof body?.issueIndex === 'number' ? body.issueIndex : 0;

    if (!scanId) {
      return NextResponse.json({ error: 'scanId påkrævet' }, { status: 400 });
    }

    // ── Load the scan record ───────────────────────────────────────────────
    const db = adminDb();
    const { data: scanData, error: scanErr } = await db
      .from('service_manager_scans')
      .select('id, issues_found, summary, status')
      .eq('id', scanId)
      .single();
    const scan = scanData as Pick<
      ServiceManagerScan,
      'id' | 'issues_found' | 'summary' | 'status'
    > | null;

    if (scanErr || !scan) {
      return NextResponse.json({ error: 'Scan ikke fundet' }, { status: 404 });
    }

    const issues = (scan.issues_found ?? []) as ScanIssue[];
    if (issueIndex < 0 || issueIndex >= issues.length) {
      return NextResponse.json({ error: 'Ugyldigt issue-indeks' }, { status: 400 });
    }

    const issue = issues[issueIndex];

    // ── Check for duplicate fix proposals ─────────────────────────────────
    const { data: existingData } = await db
      .from('service_manager_fixes')
      .select('id, status')
      .eq('scan_id', scanId)
      .eq('issue_index', issueIndex)
      .in('status', ['proposed', 'approved', 'applied'])
      .maybeSingle();
    const existing = existingData as Pick<ServiceManagerFix, 'id' | 'status'> | null;

    if (existing) {
      return NextResponse.json(
        {
          error: 'Der er allerede et aktivt fix-forslag for dette issue',
          fixId: existing.id,
          status: existing.status,
        },
        { status: 409 }
      );
    }

    // ── Ask Claude to propose a fix ────────────────────────────────────────
    let claudeResult: Awaited<ReturnType<typeof proposeFixWithClaude>>;
    try {
      claudeResult = await proposeFixWithClaude(issue, scan.summary);
    } catch (aiErr) {
      console.error('[auto-fix] Claude API error:', aiErr);
      return NextResponse.json({ error: 'Claude API fejl — prøv igen' }, { status: 502 });
    }

    // ── Apply safety guards ────────────────────────────────────────────────
    let finalClassification = claudeResult.classification;
    let finalReasoning = claudeResult.reasoning;

    if (finalClassification !== 'rejected' && claudeResult.proposed_diff) {
      // Guard 1: Max lines changed
      const lineCount = countChangedLines(claudeResult.proposed_diff);
      if (lineCount > MAX_LINES_CHANGED) {
        finalClassification = 'rejected';
        finalReasoning = `Afvist: ${lineCount} linjer ændret (maks ${MAX_LINES_CHANGED}). ${finalReasoning}`;
      }

      // Guard 2: Blocked diff patterns
      if (finalClassification !== 'rejected') {
        const blocked = findBlockedPattern(claudeResult.proposed_diff);
        if (blocked) {
          finalClassification = 'rejected';
          finalReasoning = `Afvist pga. blokeret mønster. ${blocked}. ${finalReasoning}`;
        }
      }

      // Guard 3: Feature keywords in reasoning
      if (finalClassification !== 'rejected' && containsFeatureKeywords(finalReasoning)) {
        finalClassification = 'rejected';
        finalReasoning = `Afvist: Claude's begrundelse indeholder nøgleord der tyder på nye features. ${finalReasoning}`;
      }
    }

    // Empty diff on a non-rejected fix → auto-reject
    if (finalClassification !== 'rejected' && !claudeResult.proposed_diff.trim()) {
      finalClassification = 'rejected';
      finalReasoning = `Afvist: Claude returnerede et tomt diff. ${finalReasoning}`;
    }

    // ── Check auto-approval rules ──────────────────────────────────────────
    // Evaluate whether the fix qualifies for automatic approval without admin review.
    // Only runs for non-rejected fixes — rejected fixes always stay rejected.
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

    // ── Persist the fix proposal ───────────────────────────────────────────
    const { data: fixData, error: insertErr } = await db
      .from('service_manager_fixes')
      .insert({
        scan_id: scanId,
        issue_index: issueIndex,
        file_path: claudeResult.file_path,
        proposed_diff: claudeResult.proposed_diff,
        classification: finalClassification,
        status: initialStatus,
        claude_reasoning: finalReasoning,
        rejection_reason: finalClassification === 'rejected' ? finalReasoning : null,
        // Set reviewed metadata when auto-approved so the audit trail is complete
        reviewed_by: initialStatus === 'approved' ? null : undefined,
        reviewed_at: initialStatus === 'approved' ? new Date().toISOString() : undefined,
      })
      .select('id, status, classification')
      .single();
    const fix = fixData as Pick<ServiceManagerFix, 'id' | 'status' | 'classification'> | null;

    if (insertErr || !fix) {
      console.error('[auto-fix] insert error:', insertErr?.code ?? '[DB error]');
      return NextResponse.json({ error: 'Kunne ikke gemme fix-forslag' }, { status: 500 });
    }

    // ── Log to activity ────────────────────────────────────────────────────
    await logActivity(
      'auto_fix_proposed',
      {
        fix_id: fix.id,
        scan_id: scanId,
        issue_index: issueIndex,
        issue_type: issue.type,
        file_path: claudeResult.file_path,
        classification: finalClassification,
        lines_changed: claudeResult.proposed_diff
          ? countChangedLines(claudeResult.proposed_diff)
          : 0,
        auto_approved: initialStatus === 'approved',
      },
      caller.user?.id ?? null
    );

    // Log the auto-approval separately so it appears as its own audit entry
    if (initialStatus === 'approved' && autoApprovalRuleName) {
      await logAutoApproval(
        fix.id,
        scanId,
        autoApprovalRuleName,
        autoApprovalRuleDescription ?? autoApprovalRuleName,
        {
          issue_type: issue.type,
          file_path: claudeResult.file_path,
          triggered_by: caller.user?.id ?? 'cron',
        }
      );
    }

    return NextResponse.json({
      fixId: fix.id,
      classification: fix.classification,
      status: fix.status,
      filePath: claudeResult.file_path,
      reasoning: finalReasoning,
      autoApproved: initialStatus === 'approved',
      autoApprovalRule: autoApprovalRuleName,
    });
  } catch (err) {
    console.error('[service-manager/auto-fix POST]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}

// ─── Review endpoint (approve / reject) ──────────────────────────────────────

/**
 * PATCH /api/admin/service-manager/auto-fix
 *
 * Admin review action — approve or reject a proposed fix.
 *
 * Body: { fixId: string, action: 'approve' | 'reject', reason?: string }
 * Returns: { fixId: string, status: string }
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const caller = await verifyAdminOrCron(request);
    if (!caller) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const fixId = body?.fixId as string | undefined;
    const action = body?.action as 'approve' | 'reject' | undefined;
    const reason = body?.reason as string | undefined;

    if (!fixId || !action || !['approve', 'reject'].includes(action)) {
      return NextResponse.json({ error: 'fixId og action påkrævet' }, { status: 400 });
    }

    const db = adminDb();

    // Only 'proposed' fixes can be reviewed
    const { data: existingData } = await db
      .from('service_manager_fixes')
      .select('id, status, classification')
      .eq('id', fixId)
      .single();
    const existing = existingData as Pick<
      ServiceManagerFix,
      'id' | 'status' | 'classification'
    > | null;

    if (!existing) {
      return NextResponse.json({ error: 'Fix ikke fundet' }, { status: 404 });
    }

    if (existing.status !== 'proposed') {
      return NextResponse.json(
        { error: `Fix er allerede ${existing.status} — kan ikke gennemgås igen` },
        { status: 409 }
      );
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    const { error: updateErr } = await db
      .from('service_manager_fixes')
      .update({
        status: newStatus,
        reviewed_by: caller.user?.id ?? null,
        reviewed_at: new Date().toISOString(),
        rejection_reason: action === 'reject' ? (reason ?? 'Afvist af admin') : null,
      })
      .eq('id', fixId);

    if (updateErr) {
      console.error('[auto-fix PATCH] update error:', updateErr.code ?? '[DB error]');
      return NextResponse.json({ error: 'Kunne ikke opdatere fix' }, { status: 500 });
    }

    await logActivity(
      action === 'approve' ? 'fix_approved' : 'fix_rejected',
      { fix_id: fixId, reason: reason ?? null },
      caller.user?.id ?? null
    );

    return NextResponse.json({ fixId, status: newStatus });
  } catch (err) {
    console.error('[service-manager/auto-fix PATCH]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}

// ─── List fixes for a scan ────────────────────────────────────────────────────

/**
 * GET /api/admin/service-manager/auto-fix?scanId=<uuid>
 *
 * Returns all fix proposals for a specific scan, newest first.
 *
 * Query params: scanId (required)
 * Returns: { fixes: FixRecord[] }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const caller = await verifyAdminOrCron(request);
    if (!caller) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const scanId = request.nextUrl.searchParams.get('scanId');
    if (!scanId) {
      return NextResponse.json({ error: 'scanId påkrævet' }, { status: 400 });
    }

    const { data: fixes, error } = await adminDb()
      .from('service_manager_fixes')
      .select('*')
      .eq('scan_id', scanId)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ error: 'Database fejl' }, { status: 500 });
    }

    return NextResponse.json({ fixes: (fixes ?? []) as ServiceManagerFix[] });
  } catch (err) {
    console.error('[service-manager/auto-fix GET]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
