/**
 * Release Agent — /api/admin/release-agent
 *
 * Handles the deployment workflow for Service Manager v2 (BIZZ-86).
 * Orchestrates hotfix branches, Vercel preview deployments, and
 * production promotions.
 *
 * POST /api/admin/release-agent
 *   Body: { action: string, ...params }
 *
 *   Supported actions:
 *
 *   "create-hotfix"
 *     Body: { action: "create-hotfix", fixId: string }
 *     1. Loads the approved fix from service_manager_fixes
 *     2. Creates branch `hotfix/<scanId>-<fixId-prefix>` from develop
 *     3. Applies the unified diff to the target file
 *     4. Commits with message "hotfix: <issue message>"
 *     5. Pushes branch to remote
 *     6. Creates a PR to develop via GitHub API
 *     Returns: { branch: string, prUrl: string }
 *
 *   "deploy-to-test"
 *     Body: { action: "deploy-to-test", branch: string }
 *     Triggers a Vercel preview deployment for the given branch.
 *     Returns: { deploymentUrl: string }
 *
 *   "promote-to-prod"
 *     Body: { action: "promote-to-prod", confirmationToken: string }
 *     Merges develop into main (requires admin confirmation token).
 *     Returns: { merged: boolean, sha: string }
 *
 *   All actions are logged to service_manager_activity.
 *
 * Safety rules:
 *   - Only 'approved' fixes can have hotfixes created
 *   - A fix can only be applied once (status → 'applied' after success)
 *   - promote-to-prod requires a fresh RELEASE_CONFIRMATION_TOKEN env var match
 *   - Git operations run with a 30-second timeout
 *   - All errors are logged before returning 5xx
 *
 * Only accessible by admin users (app_metadata.isAdmin === true).
 *
 * @see app/api/admin/service-manager/auto-fix/route.ts — produces approved fixes
 * @see supabase/migrations/021_service_manager_v2.sql — activity table schema
 */

import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ServiceManagerFix, ServiceManagerActivity } from '@/lib/supabase/types';

/**
 * Returns the admin client cast to `any` for tables not yet in the generated
 * Database type (service_manager_fixes, service_manager_activity).
 * Remove once `supabase gen types` is re-run after migration 021 is applied.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adminDb(): any {
  return createAdminClient();
}

export const runtime = 'nodejs';
export const maxDuration = 90;

// ─── Constants ────────────────────────────────────────────────────────────────

/** Absolute path to the git repository root (where .git lives) */
const REPO_ROOT = process.cwd();

/** Default branch that hotfixes target */
const BASE_BRANCH = 'develop';

/** Git exec timeout in milliseconds */
const GIT_TIMEOUT_MS = 30_000;

const execAsync = promisify(exec);

// ─── Admin verification ───────────────────────────────────────────────────────

/**
 * Verify the caller is a BizzAssist admin.
 *
 * @returns The authenticated user if admin, null otherwise.
 */
async function verifyAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createAdminClient();
  const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
  if (freshUser?.user?.app_metadata?.isAdmin) return user;
  return null;
}

// ─── Activity logging ─────────────────────────────────────────────────────────

/**
 * Write an entry to the service_manager_activity audit log.
 *
 * @param action - Action identifier string.
 * @param details - Arbitrary JSON details for the log entry.
 * @param userId - The user who initiated the action.
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
    console.error('[release-agent] activity log error:', err);
  }
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

/**
 * Run a git command in the repository root with a timeout.
 *
 * @param cmd - Git command arguments (after "git ").
 * @returns stdout string.
 * @throws If the command exits non-zero or times out.
 */
