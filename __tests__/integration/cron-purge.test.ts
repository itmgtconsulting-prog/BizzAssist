/**
 * Integration tests for GET /api/cron/purge-old-data (BIZZ-149).
 *
 * Verifies:
 * - GET without Authorization header → 401
 * - GET with wrong secret → 401
 * - GET with correct CRON_SECRET → 200 with summary
 * - GET when tenants fetch fails → 500
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Supabase admin mock ───────────────────────────────────────────────────────

/** Controls what tenants are returned per test */
let mockTenantsData: Array<{ id: string; schema_name: string; closed_at: string | null }> = [
  { id: 'tenant-1', schema_name: 'tenant_test', closed_at: null },
];
let mockTenantsError: unknown = null;

/** Schema-switched client delete chain */
const mockDeleteChain = {
  lt: vi.fn().mockResolvedValue({ count: 0, error: null }),
  eq: vi.fn(),
  not: vi.fn().mockResolvedValue({ count: 0, error: null }),
};
mockDeleteChain.eq.mockReturnValue({
  lt: vi.fn().mockResolvedValue({ count: 0, error: null }),
});

const mockSchemaFrom = vi.fn(() => ({
  delete: vi.fn(() => mockDeleteChain),
  insert: vi.fn().mockResolvedValue({ error: null }),
  from: vi.fn(),
}));

const mockSchemaClient = {
  from: mockSchemaFrom,
};

/** Public schema query chains */
const mockPublicSelect = vi.fn().mockImplementation(async () => ({
  data: mockTenantsData,
  error: mockTenantsError,
}));

const mockFrom = vi.fn((table: string) => {
  if (table === 'tenants') {
    return { select: mockPublicSelect };
  }
  return { insert: vi.fn().mockResolvedValue({ error: null }) };
});

const mockSchema = vi.fn(() => mockSchemaClient);

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    from: mockFrom,
    schema: mockSchema,
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Creates a NextRequest for the purge-old-data cron endpoint.
 *
 * @param authHeader - Value for the Authorization header (or undefined to omit)
 */
function makePurgeRequest(authHeader?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) {
    headers['authorization'] = authHeader;
  }
  return new NextRequest('http://localhost:3000/api/cron/purge-old-data', {
    method: 'GET',
    headers,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/cron/purge-old-data', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: env has a known cron secret, not running on Vercel production
    process.env.CRON_SECRET = 'supersecret-cron-token';
    delete process.env.VERCEL_ENV;

    // Reset tenant data
    mockTenantsData = [{ id: 'tenant-1', schema_name: 'tenant_test', closed_at: null }];
    mockTenantsError = null;

    // Restore mocks
    mockDeleteChain.lt.mockResolvedValue({ count: 0, error: null });
    mockDeleteChain.not.mockResolvedValue({ count: 0, error: null });
    mockDeleteChain.eq.mockReturnValue({
      lt: vi.fn().mockResolvedValue({ count: 0, error: null }),
    });

    mockSchemaFrom.mockImplementation(() => ({
      delete: vi.fn(() => mockDeleteChain),
      insert: vi.fn().mockResolvedValue({ error: null }),
      from: vi.fn(),
    }));

    mockPublicSelect.mockImplementation(async () => ({
      data: mockTenantsData,
      error: mockTenantsError,
    }));

    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants') {
        return { select: mockPublicSelect };
      }
      return { insert: vi.fn().mockResolvedValue({ error: null }) };
    });

    mockSchema.mockReturnValue(mockSchemaClient);
  });

  /** No Authorization header must yield 401 */
  it('returns 401 when Authorization header is missing', async () => {
    const { GET } = await import('@/app/api/cron/purge-old-data/route');
    const res = await GET(makePurgeRequest());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  /** Wrong bearer token must yield 401 */
  it('returns 401 when Authorization header has wrong secret', async () => {
    const { GET } = await import('@/app/api/cron/purge-old-data/route');
    const res = await GET(makePurgeRequest('Bearer wrong-token'));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  /** Correct bearer token must yield 200 with purge summary */
  it('returns 200 with purge summary when correct CRON_SECRET is supplied', async () => {
    const { GET } = await import('@/app/api/cron/purge-old-data/route');
    const res = await GET(makePurgeRequest('Bearer supersecret-cron-token'));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; tenants: unknown[]; totalErrors: number };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.tenants)).toBe(true);
    expect(typeof body.totalErrors).toBe('number');
  });

  /** Purge result includes one entry per tenant */
  it('response contains one result per tenant', async () => {
    mockTenantsData = [
      { id: 'tenant-1', schema_name: 'schema_a', closed_at: null },
      { id: 'tenant-2', schema_name: 'schema_b', closed_at: null },
    ];

    const { GET } = await import('@/app/api/cron/purge-old-data/route');
    const res = await GET(makePurgeRequest('Bearer supersecret-cron-token'));

    const body = (await res.json()) as { ok: boolean; tenants: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.tenants).toHaveLength(2);
  });

  /** When CRON_SECRET env var is absent, all requests should be denied */
  it('returns 401 when CRON_SECRET env var is not set', async () => {
    delete process.env.CRON_SECRET;

    const { GET } = await import('@/app/api/cron/purge-old-data/route');
    const res = await GET(makePurgeRequest('Bearer any-token'));
    expect(res.status).toBe(401);
  });

  /** When tenants query fails, the route returns 500 */
  it('returns 500 when tenant fetch from Supabase fails', async () => {
    mockTenantsError = { message: 'DB connection lost' };
    mockTenantsData = [];

    const { GET } = await import('@/app/api/cron/purge-old-data/route');
    const res = await GET(makePurgeRequest('Bearer supersecret-cron-token'));
    expect(res.status).toBe(500);
  });
});
