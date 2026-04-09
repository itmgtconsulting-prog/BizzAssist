/**
 * Service Manager Scan — /api/admin/service-manager/scan
 *
 * Performs the actual bug scan and persists results to the
 * service_manager_scans table. Called internally by the main
 * service-manager route — NOT intended to be called directly from the UI.
 *
 * POST /api/admin/service-manager/scan
 *   Body: { scanId: string }
 *
 *   Scan steps:
 *   1. Fetch recent Vercel deployments — detect failed builds
 *   2. Fetch Vercel function error events — detect runtime errors
 *   3. Categorize issues by type (build_error, runtime_error)
 *   4. Update the service_manager_scans record with results + status
 *
 *   Returns: { ok: true, scanId, issueCount }
 *
 * Requires VERCEL_API_TOKEN + VERCEL_PROJECT_ID for live data.
 * If credentials are absent, the scan completes with a config_error issue.
 *
 * Only accessible by admin users (app_metadata.isAdmin === true).
 *
 * @see app/api/admin/service-manager/route.ts — triggers this route
 * @see supabase/migrations/020_service_manager.sql — table schema
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ScanIssue, VercelDeployment } from '../route';

// ─── Vercel API helpers ───────────────────────────────────────────────────────

/** Base URL for the Vercel REST API */
const VERCEL_API = 'https://api.vercel.com';

/**
 * Build standard Vercel API request headers.
 *
 * @returns Headers object with Bearer auth token.
 */
function vercelHeaders(): HeadersInit {
  return { Authorization: `Bearer ${process.env.VERCEL_API_TOKEN ?? ''}` };
}

/**
 * Build Vercel API query params including optional teamId.
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
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.deployments ?? []) as VercelDeployment[];
  } catch {
    return null;
  }
}

/** A single event from the Vercel deployment events stream */
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
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const events: VercelEvent[] = await res.json();
    // Filter to only error-type events
    return events.filter(
      (e) => e.type === 'error' || (e.payload?.statusCode && e.payload.statusCode >= 500)
    );
  } catch {
    return [];
  }
}

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
    // Flag any recent failed builds
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
      // Deduplicate by message to avoid flooding from repeated errors
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

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * POST /api/admin/service-manager/scan
 *
 * Runs the bug scan and updates the service_manager_scans record.
 * Called internally by the service-manager POST route.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // Auth check — must be admin even for internal calls
    const user = await verifyAdmin();
    if (!user) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const scanId = body?.scanId as string | undefined;

    if (!scanId) {
      return NextResponse.json({ error: 'scanId påkrævet' }, { status: 400 });
    }

    const admin = createAdminClient();

    // Mark scan as running (idempotent — may already be 'running' from insert)
    await admin.from('service_manager_scans').update({ status: 'running' }).eq('id', scanId);

    // Run all checks
    let issues: ScanIssue[];
    let summary: string;
    let finalStatus: 'completed' | 'failed';

    try {
      const result = await runScan();
      issues = result.issues;
      summary = result.summary;
      finalStatus = 'completed';
    } catch (scanErr) {
      console.error('[service-manager/scan] runScan threw:', scanErr);
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
      finalStatus = 'failed';
    }

    // Persist results
    const { error: updateErr } = await admin
      .from('service_manager_scans')
      .update({
        status: finalStatus,
        issues_found: issues,
        summary,
      })
      .eq('id', scanId);

    if (updateErr) {
      console.error('[service-manager/scan] update error:', updateErr.code ?? '[DB error]');
    }

    return NextResponse.json({
      ok: true,
      scanId,
      issueCount: issues.length,
      status: finalStatus,
    });
  } catch (err) {
    console.error('[service-manager/scan POST]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
