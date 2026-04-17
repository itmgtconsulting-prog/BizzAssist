/**
 * Integration tests for GET /api/health?deep=true (BIZZ-538).
 *
 * Verifies the post-DAWA probe topology:
 *   - Separate probes for each Datafordeler sub-service (BBR, DAR, MAT, VUR)
 *   - DAWA probe retained but marked `deprecated: true`
 *   - A `down` result on a deprecated probe does NOT mark overall health
 *     as `degraded` — Erhvervsstyrelsen is shutting DAWA down 2026-07-01
 *     and we must not cry wolf once it goes dark
 *   - A `down` result on a non-deprecated probe (e.g. BBR) DOES mark
 *     overall health as `degraded`
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ── Supabase server client mock — the health route only does a trivial ping ──
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
    }),
  }),
}));

// ── Rate-limit + cert-expiry helpers — not relevant to the probe semantics.
// checkRateLimit must return a falsy value to let the request through; any
// truthy return is treated by the route as a 429 NextResponse and short-
// circuits with that object (which would not have a .json method in tests).
vi.mock('@/app/lib/rateLimit', () => ({
  checkRateLimit: () => Promise.resolve(null),
  rateLimit: {},
}));

vi.mock('@/app/lib/certExpiry', () => ({
  checkAllCertificates: () => [],
}));

interface ProbeResponse {
  status: 'ok' | 'slow' | 'down';
  latency_ms: number;
  deprecated?: boolean;
}

interface DeepHealthBody {
  status: 'ok' | 'degraded' | 'down';
  checks: {
    external_apis?: Record<string, ProbeResponse>;
  };
}

/**
 * Build a typed `Response`-shaped mock. We don't need the full Fetch API
 * surface — the health route only reads `.ok` and `.status`.
 */
function mockResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
  } as unknown as Response;
}

describe('GET /api/health?deep=true — BIZZ-538 probe topology', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Required env vars so route does not short-circuit
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://placeholder.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder-key';
    // Unconfigure Redis so it returns 'unconfigured' instead of hitting the network
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.resetModules();
  });

  it('splits Datafordeler into per-service probes (BBR + DAR + MAT + VUR)', async () => {
    global.fetch = vi.fn(() => Promise.resolve(mockResponse(200))) as typeof fetch;

    const { GET } = await import('@/app/api/health/route');
    const res = await GET(new NextRequest('http://test/api/health?deep=true'));
    const body = (await res.json()) as DeepHealthBody;

    const apis = body.checks.external_apis ?? {};
    expect(Object.keys(apis)).toEqual(
      expect.arrayContaining(['bbr', 'dar', 'mat', 'vur', 'cvr_es', 'dawa', 'vurderingsportalen'])
    );
    // Old generic 'datafordeler' key must be gone — it hid per-service outages
    expect(apis).not.toHaveProperty('datafordeler');
  });

  it('marks DAWA probe as deprecated in the response', async () => {
    global.fetch = vi.fn(() => Promise.resolve(mockResponse(200))) as typeof fetch;

    const { GET } = await import('@/app/api/health/route');
    const res = await GET(new NextRequest('http://test/api/health?deep=true'));
    const body = (await res.json()) as DeepHealthBody;

    expect(body.checks.external_apis?.dawa?.deprecated).toBe(true);
    // Other probes are not deprecated — flag must be absent, not false
    expect(body.checks.external_apis?.bbr).not.toHaveProperty('deprecated');
    expect(body.checks.external_apis?.dar).not.toHaveProperty('deprecated');
  });

  it('does NOT mark status degraded when only the deprecated DAWA probe is down', async () => {
    // Every probe succeeds EXCEPT dawa
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('api.dataforsyningen.dk')) {
        return Promise.resolve(mockResponse(503));
      }
      return Promise.resolve(mockResponse(200));
    }) as typeof fetch;

    const { GET } = await import('@/app/api/health/route');
    const res = await GET(new NextRequest('http://test/api/health?deep=true'));
    const body = (await res.json()) as DeepHealthBody;

    expect(body.checks.external_apis?.dawa?.status).toBe('down');
    expect(body.status).toBe('ok');
    // Deep checks return 200 only when status is 'ok'
    expect(res.status).toBe(200);
  });

  it('DOES mark status degraded when a non-deprecated probe (BBR) is down', async () => {
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('graphql.datafordeler.dk/BBR')) {
        return Promise.resolve(mockResponse(502));
      }
      return Promise.resolve(mockResponse(200));
    }) as typeof fetch;

    const { GET } = await import('@/app/api/health/route');
    const res = await GET(new NextRequest('http://test/api/health?deep=true'));
    const body = (await res.json()) as DeepHealthBody;

    expect(body.checks.external_apis?.bbr?.status).toBe('down');
    expect(body.status).toBe('degraded');
    // 503 so load balancers / uptime monitors know to fail over
    expect(res.status).toBe(503);
  });

  it('treats 401/403 from Datafordeler GraphQL as reachable (auth-guarded endpoints)', async () => {
    // Datafordeler GraphQL requires credentials — anonymous probes return 401.
    // That is expected; the service is up, we just did not authenticate.
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('graphql.datafordeler.dk')) {
        return Promise.resolve(mockResponse(401));
      }
      return Promise.resolve(mockResponse(200));
    }) as typeof fetch;

    const { GET } = await import('@/app/api/health/route');
    const res = await GET(new NextRequest('http://test/api/health?deep=true'));
    const body = (await res.json()) as DeepHealthBody;

    for (const name of ['bbr', 'dar', 'mat', 'vur']) {
      expect(body.checks.external_apis?.[name]?.status).toBe('ok');
    }
    expect(body.status).toBe('ok');
  });
});
