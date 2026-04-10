/**
 * Cron: ISR cache revalidation — /api/cron/warm-cache (BIZZ-95)
 *
 * Revalidates Next.js ISR cache for the top 50 most-viewed properties over
 * the last 30 days, derived from tenant.activity_log. Also revalidates the
 * main dashboard and listing pages so stale data is evicted proactively.
 *
 * Workflow:
 *   1. Authenticates via CRON_SECRET bearer token
 *   2. Queries activity_log across all tenant schemas for the top 50 BFE
 *      numbers (event_type = 'property_open', last 30 days)
 *   3. Calls revalidatePath() for each `/dashboard/ejendomme/<bfe>` path
 *   4. Also revalidates `/dashboard`, `/dashboard/companies`, `/dashboard/ejendomme`
 *   5. Returns { revalidated, paths }
 *
 * Security:
 *   - Requires `Authorization: Bearer <CRON_SECRET>` header
 *   - In production also requires `x-vercel-cron: 1` header (Vercel auto-sets this)
 *
 * Trigger:
 *   - Vercel Cron: "0 4 * * *" (04:00 UTC daily) — configured in vercel.json
 *   - Manual: GET /api/cron/warm-cache with Authorization: Bearer <CRON_SECRET>
 *
 * GDPR / Data retention:
 *   - Only aggregated BFE counts are processed; no PII is read or stored
 *   - activity_log retention: 12 months (enforced by /api/cron/purge-old-data)
 *
 * @module api/cron/warm-cache
 */
import { revalidatePath } from 'next/cache';
import { NextRequest, NextResponse } from 'next/server';

import { createAdminClient, tenantDb } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';

/** Maximum number of popular BFE numbers to revalidate per run */
const MAX_BFE = 50;

/** Look-back window in days for the popularity query */
const LOOKBACK_DAYS = 30;

/**
 * Static paths that are always revalidated on every run regardless of
 * activity data, as they aggregate data from many sub-pages.
 */
const STATIC_PATHS: string[] = ['/dashboard', '/dashboard/companies', '/dashboard/ejendomme'];

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Validates the incoming request against the configured CRON_SECRET.
 * In production Vercel deployments, additionally requires the
 * `x-vercel-cron: 1` header that Vercel injects automatically.
 *
 * @param request - Incoming Next.js request
 * @returns `true` if the request is authenticated
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

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

/**
 * Represents a single row returned by the popularity aggregation query.
 */
interface BfeCount {
  /** BFE number extracted from activity_log.payload->>'bfeNummer' */
  bfe_nummer: string;
  /** Number of 'property_open' events in the lookback window */
  event_count: number;
}

/**
 * Queries all tenant schemas for the top `MAX_BFE` BFE numbers by
 * `property_open` event count over the last `LOOKBACK_DAYS` days.
 *
 * Implementation note: Because each tenant has its own Postgres schema we
 * cannot do a cross-schema GROUP BY in a single PostgREST call. Instead we
 * iterate tenant schemas and merge the per-tenant top lists in JS, then sort
 * globally. This is acceptable for ≤200 tenants; revisit if tenant count grows.
 *
 * @returns Array of { bfe_nummer, event_count } sorted descending by count
 */
async function fetchTopBfeNumbers(): Promise<BfeCount[]> {
  const admin = createAdminClient();

  // Fetch all tenant schema names
  const { data: tenants, error: tenantErr } = (await admin
    .from('tenants')
    .select('schema_name')) as {
    data: { schema_name: string }[] | null;
    error: unknown;
  };

  if (tenantErr || !tenants) {
    console.error('[warm-cache] Could not fetch tenants:', tenantErr);
    return [];
  }

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Accumulate BFE counts across all tenant schemas
  const aggregated = new Map<string, number>();

  for (const tenant of tenants) {
    try {
      const db = tenantDb(tenant.schema_name);

      // Fetch raw activity_log rows for this tenant (PostgREST cannot GROUP BY
      // on a JSONB sub-key via the JS client, so we do aggregation in JS)
      const { data: rows } = (await db
        .from('activity_log')
        .select('payload')
        .eq('event_type', 'property_open')
        .gte('created_at', cutoff)
        .not('payload->bfeNummer', 'is', null)
        .limit(5000)) as { data: { payload: Record<string, unknown> }[] | null };

      if (!rows) continue;

      for (const row of rows) {
        const bfe = row.payload?.bfeNummer;
        if (typeof bfe !== 'string' || !bfe) continue;
        aggregated.set(bfe, (aggregated.get(bfe) ?? 0) + 1);
      }
    } catch (err) {
      // Non-fatal: skip tenant if schema query fails (e.g. schema still provisioning)
      console.warn(`[warm-cache] Skipped tenant ${tenant.schema_name}:`, err);
    }
  }

  // Sort globally and take the top MAX_BFE
  return Array.from(aggregated.entries())
    .map(([bfe_nummer, event_count]) => ({ bfe_nummer, event_count }))
    .sort((a, b) => b.event_count - a.event_count)
    .slice(0, MAX_BFE);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * GET /api/cron/warm-cache
 *
 * Revalidates ISR cache paths for the most-viewed properties plus static
 * dashboard listing pages. Returns a JSON summary of what was revalidated.
 *
 * @param request - Incoming Next.js request (used for auth header check)
 * @returns JSON: { revalidated: number, paths: string[] }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 1. Fetch top BFE numbers from activity_log
  const topBfe = await fetchTopBfeNumbers();

  console.log(
    `[warm-cache] Top ${topBfe.length} BFE numbers fetched (lookback: ${LOOKBACK_DAYS} days)`
  );

  // 2. Build the list of paths to revalidate
  const bfePaths = topBfe.map(({ bfe_nummer }) => `/dashboard/ejendomme/${bfe_nummer}`);
  const allPaths = [...STATIC_PATHS, ...bfePaths];

  // 3. Revalidate each path
  for (const path of allPaths) {
    revalidatePath(path);
  }

  console.log(`[warm-cache] Revalidated ${allPaths.length} paths`);

  return NextResponse.json({
    revalidated: allPaths.length,
    paths: allPaths,
  });
}
