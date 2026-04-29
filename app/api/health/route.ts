/**
 * Health check endpoint — GET /api/health
 *
 * Basic mode (default): Fast check for uptime monitors — DB ping only.
 * Deep mode (?deep=true): Full infrastructure audit — DB, Redis, external
 * APIs, mTLS certificates. Used by Service Manager and admin dashboard.
 *
 * Used by:
 *  - Uptime monitoring services (UptimeRobot, Checkly)
 *  - Load balancers and container orchestration
 *  - CI/CD post-deploy smoke tests
 *  - Service Manager hourly scan (deep mode)
 *  - ISO 27001 A.17 (Business Continuity) availability verification
 *
 * BIZZ-303: Extended with deep infrastructure checks.
 *
 * @returns HTTP 200 with service status when healthy
 * @returns HTTP 503 when a critical dependency is unavailable
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { checkAllCertificates, type CertExpiryInfo } from '@/app/lib/certExpiry';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

/** Shape of the health check response body */
/** BIZZ-1107: Data freshness info for en cache-tabel */
interface DataFreshnessEntry {
  table: string;
  row_count: number;
  newest_record: string | null;
  age_hours: number | null;
  status: 'fresh' | 'stale' | 'empty';
}

interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  version: string;
  environment: string;
  timestamp: string;
  uptime: number;
  checks: {
    api: 'ok' | 'error';
    database: 'ok' | 'error' | 'unconfigured';
    redis?: 'ok' | 'error' | 'unconfigured';
    external_apis?: Record<
      string,
      {
        status: 'ok' | 'slow' | 'down';
        latency_ms: number;
        /**
         * BIZZ-538: Probe is kept running after the service is scheduled to be
         * shut down (e.g. DAWA → 2026-07-01) so we can observe when the real
         * outage happens, but a `down` result on a deprecated probe does NOT
         * mark overall health as degraded.
         */
        deprecated?: boolean;
      }
    >;
    certificates?: CertExpiryInfo[];
    /** BIZZ-1107: Data freshness for cache-tabeller */
    data_freshness?: DataFreshnessEntry[];
  };
}

/**
 * Probes an external API with a lightweight request.
 *
 * @param name - Human-readable service name
 * @param url - URL to probe
 * @param options - Optional fetch options
 * @returns Status and latency
 */
async function probeApi(
  name: string,
  url: string,
  options?: RequestInit,
  opts?: { deprecated?: boolean }
): Promise<{
  name: string;
  status: 'ok' | 'slow' | 'down';
  latency_ms: number;
  deprecated?: boolean;
}> {
  const start = Date.now();
  const deprecated = opts?.deprecated === true ? true : undefined;
  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(5000),
    });
    const latency = Date.now() - start;
    // Auth-guarded services (401/403) are still considered reachable — the
    // service responded, it just rejected our anonymous probe. That is the
    // expected behaviour for Datafordeler GraphQL without credentials.
    if (!res.ok && res.status !== 401 && res.status !== 403) {
      return { name, status: 'down', latency_ms: latency, deprecated };
    }
    return { name, status: latency > 2000 ? 'slow' : 'ok', latency_ms: latency, deprecated };
  } catch {
    return { name, status: 'down', latency_ms: Date.now() - start, deprecated };
  }
}

/**
 * Checks Upstash Redis connectivity via REST API.
 *
 * @returns 'ok' | 'error' | 'unconfigured'
 */
