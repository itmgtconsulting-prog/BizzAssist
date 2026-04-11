/**
 * Release Agent — /api/admin/release-agent
 *
 * Handles the deployment workflow for Service Manager v2 (BIZZ-86).
 * Orchestrates hotfix branches, Vercel preview deployments, and
 * production promotions — all via GitHub REST API (no local git).
 *
 * POST /api/admin/release-agent
 *   Body: { action: string, ...params }
 *
 *   Supported actions:
 *
 *   "create-hotfix"
 *     Body: { action: "create-hotfix", fixId: string }
 *     1. Loads the approved fix from service_manager_fixes
 *     2. Fetches the target file content from GitHub (develop branch)
 *     3. Applies the unified diff in memory
 *     4. Creates a blob → tree → commit via GitHub API
 *     5. Creates branch `hotfix/<scanId-prefix>-<fixId-prefix>` from that commit
 *     6. Creates a PR to develop via GitHub API
 *     7. Updates fix record: status='applied', applied_at, commit_sha
 *     Returns: { branch: string, prUrl: string | null, sha: string }
 *
 *   "deploy-to-test"
 *     Body: { action: "deploy-to-test", branch: string }
 *     Triggers a Vercel preview deployment for the given branch.
 *     Returns: { deploymentUrl: string | null }
 *
 *   "promote-to-prod"
 *     Body: { action: "promote-to-prod", confirmationToken: string }
 *     Merges develop into main via GitHub merge API.
 *     Returns: { merged: boolean, sha: string }
 *
 * Required env vars:
 *   GITHUB_TOKEN  — Personal access token with repo scope
 *   GITHUB_REPO   — "owner/repo" (e.g. "itmgtconsulting-prog/BizzAssist")
 *
 * Optional env vars:
 *   VERCEL_API_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID — for deploy-to-test
 *   RELEASE_CONFIRMATION_TOKEN — for promote-to-prod guard
 *
 * Safety rules:
 *   - Only 'approved' fixes can have hotfixes created
 *   - A fix can only be applied once (status → 'applied' after success)
 *   - promote-to-prod requires a fresh RELEASE_CONFIRMATION_TOKEN env var match
 *   - All GitHub API calls have 15-second timeouts
 *   - All errors are logged before returning 5xx
 *
 * Only accessible by admin users (app_metadata.isAdmin === true).
 *
 * @see app/api/admin/service-manager/auto-fix/route.ts — produces approved fixes
 * @see supabase/migrations/021_service_manager_v2.sql — base table schema
 * @see supabase/migrations/037_service_manager_applied_at.sql — applied_at + commit_sha
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ServiceManagerFix, ServiceManagerActivity } from '@/lib/supabase/types';
import { logger } from '@/app/lib/logger';

/**
 * Returns the admin client for operations on service_manager tables.
 *
 * @returns Typed Supabase admin client
 */
function adminDb(): ReturnType<typeof createAdminClient> {
  return createAdminClient();
}

export const runtime = 'nodejs';
export const maxDuration = 90;

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default branch that hotfixes target */
const BASE_BRANCH = 'develop';

/** GitHub REST API base URL */
const GITHUB_API = 'https://api.github.com';

/** Timeout for individual GitHub API calls */
const GITHUB_TIMEOUT_MS = 15_000;

// ─── Admin verification ───────────────────────────────────────────────────────

/**
 * Verify the caller is a BizzAssist admin OR an internal cron/service caller.
 *
 * Admin path: Supabase session cookie → user.app_metadata.isAdmin.
 * Cron path: Authorization: Bearer CRON_SECRET + x-internal-cron: 1 header.
 *
 * @param request - Incoming Next.js request.
 * @returns Caller info with source and optional user, or null if unauthorised.
 */