async function git(cmd: string): Promise<string> {
  const { stdout } = await execAsync(`git ${cmd}`, {
    cwd: REPO_ROOT,
    timeout: GIT_TIMEOUT_MS,
    env: {
      ...process.env,
      // Ensure non-interactive mode for git
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  return stdout.trim();
}

/**
 * Apply a unified diff string to a file on disk.
 * Uses `git apply` to validate and apply the patch safely.
 *
 * @param diff - Unified diff in patch format.
 * @param filePath - Relative path to the target file.
 * @throws If the diff cannot be applied cleanly.
 */
async function applyDiff(diff: string, _filePath: string): Promise<void> {
  const patchFile = join(REPO_ROOT, '.service-manager-patch.diff');
  try {
    writeFileSync(patchFile, diff, 'utf-8');
    // --check first to validate without applying
    await execAsync(`git apply --check "${patchFile}"`, {
      cwd: REPO_ROOT,
      timeout: GIT_TIMEOUT_MS,
    });
    // Apply for real
    await execAsync(`git apply "${patchFile}"`, {
      cwd: REPO_ROOT,
      timeout: GIT_TIMEOUT_MS,
    });
  } finally {
    // Always clean up the temp patch file
    try {
      const { unlinkSync } = await import('fs');
      if (existsSync(patchFile)) unlinkSync(patchFile);
    } catch {
      // Non-fatal cleanup failure
    }
  }
}

// ─── GitHub API helpers ───────────────────────────────────────────────────────

/**
 * Create a pull request on GitHub from a hotfix branch to the base branch.
 * Requires GITHUB_TOKEN and GITHUB_REPO (owner/repo) env vars.
 *
 * @param branch - The hotfix branch name.
 * @param title - PR title.
 * @param body - PR description.
 * @returns The PR URL, or null if GitHub credentials are not configured.
 */
async function createGitHubPR(branch: string, title: string, body: string): Promise<string | null> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO; // e.g. "JakobJuul/bizzassist"

  if (!token || !repo) return null;

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'BizzAssist-ReleaseAgent/2.0',
      },
      body: JSON.stringify({
        title,
        body,
        head: branch,
        base: BASE_BRANCH,
        draft: false,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn('[release-agent] GitHub PR creation failed:', err);
      return null;
    }

    const data = (await res.json()) as { html_url?: string };
    return data.html_url ?? null;
  } catch (err) {
    console.warn('[release-agent] GitHub API error:', err);
    return null;
  }
}

// ─── Action: create-hotfix ────────────────────────────────────────────────────

/**
 * Create a hotfix branch, apply the approved diff, commit, push, and open a PR.
 *
 * @param fixId - The service_manager_fixes record UUID.
 * @param userId - The admin user performing the action.
 * @returns { branch, prUrl, sha }
 */
async function createHotfix(
  fixId: string,
  userId: string
): Promise<{ branch: string; prUrl: string | null; sha: string }> {
  const db = adminDb();

  // ── Load and validate the fix ──────────────────────────────────────────
  const { data: fixData, error: fixErr } = await db
    .from('service_manager_fixes')
    .select('*, service_manager_scans(summary, issues_found)')
    .eq('id', fixId)
    .single();
  const fix = fixData as
    | (ServiceManagerFix & {
        service_manager_scans: {
          summary: string | null;
          issues_found: Array<{ message: string }>;
        } | null;
      })
    | null;

  if (fixErr || !fix) {
    throw new Error('Fix ikke fundet');
  }

  if (fix.status !== 'approved') {
    throw new Error(`Fix har status '${fix.status}' — kun 'approved' fixes kan anvendes`);
  }

  // ── Build branch name ──────────────────────────────────────────────────
  const shortFixId = fixId.replace(/-/g, '').slice(0, 8);
  const branch = `hotfix/${fix.scan_id.slice(0, 8)}-${shortFixId}`;

  // ── Ensure working tree is clean ───────────────────────────────────────
  const statusOutput = await git('status --porcelain');
  if (statusOutput.length > 0) {
    throw new Error(
      'Git working tree er ikke ren — stash eller commit eksisterende ændringer først'
    );
  }

  // ── Checkout develop and pull latest ──────────────────────────────────
  await git(`checkout ${BASE_BRANCH}`);
  await git('pull --ff-only').catch(() => {
    // Pull may fail if remote is not reachable — continue with local state
    console.warn('[release-agent] pull failed — proceeding with local develop');
  });

  // ── Create the hotfix branch ───────────────────────────────────────────
  await git(`checkout -b ${branch}`);

  // ── Apply the diff ─────────────────────────────────────────────────────
  try {
    await applyDiff(fix.proposed_diff as string, fix.file_path as string);
  } catch (patchErr) {
    // Abort: return to develop and delete the branch
    await git(`checkout ${BASE_BRANCH}`).catch(() => {});
    await git(`branch -D ${branch}`).catch(() => {});
    throw new Error(
      `Diff kunne ikke anvendes: ${patchErr instanceof Error ? patchErr.message : String(patchErr)}`
    );
  }

  // ── Stage the changed file ─────────────────────────────────────────────
  await git(`add -- "${fix.file_path}"`);

  // ── Build commit message ───────────────────────────────────────────────
  const scan = fix.service_manager_scans;
  const issueMsg = scan?.issues_found?.[fix.issue_index]?.message ?? scan?.summary ?? 'auto-fix';
  // Truncate to keep commit message clean
  const commitMsg = `hotfix: ${issueMsg.slice(0, 72)}`;

  await git(`commit -m "${commitMsg.replace(/"/g, '\\"')}"`);

  // ── Get the commit SHA ─────────────────────────────────────────────────
  const sha = await git('rev-parse HEAD');

  // ── Push to remote ─────────────────────────────────────────────────────
  await git(`push origin ${branch}`);

  await logActivity('hotfix_pushed', { fix_id: fixId, branch, sha }, userId);

  // ── Create GitHub PR ───────────────────────────────────────────────────
  const prBody = [
    `## Automatisk hotfix`,
    ``,
    `**Fix ID:** \`${fixId}\``,
    `**Scan ID:** \`${fix.scan_id}\``,
    `**Fil:** \`${fix.file_path}\``,
    `**Klassifikation:** ${fix.classification}`,
    ``,
    `### Claude's begrundelse`,
    fix.claude_reasoning ?? '_Ingen begrundelse_',
    ``,
    `### Diff`,
    `\`\`\`diff`,
    fix.proposed_diff,
    `\`\`\``,
    ``,
    `---`,
    `_Oprettet af BizzAssist Release Agent v2_`,
  ].join('\n');

  const prUrl = await createGitHubPR(branch, commitMsg, prBody);

  if (prUrl) {
    await logActivity('pr_created', { fix_id: fixId, branch, pr_url: prUrl }, userId);
  }

  // ── Mark fix as applied ────────────────────────────────────────────────
  await db.from('service_manager_fixes').update({ status: 'applied' }).eq('id', fixId);

  await logActivity(
    'hotfix_created',
    { fix_id: fixId, branch, sha, pr_url: prUrl ?? null },
    userId
  );

  return { branch, prUrl, sha };
}

// ─── Action: deploy-to-test ───────────────────────────────────────────────────

/**
 * Trigger a Vercel preview deployment for a hotfix branch.
 * Requires VERCEL_API_TOKEN, VERCEL_PROJECT_ID, and VERCEL_TEAM_ID env vars.
 *
 * @param branch - The branch to deploy.
 * @param userId - The admin user.
 * @returns { deploymentUrl }
 */
async function deployToTest(
  branch: string,
  userId: string
): Promise<{ deploymentUrl: string | null }> {
  const token = process.env.VERCEL_API_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;

  if (!token || !projectId) {
    throw new Error('VERCEL_API_TOKEN og VERCEL_PROJECT_ID er påkrævet for preview-deployment');
  }

  const teamId = process.env.VERCEL_TEAM_ID;
  const params = new URLSearchParams({ ...(teamId ? { teamId } : {}) });

  const res = await fetch(
    `https://api.vercel.com/v13/deployments${params.toString() ? `?${params}` : ''}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: projectId,
        target: 'preview',
        gitSource: {
          type: 'github',
          ref: branch,
        },
      }),
      signal: AbortSignal.timeout(30000),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Vercel deployment fejlede: ${err.slice(0, 200)}`);
  }

  const data = (await res.json()) as { url?: string };
  const deploymentUrl = data.url ? `https://${data.url}` : null;

  await logActivity('deploy_test', { branch, deployment_url: deploymentUrl }, userId);

  return { deploymentUrl };
}

