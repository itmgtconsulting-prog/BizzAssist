/**
 * API auth guard regression tests — regnskab routes.
 *
 * These tests verify that every API route that handles tenant-scoped financial data
 * returns HTTP 401 when called without a valid session. They guard against the
 * accidental removal of resolveTenantId() guards during refactoring.
 *
 * Covered routes:
 *   GET /api/regnskab          — PDF/XBRL regnskab list (CVR ES proxy)
 *   GET /api/regnskab/xbrl     — XBRL parser + Supabase cache
 *
 * Pattern: mock resolveTenantId() → null (unauthenticated), import route handler,
 * send a plausible request, assert 401 with { error: 'Unauthorized' }.
 *
 * If a test in this file fails after a refactoring session, it means an auth guard
 * has been removed. Restore the guard before merging.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Auth mock — returns null to simulate unauthenticated request ──────────────
vi.mock('@/lib/api/auth', () => ({
  resolveTenantId: vi.fn().mockResolvedValue(null),
  resolveUserId: vi.fn().mockResolvedValue(null),
}));

// ── Supabase admin mock — prevents real DB connections ───────────────────────
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
      insert: vi.fn().mockResolvedValue({ error: null }),
      update: vi.fn().mockResolvedValue({ error: null }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  })),
}));

// ── Logger mock — suppress log output in tests ───────────────────────────────
vi.mock('@/app/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Env + fetch mock ──────────────────────────────────────────────────────────

let mockFetch: ReturnType<typeof vi.fn>;
const originalEnv = { ...process.env };

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
  // Provide dummy CVR credentials so the route doesn't short-circuit before auth check
  process.env.CVR_ES_USER = 'test-user';
  process.env.CVR_ES_PASS = 'test-pass';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  process.env = { ...originalEnv };
});

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Builds a NextRequest with the given URL string.
 *
 * @param url - Full URL including query string
 * @returns NextRequest instance
 */
function makeRequest(url: string): NextRequest {
  return new NextRequest(url);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/regnskab — auth guard', () => {
  it('returns 401 when no session exists', async () => {
    vi.resetModules();
    const { GET } = await import('@/app/api/regnskab/route');

    const res = await GET(makeRequest('http://localhost/api/regnskab?cvr=44718502'));

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('does NOT call the external CVR ES when unauthenticated', async () => {
    vi.resetModules();
    const { GET } = await import('@/app/api/regnskab/route');

    await GET(makeRequest('http://localhost/api/regnskab?cvr=44718502'));

    // fetch should never be called — guard must return before any external I/O
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 401 even when CVR is missing from query string', async () => {
    vi.resetModules();
    const { GET } = await import('@/app/api/regnskab/route');

    const res = await GET(makeRequest('http://localhost/api/regnskab'));

    expect(res.status).toBe(401);
  });
});

describe('GET /api/regnskab/xbrl — auth guard', () => {
  it('returns 401 when no session exists', async () => {
    vi.resetModules();
    const { GET } = await import('@/app/api/regnskab/xbrl/route');

    const res = await GET(makeRequest('http://localhost/api/regnskab/xbrl?cvr=44718502'));

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('does NOT call external XBRL APIs when unauthenticated', async () => {
    vi.resetModules();
    const { GET } = await import('@/app/api/regnskab/xbrl/route');

    await GET(makeRequest('http://localhost/api/regnskab/xbrl?cvr=44718502&offset=0&limit=4'));

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 401 even when XBRL params are missing', async () => {
    vi.resetModules();
    const { GET } = await import('@/app/api/regnskab/xbrl/route');

    const res = await GET(makeRequest('http://localhost/api/regnskab/xbrl'));

    expect(res.status).toBe(401);
  });
});

// ── Authenticated path smoke tests ────────────────────────────────────────────
//
// When auth is present (resolveTenantId returns a valid context), the route must
// proceed past the guard. These tests re-mock auth to return a valid context
// and verify the route attempts to call the external API (not short-circuit).

describe('GET /api/regnskab — authenticated path proceeds past guard', () => {
  it('calls external CVR ES when auth context is valid', async () => {
    // Override auth mock for this specific test
    vi.resetModules();
    vi.doMock('@/lib/api/auth', () => ({
      resolveTenantId: vi.fn().mockResolvedValue({
        tenantId: 'test-tenant',
        userId: 'test-user',
      }),
      resolveUserId: vi.fn().mockResolvedValue('test-user'),
    }));

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ hits: { hits: [] } }),
    });

    const { GET } = await import('@/app/api/regnskab/route');
    const res = await GET(makeRequest('http://localhost/api/regnskab?cvr=44718502'));

    // Authenticated request should NOT return 401
    expect(res.status).not.toBe(401);
    // And should have reached the external ES endpoint
    expect(mockFetch).toHaveBeenCalled();
  });
});

describe('GET /api/regnskab/xbrl — authenticated path proceeds past guard', () => {
  it('calls external XBRL endpoint when auth context is valid', async () => {
    vi.resetModules();
    vi.doMock('@/lib/api/auth', () => ({
      resolveTenantId: vi.fn().mockResolvedValue({
        tenantId: 'test-tenant',
        userId: 'test-user',
      }),
      resolveUserId: vi.fn().mockResolvedValue('test-user'),
    }));
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: vi.fn(() => ({
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              single: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
            lte: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
          insert: vi.fn().mockResolvedValue({ error: null }),
          upsert: vi.fn().mockResolvedValue({ error: null }),
        }),
        rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
    }));

    // Mock regnskab list fetch (the first call the XBRL route makes)
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ hits: { hits: [] } }),
    });

    const { GET } = await import('@/app/api/regnskab/xbrl/route');
    const res = await GET(
      makeRequest('http://localhost/api/regnskab/xbrl?cvr=44718502&offset=0&limit=4')
    );

    // Authenticated request should proceed — either 200 (no regnskaber) or an error
    // but NOT 401 (that would mean the guard blocked an authenticated request)
    expect(res.status).not.toBe(401);
  });
});