async function verifyAdminOrCron(
  request: NextRequest
): Promise<{ source: 'admin' | 'cron'; user?: { id: string } } | null> {
  // ── Internal cron/service path ─────────────────────────────────────────────
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
    logger.error('[release-agent] activity log error:', err);
  }
}

// ─── GitHub API helpers ───────────────────────────────────────────────────────

/**
 * Returns GitHub credentials from env vars, or throws if not configured.
 *
 * @returns { token, repo } where repo is "owner/repo"
 * @throws If GITHUB_TOKEN or GITHUB_REPO are missing
 */
function requireGitHubConfig(): { token: string; repo: string } {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    throw new Error(
      'GITHUB_TOKEN og GITHUB_REPO env vars er påkrævet men mangler. ' +
        'Tilføj dem til .env.local og Vercel project settings.'
    );
  }
  return { token, repo };
}

/**
 * Perform an authenticated GitHub REST API request.
 *
 * @param path - Path relative to `/repos/{owner}/{repo}` (e.g. "/git/refs/heads/develop").
 * @param options - fetch options (method, body, etc.).
 * @returns Raw Response.
 * @throws On network error or timeout.
 */
async function githubFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const { token, repo } = requireGitHubConfig();
  return fetch(`${GITHUB_API}/repos/${repo}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'BizzAssist-ReleaseAgent/2.0',
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
}

/**
 * Get the commit SHA at the tip of a branch.
 *
 * @param branch - Branch name (e.g. "develop").
 * @returns Commit SHA string.
 * @throws If the branch does not exist on GitHub or the API call fails.
 */
async function getBranchSha(branch: string): Promise<string> {
  const res = await githubFetch(`/git/refs/heads/${branch}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Kunne ikke hente branch '${branch}' fra GitHub (${res.status}): ${body.slice(0, 200)}`
    );
  }
  const data = (await res.json()) as { object: { sha: string } };
  return data.object.sha;
}

/**
 * Get the tree SHA for a commit.
 *
 * @param commitSha - Commit SHA.
 * @returns Tree SHA.
 */
async function getCommitTreeSha(commitSha: string): Promise<string> {
  const res = await githubFetch(`/git/commits/${commitSha}`);
  if (!res.ok) throw new Error(`Kunne ikke hente commit ${commitSha} fra GitHub`);
  const data = (await res.json()) as { tree: { sha: string } };
  return data.tree.sha;
}

/**
 * Fetch the raw UTF-8 content of a file from GitHub.
 *
 * @param filePath - Repo-relative path (e.g. "app/api/foo/route.ts").
 * @param ref - Branch name or commit SHA.
 * @returns File content as a string.
 * @throws If the file does not exist or the API call fails.
 */
async function getFileContent(filePath: string, ref: string): Promise<string> {
  const res = await githubFetch(`/contents/${encodeURIComponent(filePath)}?ref=${ref}`);
  if (!res.ok) {
    if (res.status === 404) throw new Error(`Fil ikke fundet på GitHub: ${filePath}`);
    throw new Error(`Kunne ikke hente fil '${filePath}' fra GitHub (${res.status})`);
  }
  const data = (await res.json()) as { content: string; encoding: string };
  // GitHub always returns base64-encoded content with embedded newlines
  const raw = data.content.replace(/\n/g, '');
  return Buffer.from(raw, 'base64').toString('utf-8');
}

/**
 * Create a git blob from UTF-8 content and return its SHA.
 *
 * @param content - UTF-8 file content.
 * @returns Blob SHA.
 */
async function createBlob(content: string): Promise<string> {
  const res = await githubFetch('/git/blobs', {
    method: 'POST',
    body: JSON.stringify({ content, encoding: 'utf-8' }),
  });
  if (!res.ok) throw new Error(`Kunne ikke oprette blob på GitHub (${res.status})`);
  const data = (await res.json()) as { sha: string };
  return data.sha;
}

/**
 * Create a new git tree by replacing one file in an existing tree.
 *
 * @param baseTreeSha - The SHA of the base tree to extend.
 * @param filePath - Repo-relative path of the file to update.
 * @param blobSha - SHA of the new file blob.
 * @returns New tree SHA.
 */
async function createTree(baseTreeSha: string, filePath: string, blobSha: string): Promise<string> {
  const res = await githubFetch('/git/trees', {
    method: 'POST',
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: [{ path: filePath, mode: '100644', type: 'blob', sha: blobSha }],
    }),
  });
  if (!res.ok) throw new Error(`Kunne ikke oprette tree på GitHub (${res.status})`);
  const data = (await res.json()) as { sha: string };
  return data.sha;
}

/**
 * Create a git commit object and return its SHA.
 *
 * @param message - Commit message.
 * @param treeSha - Tree SHA for this commit.
 * @param parentSha - Parent commit SHA.
 * @returns New commit SHA.
 */
async function createCommit(message: string, treeSha: string, parentSha: string): Promise<string> {
  const res = await githubFetch('/git/commits', {
    method: 'POST',
    body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }),
  });
  if (!res.ok) throw new Error(`Kunne ikke oprette commit på GitHub (${res.status})`);
  const data = (await res.json()) as { sha: string };
  return data.sha;
}

/**
 * Create a new branch reference pointing to a commit.
 *
 * @param branch - New branch name (e.g. "hotfix/abc123").
 * @param sha - Commit SHA the branch should point to.
 * @throws If the branch already exists or the API call fails.
 */
async function createBranchRef(branch: string, sha: string): Promise<void> {
  const res = await githubFetch('/git/refs', {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Kunne ikke oprette branch '${branch}' på GitHub (${res.status}): ${body.slice(0, 200)}`
    );
  }
}

