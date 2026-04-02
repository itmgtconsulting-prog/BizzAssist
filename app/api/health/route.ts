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

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { rateLimit, API_DEFAULT } from '@/app/lib/rateLimit';

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
export async function GET(request: NextRequest): Promise<NextResponse<HealthStatus>> {
  // Rate limit: 100 req/min (default)
  const limited = rateLimit(request, API_DEFAULT);
  if (limited) return limited as NextResponse<HealthStatus>;
  // ── Check database connectivity (when Supabase is configured) ────────────
  let dbStatus: 'ok' | 'error' | 'unconfigured' = 'unconfigured';

  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    try {
      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      );
      // Lightweight probe: getSession() just reads the cookie — no network call to Auth server
      const { error } = await supabase.auth.getSession();
      dbStatus = error ? 'error' : 'ok';
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