async function checkRedis(): Promise<'ok' | 'error' | 'unconfigured'> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return 'unconfigured';

  try {
    const res = await fetch(`${url}/ping`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return 'error';
    const data = await res.json();
    return data?.result === 'PONG' ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

/**
 * GET /api/health
 * GET /api/health?deep=true — includes Redis, external APIs, certificates
 *
 * @param request - Incoming request
 * @returns JSON health status
 */
export async function GET(request: NextRequest): Promise<NextResponse<HealthStatus>> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as NextResponse<HealthStatus>;

  const isDeep = request.nextUrl.searchParams.get('deep') === 'true';

  // ── Check database connectivity ─────────────────────────────────────────
  let dbStatus: 'ok' | 'error' | 'unconfigured' = 'unconfigured';

  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    try {
      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      );
      const { error } = await supabase.auth.getSession();
      dbStatus = error ? 'error' : 'ok';
    } catch {
      dbStatus = 'error';
    }
  }

  // ── Assemble basic response ─────────────────────────────────────────────
  const isHealthy = dbStatus !== 'error';
  const healthStatus: HealthStatus = {
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

  // ── Deep checks (only when ?deep=true) ──────────────────────────────────
  if (isDeep) {
    try {
      // Redis
      healthStatus.checks.redis = await checkRedis();

      // External APIs — probe in parallel.
      //
      // BIZZ-538: The previous generic `datafordeler` probe only exercised the
      // BBR endpoint, which hid per-service outages (DAR down while BBR up
      // would look healthy). Each Datafordeler sub-service now gets its own
      // probe. GraphQL endpoints are queried with a trivial `{ __typename }`
      // introspection — auth-guarded services return 401/403 which probeApi
      // treats as reachable. The DAWA probe is kept with deprecated=true so
      // we can observe when Erhvervsstyrelsen actually pulls the plug
      // (scheduled 2026-07-01) without getting false-positive alerts once it
      // goes dark.
      const gqlIntrospect = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
      } satisfies RequestInit;
      const apiProbes = await Promise.all([
        probeApi('bbr', 'https://graphql.datafordeler.dk/BBR/v2', gqlIntrospect),
        probeApi('dar', 'https://graphql.datafordeler.dk/DAR/v1', gqlIntrospect),
        probeApi('mat', 'https://graphql.datafordeler.dk/MAT/v1', gqlIntrospect),
        probeApi('vur', 'https://graphql.datafordeler.dk/VUR/v2', gqlIntrospect),
        probeApi('cvr_es', 'http://distribution.virk.dk/cvr-permanent/virksomhed/_search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: { match_none: {} }, size: 0 }),
        }),
        probeApi(
          'dawa',
          'https://api.dataforsyningen.dk/autocomplete?q=test&per_side=1',
          undefined,
          { deprecated: true }
        ),
        probeApi('vurderingsportalen', 'https://api-fs.vurderingsportalen.dk/'),
      ]);

      healthStatus.checks.external_apis = {};
      for (const probe of apiProbes) {
        healthStatus.checks.external_apis[probe.name] = {
          status: probe.status,
          latency_ms: probe.latency_ms,
          ...(probe.deprecated ? { deprecated: true } : {}),
        };
      }

      // BIZZ-1107: Data freshness — check cache-tabellernes seneste sync
      try {
        // Brug admin client med fallback til anon key
        let adminClient;
        try {
          adminClient = createAdminClient();
        } catch {
          adminClient = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
          );
        }
        const freshnessQueries = [
          { table: 'cvr_virksomhed', col: 'sidst_hentet_fra_cvr', maxAgeHours: 168 },
          { table: 'ejf_ejerskab', col: 'sidst_opdateret', maxAgeHours: 168 },
          { table: 'cvr_deltagerrelation', col: 'sidst_hentet_fra_cvr', maxAgeHours: 168 },
          { table: 'cvr_deltager', col: 'sidst_hentet_fra_cvr', maxAgeHours: 168 },
          { table: 'bbr_ejendom_status', col: 'sidst_opdateret', maxAgeHours: 336 },
        ];
        const freshnessResults: DataFreshnessEntry[] = [];
        for (const q of freshnessQueries) {
          try {
            const {
              data,
              count,
              error: qErr,
            } = await adminClient
              .from(q.table)
              .select(q.col, { count: 'exact' })
              .order(q.col, { ascending: false })
              .limit(1);
            if (qErr) {
              logger.error(`[health] freshness query ${q.table}:`, qErr.message);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const newest = data?.[0] ? ((data[0] as any)[q.col] as string | null) : null;
            const ageMs = newest ? Date.now() - new Date(newest).getTime() : null;
            const ageHours = ageMs != null ? Math.round(ageMs / 3600000) : null;
            freshnessResults.push({
              table: q.table,
              row_count: count ?? 0,
              newest_record: newest,
              age_hours: ageHours,
              status:
                count === 0
                  ? 'empty'
                  : ageHours != null && ageHours > q.maxAgeHours
                    ? 'stale'
                    : 'fresh',
            });
          } catch {
            freshnessResults.push({
              table: q.table,
              row_count: 0,
              newest_record: null,
              age_hours: null,
              status: 'empty',
            });
          }
        }
        healthStatus.checks.data_freshness = freshnessResults;

        // Stale data degrades health
        const staleTables = freshnessResults.filter((f) => f.status === 'stale');
        if (staleTables.length > 0) {
          healthStatus.status = 'degraded';
        }
      } catch (err) {
        logger.error('[health] Data freshness check error:', err);
      }

      // mTLS Certificates
      healthStatus.checks.certificates = checkAllCertificates();

      // Update overall status based on deep checks
      if (healthStatus.checks.redis === 'error') {
        healthStatus.status = 'degraded';
      }
      // BIZZ-538: A deprecated probe going `down` is informational only — the
      // service is scheduled to be shut down, so alerting on it once the
      // shutdown lands would be false-positive noise.
      const downApis = apiProbes.filter((p) => p.status === 'down' && !p.deprecated);
      if (downApis.length > 0) {
        healthStatus.status = 'degraded';
      }
      const expiredCerts = (healthStatus.checks.certificates ?? []).filter(
        (c) => c.status === 'expired' || c.status === 'critical'
      );
      if (expiredCerts.length > 0) {
        healthStatus.status = 'degraded';
      }
    } catch (err) {
      logger.error('[health] Deep check error:', err);
    }
  }

  return NextResponse.json(healthStatus, {
    status: healthStatus.status === 'down' ? 503 : healthStatus.status === 'degraded' ? 503 : 200,
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
