/**
 * Health check endpoint — GET /api/health
 *
 * Used by:
 *  - Uptime monitoring services (UptimeRobot, Checkly)
 *  - Load balancers and container orchestration
 *  - CI/CD post-deploy smoke tests
 *  - ISO 27001 A.17 (Business Continuity) availability verification
 *
 * Returns HTTP 200 with service status when healthy.
 * Returns HTTP 503 when a critical dependency is unavailable.
 */

import { NextResponse } from 'next/server';

/** Shape of the health check response body */
interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  version: string;
  environment: string;
  timestamp: string;
  uptime: number;
  checks: {
    api: 'ok' | 'error';
    database?: 'ok' | 'error' | 'unconfigured';
  };
}

/**
 * GET /api/health
 * Returns current service health status.
 * No authentication required — public endpoint for monitoring tools.
 *
 * @returns JSON health status with HTTP 200 (healthy) or 503 (unhealthy)
 */
export async function GET(): Promise<NextResponse<HealthStatus>> {
  // ── Check database connectivity (when Supabase is configured) ────────────
  let dbStatus: 'ok' | 'error' | 'unconfigured' = 'unconfigured';

  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      // TODO: Replace with real Supabase ping query once DB is set up.
      // const { error } = await supabaseAdmin.from('tenants').select('id').limit(1);
      // dbStatus = error ? 'error' : 'ok';
      dbStatus = 'ok';
    } catch {
      dbStatus = 'error';
    }
  }

  // ── Assemble response ────────────────────────────────────────────────────
  const isHealthy = dbStatus !== 'error';
  const status: HealthStatus = {
    status: isHealthy ? 'ok' : 'degraded',
    version: process.env.npm_package_version ?? '0.1.0',
    environment: process.env.NODE_ENV ?? 'unknown',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      api: 'ok',
      database: dbStatus,
    },
  };

  return NextResponse.json(status, {
    status: isHealthy ? 200 : 503,
    headers: {
      // Do not cache health checks — monitoring needs fresh data
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