// ─── Action: promote-to-prod ──────────────────────────────────────────────────

/**
 * Merge develop into main to promote changes to production.
 * Requires a confirmation token to prevent accidental promotions.
 *
 * @param confirmationToken - Must match RELEASE_CONFIRMATION_TOKEN env var.
 * @param userId - The admin user.
 * @returns { merged: boolean, sha: string }
 */
async function promoteToProd(
  confirmationToken: string,
  userId: string
): Promise<{ merged: boolean; sha: string }> {
  // Token guard — prevents accidental production promotions
  const expectedToken = process.env.RELEASE_CONFIRMATION_TOKEN;
  if (!expectedToken || confirmationToken !== expectedToken) {
    throw new Error('Ugyldigt bekræftelsestoken — production-promotion afvist');
  }

  // Ensure clean working tree
  const statusOutput = await git('status --porcelain');
  if (statusOutput.length > 0) {
    throw new Error('Git working tree er ikke ren — ryd op før promotion');
  }

  // Fetch latest
  await git('fetch origin');

  // Checkout main and merge develop
  await git('checkout main');
  await git('pull --ff-only origin main').catch(() => {});
  await git(
    `merge --no-ff origin/${BASE_BRANCH} -m "chore(release): promote develop to production"`
  );

  const sha = await git('rev-parse HEAD');

  // Push to remote
  await git('push origin main');

  // Return to develop
  await git(`checkout ${BASE_BRANCH}`).catch(() => {});

  await logActivity('promote_prod', { sha, from_branch: BASE_BRANCH, to_branch: 'main' }, userId);

  return { merged: true, sha };
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * POST /api/admin/release-agent
 *
 * Dispatches to the appropriate release action based on body.action.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await verifyAdmin();
    if (!user) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const action = body?.action as string | undefined;

    if (!action) {
      return NextResponse.json({ error: 'action er påkrævet' }, { status: 400 });
    }

    switch (action) {
      // ── create-hotfix ───────────────────────────────────────────────────
      case 'create-hotfix': {
        const fixId = body?.fixId as string | undefined;
        if (!fixId) {
          return NextResponse.json({ error: 'fixId er påkrævet' }, { status: 400 });
        }

        let result: Awaited<ReturnType<typeof createHotfix>>;
        try {
          result = await createHotfix(fixId, user.id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[release-agent] create-hotfix error:', msg);
          await logActivity('hotfix_error', { fix_id: fixId, error: msg }, user.id);
          return NextResponse.json({ error: msg }, { status: 422 });
        }

        return NextResponse.json({
          ok: true,
          branch: result.branch,
          prUrl: result.prUrl,
          sha: result.sha,
        });
      }

      // ── deploy-to-test ──────────────────────────────────────────────────
      case 'deploy-to-test': {
        const branch = body?.branch as string | undefined;
        if (!branch) {
          return NextResponse.json({ error: 'branch er påkrævet' }, { status: 400 });
        }

        let result: Awaited<ReturnType<typeof deployToTest>>;
        try {
          result = await deployToTest(branch, user.id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[release-agent] deploy-to-test error:', msg);
          await logActivity('deploy_test_error', { branch, error: msg }, user.id);
          return NextResponse.json({ error: msg }, { status: 422 });
        }

        return NextResponse.json({ ok: true, deploymentUrl: result.deploymentUrl });
      }

      // ── promote-to-prod ─────────────────────────────────────────────────
      case 'promote-to-prod': {
        const confirmationToken = body?.confirmationToken as string | undefined;
        if (!confirmationToken) {
          return NextResponse.json(
            { error: 'confirmationToken er påkrævet for production-promotion' },
            { status: 400 }
          );
        }

        let result: Awaited<ReturnType<typeof promoteToProd>>;
        try {
          result = await promoteToProd(confirmationToken, user.id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[release-agent] promote-to-prod error:', msg);
          await logActivity('promote_prod_error', { error: msg }, user.id);
          return NextResponse.json({ error: msg }, { status: 422 });
        }

        return NextResponse.json({ ok: true, merged: result.merged, sha: result.sha });
      }

      default:
        return NextResponse.json({ error: `Ukendt action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    console.error('[release-agent POST]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}

// ─── GET: Activity log ────────────────────────────────────────────────────────

/**
 * GET /api/admin/release-agent?limit=50
 *
 * Returns the most recent activity log entries, newest first.
 *
 * Query params: limit (optional, default 50, max 200)
 * Returns: { activities: ActivityRecord[] }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await verifyAdmin();
    if (!user) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const limitParam = request.nextUrl.searchParams.get('limit');
    const limit = Math.min(parseInt(limitParam ?? '50', 10) || 50, 200);

    const { data: activities, error } = await adminDb()
      .from('service_manager_activity')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      return NextResponse.json({ error: 'Database fejl' }, { status: 500 });
    }

    return NextResponse.json({ activities: (activities ?? []) as ServiceManagerActivity[] });
  } catch (err) {
    console.error('[release-agent GET]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