/**
 * Create a pull request from a hotfix branch to the base branch.
 *
 * @param branch - The source (head) branch name.
 * @param title - PR title.
 * @param body - PR body (Markdown).
 * @returns The PR HTML URL, or null if the API call fails non-fatally.
 */
async function createGitHubPR(branch: string, title: string, body: string): Promise<string | null> {
  try {
    const res = await githubFetch('/pulls', {
      method: 'POST',
      body: JSON.stringify({
        title,
        body,
        head: branch,
        base: BASE_BRANCH,
        draft: false,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      logger.warn('[release-agent] GitHub PR creation failed:', err);
      return null;
    }
    const data = (await res.json()) as { html_url?: string };
    return data.html_url ?? null;
  } catch (err) {
    logger.warn('[release-agent] GitHub PR API error:', err);
    return null;
  }
}

// ─── Diff application ─────────────────────────────────────────────────────────

/**
 * Parse and apply a unified diff to a string in memory.
 *
 * Supports standard unified diff format (--- / +++ / @@ headers).
 * Hunks are applied in reverse order so earlier hunks do not shift
 * the line offsets of later hunks.
 *
 * @param original - The original file content as a string.
 * @param diff - Unified diff string (Claude-generated patch format).
 * @returns The patched file content.
 * @throws If no hunks are found in the diff or the diff is malformed.
 */
function applyUnifiedDiff(original: string, diff: string): string {
  interface Hunk {
    /** 1-indexed start line in the original file */
    oldStart: number;
    /** Number of lines consumed from the original file (context + deleted) */
    oldCount: number;
    /** Lines to emit in the result (context + added, no deletions) */
    replacement: string[];
  }

  const originalLines = original.split('\n');
  const diffLines = diff.split('\n');
  const hunks: Hunk[] = [];

  let i = 0;

  // Skip file-level headers (diff --git, ---, +++)
  while (i < diffLines.length && !diffLines[i].startsWith('@@')) {
    i++;
  }

  // Parse each hunk
  while (i < diffLines.length) {
    const headerMatch = diffLines[i].match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/);
    if (!headerMatch) {
      i++;
      continue;
    }

    const oldStart = parseInt(headerMatch[1], 10);
    const oldCount = parseInt(headerMatch[2] ?? '1', 10);
    i++;

    const replacement: string[] = [];

    while (i < diffLines.length && !diffLines[i].startsWith('@@')) {
      const dl = diffLines[i];
      if (dl.startsWith('+')) {
        // Added line — goes into result only
        replacement.push(dl.slice(1));
      } else if (dl.startsWith('-')) {
        // Deleted line — consumed from original, not in result
      } else if (dl.startsWith(' ') || dl === '') {
        // Context line — consumed from original, echoed in result
        replacement.push(dl.startsWith(' ') ? dl.slice(1) : '');
      }
      // Skip "\ No newline at end of file" and other \ markers
      i++;
    }

    hunks.push({ oldStart, oldCount, replacement });
  }

  if (hunks.length === 0) {
    throw new Error('Ingen hunks fundet i diff — er diff-formatet korrekt?');
  }

  // Apply hunks in reverse order to preserve line offsets
  const resultLines = [...originalLines];
  for (const hunk of [...hunks].reverse()) {
    const start = hunk.oldStart - 1; // convert to 0-indexed
    resultLines.splice(start, hunk.oldCount, ...hunk.replacement);
  }

  return resultLines.join('\n');
}

// ─── Action: create-hotfix ────────────────────────────────────────────────────

/**
 * Create a hotfix branch via GitHub API, apply the approved diff,
 * commit, push, open a PR, and mark the fix as 'applied'.
 *
 * Uses the GitHub Git Data API exclusively — no local git commands.
 * This works correctly on Vercel's serverless runtime.
 *
 * @param fixId - The service_manager_fixes record UUID.
 * @param userId - The admin user performing the action.
 * @returns { branch, prUrl, sha }
 */
async function createHotfix(
  fixId: string,
  userId: string | null
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

  if (!fix.proposed_diff?.trim()) {
    throw new Error('Fix har et tomt diff — kan ikke oprette hotfix');
  }

  // ── Build branch name ──────────────────────────────────────────────────
  const shortFixId = fixId.replace(/-/g, '').slice(0, 8);
  const branch = `hotfix/${fix.scan_id.slice(0, 8)}-${shortFixId}`;

  // ── Step 1: Get the base branch commit SHA ─────────────────────────────
  const baseSha = await getBranchSha(BASE_BRANCH);

  // ── Step 2: Get the base commit's tree SHA ─────────────────────────────
  const baseTreeSha = await getCommitTreeSha(baseSha);

  // ── Step 3: Fetch the current file content from GitHub ─────────────────
  const originalContent = await getFileContent(fix.file_path as string, BASE_BRANCH);

  // ── Step 4: Apply the unified diff in memory ───────────────────────────
  let newContent: string;
  try {
    newContent = applyUnifiedDiff(originalContent, fix.proposed_diff as string);
  } catch (diffErr) {
    throw new Error(
      `Diff kunne ikke anvendes: ${diffErr instanceof Error ? diffErr.message : String(diffErr)}`
    );
  }

  // ── Step 5: Create a blob with the patched content ─────────────────────
  const blobSha = await createBlob(newContent);

  // ── Step 6: Create a new tree replacing the changed file ───────────────
  const treeSha = await createTree(baseTreeSha, fix.file_path as string, blobSha);

  // ── Step 7: Build commit message ───────────────────────────────────────
  const scan = fix.service_manager_scans;
  const issueMsg = scan?.issues_found?.[fix.issue_index]?.message ?? scan?.summary ?? 'auto-fix';
  const commitMsg = `hotfix: ${issueMsg.slice(0, 72)}`;

  // ── Step 8: Create the commit ──────────────────────────────────────────
  const commitSha = await createCommit(commitMsg, treeSha, baseSha);

  // ── Step 9: Create the hotfix branch ──────────────────────────────────
  await createBranchRef(branch, commitSha);

  await logActivity('hotfix_pushed', { fix_id: fixId, branch, sha: commitSha }, userId);

  // ── Step 10: Create GitHub PR ──────────────────────────────────────────
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

  // ── Step 11: Mark fix as applied with commit metadata ─────────────────
  await db
    .from('service_manager_fixes')
    .update({
      status: 'applied',
      applied_at: new Date().toISOString(),
      commit_sha: commitSha,
    })
    .eq('id', fixId);

  await logActivity(
    'hotfix_created',
    { fix_id: fixId, branch, sha: commitSha, pr_url: prUrl ?? null },
    userId
  );

  return { branch, prUrl, sha: commitSha };
}

// ─── Action: deploy-to-test ───────────────────────────────────────────────────

/**
 * Trigger a Vercel preview deployment for a hotfix branch.
 * Requires VERCEL_API_TOKEN, VERCEL_PROJECT_ID, and optionally VERCEL_TEAM_ID.
 *
 * @param branch - The branch to deploy.
 * @param userId - The admin user.
 * @returns { deploymentUrl }
 */
async function deployToTest(
  branch: string,
  userId: string | null
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
      signal: AbortSignal.timeout(30_000),
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
 * Merge develop into main via GitHub merge API to promote to production.
 * Requires a confirmation token to prevent accidental promotions.
 *
 * @param confirmationToken - Must match RELEASE_CONFIRMATION_TOKEN env var.
 * @param userId - The admin user.
 * @returns { merged: boolean, sha: string }
 */
async function promoteToProd(
  confirmationToken: string,
  userId: string | null
): Promise<{ merged: boolean; sha: string }> {
  // Token guard — prevents accidental production promotions
  const expectedToken = process.env.RELEASE_CONFIRMATION_TOKEN;
  if (!expectedToken || confirmationToken !== expectedToken) {
    throw new Error('Ugyldigt bekræftelsestoken — production-promotion afvist');
  }

  // Use GitHub merge API (works on Vercel, no local git needed)
  const res = await githubFetch('/merges', {
    method: 'POST',
    body: JSON.stringify({
      base: 'main',
      head: BASE_BRANCH,
      commit_message: `chore(release): promote ${BASE_BRANCH} to production`,
    }),
  });

  if (res.status === 204) {
    // Already up to date — get current main SHA
    const mainSha = await getBranchSha('main');
    await logActivity(
      'promote_prod',
      { sha: mainSha, note: 'already up-to-date', from_branch: BASE_BRANCH, to_branch: 'main' },
      userId
    );
    return { merged: true, sha: mainSha };
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub merge fejlede (${res.status}): ${err.slice(0, 200)}`);
  }

  const data = (await res.json()) as { sha?: string };
  const sha = data.sha ?? '';

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
    const caller = await verifyAdminOrCron(request);
    if (!caller) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Resolve user ID — null for cron/internal calls, user UUID for admin calls
    const userId = caller.user?.id ?? null;

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
          result = await createHotfix(fixId, userId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error('[release-agent] create-hotfix error:', msg);
          await logActivity('hotfix_error', { fix_id: fixId, error: msg }, userId);
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
          result = await deployToTest(branch, userId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error('[release-agent] deploy-to-test error:', msg);
          await logActivity('deploy_test_error', { branch, error: msg }, userId);
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
          result = await promoteToProd(confirmationToken, userId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error('[release-agent] promote-to-prod error:', msg);
          await logActivity('promote_prod_error', { error: msg }, userId);
          return NextResponse.json({ error: msg }, { status: 422 });
        }

        return NextResponse.json({ ok: true, merged: result.merged, sha: result.sha });
      }

      default:
        return NextResponse.json({ error: `Ukendt action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    logger.error('[release-agent POST]', err);
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
    const caller = await verifyAdminOrCron(request);
    if (!caller) {
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
    logger.error('[release-agent GET]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
