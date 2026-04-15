/**
 * Service Manager API — /api/admin/service-manager
 *
 * Admin-only endpoint for the Service Manager monitoring tool (BIZZ-86).
 * Provides deployment status from the Vercel API and recent scan history
 * from the service_manager_scans Supabase table.
 *
 * GET  /api/admin/service-manager
 *   Returns:
 *     - deployments: recent Vercel deployments (requires VERCEL_API_TOKEN + VERCEL_PROJECT_ID)
 *     - scans:       last 20 scan records from service_manager_scans
 *     - configured:  boolean — whether Vercel credentials are present
 *
 * POST /api/admin/service-manager
 *   Body: { action: 'scan' }
 *   Triggers a new bug scan by calling /api/admin/service-manager/scan internally.
 *   Returns: { scanId: string, message: string }
 *
 * Only accessible by admin users (app_metadata.isAdmin === true).
 *
 * @see app/api/admin/service-manager/scan/route.ts — scan implementation
 * @see app/dashboard/admin/service-manager/page.tsx — UI
 * @see supabase/migrations/020_service_manager.sql — table schema
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ServiceManagerScan } from '@/lib/supabase/types';
import { logger } from '@/app/lib/logger';
import { parseBody } from '@/app/lib/validate';

/** Zod schema for POST /api/admin/service-manager request body */
const serviceManagerPostSchema = z.object({
  action: z.literal('scan'),
}).passthrough();

// ─── Types ───────────────────────────────────────────────────────────────────

/** A Vercel deployment as returned by the Vercel API v6 */
export interface VercelDeployment {
  uid: string;
  name: string;
  url: string;
  state: 'READY' | 'ERROR' | 'BUILDING' | 'CANCELED' | 'QUEUED' | string;
  target: 'production' | 'preview' | null;
  createdAt: number;
  buildingAt: number | null;
  ready: number | null;
  meta: {
    githubCommitRef?: string;
    githubCommitMessage?: string;
    githubCommitAuthorName?: string;
  };
}

/** A scan record from the service_manager_scans table */
export interface ScanRecord {
  id: string;
  created_at: string;
  scan_type: 'manual' | 'scheduled' | 'triggered';
  issues_found: ScanIssue[];
  status: 'running' | 'completed' | 'failed';
  resolved_at: string | null;
  summary: string | null;
  triggered_by: string | null;
}

/** A single issue found during a scan */
export interface ScanIssue {
  type: 'build_error' | 'runtime_error' | 'type_error' | 'config_error';
  severity: 'error' | 'warning';
  message: string;
  source: 'vercel_build' | 'vercel_logs' | 'static';
  context?: string;
}

// ─── Admin verification ───────────────────────────────────────────────────────

/**
 * Verify the caller is a BizzAssist admin.
 * Reads app_metadata.isAdmin from Supabase Auth via the admin client.
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

// ─── Vercel API helpers ───────────────────────────────────────────────────────

/** Base URL for the Vercel REST API */
const VERCEL_API = 'https://api.vercel.com';

/**
 * Fetch recent deployments from the Vercel API.
 * Requires VERCEL_API_TOKEN and VERCEL_PROJECT_ID env vars.
 *
 * @returns Array of deployments, or null if credentials are missing.
 */
async function fetchVercelDeployments(): Promise<VercelDeployment[] | null> {
  const token = process.env.VERCEL_API_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !projectId) return null;

  const teamId = process.env.VERCEL_TEAM_ID;
  const params = new URLSearchParams({
    projectId,
    limit: '10',
    ...(teamId ? { teamId } : {}),
  });

  try {
    const res = await fetch(`${VERCEL_API}/v6/deployments?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.deployments ?? []) as VercelDeployment[];
  } catch {
    return null;
  }
}

// ─── Route handlers ───────────────────────────────────────────────────────────

/**
 * GET /api/admin/service-manager
 *
 * Returns recent deployments from Vercel and the last 20 scan records.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const user = await verifyAdmin();
    if (!user) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Fetch deployments and scan history in parallel.
    const adminAny = createAdminClient();
    const [deployments, scansResult] = await Promise.all([
      fetchVercelDeployments(),
      adminAny
        .from('service_manager_scans')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

    const scans: ScanRecord[] = (scansResult.data ?? []) as ScanRecord[];

    return NextResponse.json({
      deployments: deployments ?? [],
      scans,
      configured: !!(process.env.VERCEL_API_TOKEN && process.env.VERCEL_PROJECT_ID),
    });
  } catch (err) {
    logger.error('[service-manager GET]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}

/**
 * POST /api/admin/service-manager
 *
 * Triggers a new bug scan. Creates a scan record in Supabase, then
 * calls the scan endpoint to populate it asynchronously.
 *
 * Body: { action: 'scan' }
 * Returns: { scanId, message }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await verifyAdmin();
    if (!user) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const parsed = await parseBody(request, serviceManagerPostSchema);
    if (!parsed.success) return parsed.response;
    // action is guaranteed to be 'scan' by the schema

    // Create the scan record in state 'running'.
    const admin = createAdminClient();
    const { data: scanData, error: insertErr } = await admin
      .from('service_manager_scans')
      .insert({
        scan_type: 'manual',
        status: 'running',
        triggered_by: user.id,
        summary: null,
        issues_found: [] as unknown[],
      })
      .select('id')
      .single();
    const scan = scanData as Pick<ServiceManagerScan, 'id'> | null;

    if (insertErr || !scan) {
      logger.error('[service-manager POST] insert error:', insertErr?.code ?? '[DB error]');
      return NextResponse.json({ error: 'Kunne ikke oprette scan' }, { status: 500 });
    }

    // Trigger the scan in the background — fire and forget.
    // The scan route updates the record when done.
    // BIZZ-174: Use a hardcoded internal base URL from env rather than the
    // request Origin header. The Origin header is controlled by the caller and
    // could be used to make the server fetch an arbitrary URL (SSRF).
    const internalBase = process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk';
    void fetch(`${internalBase}/api/admin/service-manager/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanId: scan.id }),
    }).catch((err) => logger.error('[service-manager] scan error:', err));

    return NextResponse.json({
      scanId: scan.id,
      message: 'Scan startet',
    });
  } catch (err) {
    logger.error('[service-manager POST]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
