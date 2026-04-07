/**
 * Integration tests for /api/recents (BIZZ-149).
 *
 * Verifies:
 * - GET without auth → 401
 * - GET with auth and valid tenant → returns recents array
 * - GET with auth but no schema found → returns empty recents
 * - POST without auth → 401
 * - POST with valid body → 200 { ok: true }
 * - POST missing required fields → 400
 * - DELETE without auth → 401
 * - DELETE with valid type param → 200 { ok: true }
 * - DELETE without type param → 400
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Auth mock ─────────────────────────────────────────────────────────────────

/** Toggled per test — null = unauthenticated */
let mockAuthResult: { tenantId: string; userId: string } | null = null;

vi.mock('@/lib/api/auth', () => ({
  resolveTenantId: vi.fn(async () => mockAuthResult),
}));

// ── Supabase admin mock ───────────────────────────────────────────────────────

/**
 * The recents route calls admin.from(table).select / upsert / delete.
 * We build a chainable stub that resolves to configurable data.
 */
const mockRecentsData = [
  {
    id: 'r1',
    entity_type: 'property',
    entity_id: '123',
    display_name: 'Testvej 1',
    visited_at: '2026-01-01',
  },
];

const mockDeleteChain = {
  in: vi.fn().mockResolvedValue({ error: null }),
  eq: vi.fn(),
};
mockDeleteChain.eq.mockReturnValue(mockDeleteChain);

const mockSelectChain = {
  eq: vi.fn(),
  order: vi.fn(),
  limit: vi.fn(),
};
mockSelectChain.limit.mockResolvedValue({ data: mockRecentsData, error: null });
mockSelectChain.order.mockReturnValue(mockSelectChain);
mockSelectChain.eq.mockReturnValue(mockSelectChain);

const mockUpsertChain = vi.fn().mockResolvedValue({ error: null });
const mockSelectForPrune = vi.fn().mockResolvedValue({ data: [], error: null });

/** Tenant schema lookup chain */
const mockTenantSelectSingle = vi.fn().mockResolvedValue({
  data: { schema_name: 'tenant_test' },
  error: null,
});
const mockTenantEq = vi.fn().mockReturnValue({ single: mockTenantSelectSingle });
const mockTenantSelect = vi.fn().mockReturnValue({ eq: mockTenantEq });

/** Route calls from() with either 'tenants' or a schema-qualified table */
const mockFrom = vi.fn((table: string) => {
  if (table === 'tenants') {
    return { select: mockTenantSelect };
  }
  // tenant-schema table — return chainable operations
  return {
    select: vi.fn().mockReturnValue(mockSelectChain),
    upsert: mockUpsertChain,
    delete: vi.fn().mockReturnValue(mockDeleteChain),
  };
});

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({ from: mockFrom })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Creates a NextRequest for /api/recents.
 *
 * @param method  - HTTP method
 * @param params  - URL query parameters
 * @param body    - Optional JSON body
 */
function makeRequest(
  method: string,
  params: Record<string, string> = {},
  body?: Record<string, unknown>
): NextRequest {
  const url = new URL('http://localhost:3000/api/recents');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url.toString(), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/recents', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Restore default chain behaviours after clearAllMocks
    mockTenantSelectSingle.mockResolvedValue({ data: { schema_name: 'tenant_test' }, error: null });
    mockTenantEq.mockReturnValue({ single: mockTenantSelectSingle });
    mockTenantSelect.mockReturnValue({ eq: mockTenantEq });

    mockSelectChain.limit.mockResolvedValue({ data: mockRecentsData, error: null });
    mockSelectChain.order.mockReturnValue(mockSelectChain);
    mockSelectChain.eq.mockReturnValue(mockSelectChain);

    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants') {
        return { select: mockTenantSelect };
      }
      return {
        select: vi.fn().mockReturnValue(mockSelectChain),
        upsert: mockUpsertChain,
        delete: vi.fn().mockReturnValue(mockDeleteChain),
      };
    });
  });

  /** Unauthenticated requests must be rejected */
  it('returns 401 when not authenticated', async () => {
    mockAuthResult = null;
    const { GET } = await import('@/app/api/recents/route');
    const req = makeRequest('GET', { type: 'property' });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  /** Authenticated user receives their recents array */
  it('returns recents array for authenticated user', async () => {
    mockAuthResult = { tenantId: 'tenant-1', userId: 'user-1' };

    const { GET } = await import('@/app/api/recents/route');
    const req = makeRequest('GET', { type: 'property' });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { recents: unknown[] };
    expect(Array.isArray(body.recents)).toBe(true);
  });

  /** When tenant schema is not found, return empty array (not an error) */
  it('returns empty recents when tenant schema is not found', async () => {
    mockAuthResult = { tenantId: 'tenant-1', userId: 'user-1' };
    mockTenantSelectSingle.mockResolvedValue({ data: null, error: null });

    const { GET } = await import('@/app/api/recents/route');
    const req = makeRequest('GET', { type: 'property' });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { recents: unknown[] };
    expect(body.recents).toHaveLength(0);
  });
});

describe('POST /api/recents', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockTenantSelectSingle.mockResolvedValue({ data: { schema_name: 'tenant_test' }, error: null });
    mockTenantEq.mockReturnValue({ single: mockTenantSelectSingle });
    mockTenantSelect.mockReturnValue({ eq: mockTenantEq });
    mockUpsertChain.mockResolvedValue({ error: null });
    mockSelectForPrune.mockResolvedValue({ data: [], error: null });

    mockDeleteChain.eq.mockReturnValue(mockDeleteChain);
    mockDeleteChain.in.mockResolvedValue({ error: null });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants') {
        return { select: mockTenantSelect };
      }
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
        upsert: mockUpsertChain,
        delete: vi.fn().mockReturnValue(mockDeleteChain),
      };
    });
  });

  /** Unauthenticated POST must be rejected */
  it('returns 401 when not authenticated', async () => {
    mockAuthResult = null;
    const { POST } = await import('@/app/api/recents/route');
    const req = makeRequest(
      'POST',
      {},
      {
        entity_type: 'property',
        entity_id: '123',
        display_name: 'Testvej 1',
      }
    );
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  /** Valid POST body should be accepted */
  it('returns 200 { ok: true } for valid body', async () => {
    mockAuthResult = { tenantId: 'tenant-1', userId: 'user-1' };

    const { POST } = await import('@/app/api/recents/route');
    const req = makeRequest(
      'POST',
      {},
      {
        entity_type: 'property',
        entity_id: 'bfe-456',
        display_name: 'Nørrebrogade 1',
      }
    );
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  /** POST missing required fields should return 400 */
  it('returns 400 when required fields are missing', async () => {
    mockAuthResult = { tenantId: 'tenant-1', userId: 'user-1' };

    const { POST } = await import('@/app/api/recents/route');
    const req = makeRequest('POST', {}, { entity_type: 'property' }); // missing entity_id + display_name
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/recents', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockTenantSelectSingle.mockResolvedValue({ data: { schema_name: 'tenant_test' }, error: null });
    mockTenantEq.mockReturnValue({ single: mockTenantSelectSingle });
    mockTenantSelect.mockReturnValue({ eq: mockTenantEq });
    mockDeleteChain.eq.mockReturnValue(mockDeleteChain);
    mockDeleteChain.in.mockResolvedValue({ error: null });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants') {
        return { select: mockTenantSelect };
      }
      return {
        delete: vi.fn().mockReturnValue(mockDeleteChain),
      };
    });
  });

  /** Unauthenticated DELETE must be rejected */
  it('returns 401 when not authenticated', async () => {
    mockAuthResult = null;
    const { DELETE } = await import('@/app/api/recents/route');
    const req = makeRequest('DELETE', { type: 'property' });
    const res = await DELETE(req);
    expect(res.status).toBe(401);
  });

  /** DELETE without type param must return 400 */
  it('returns 400 when type param is missing', async () => {
    mockAuthResult = { tenantId: 'tenant-1', userId: 'user-1' };
    const { DELETE } = await import('@/app/api/recents/route');
    const req = makeRequest('DELETE'); // no type param
    const res = await DELETE(req);
    expect(res.status).toBe(400);
  });

  /** Valid DELETE request clears recents and returns 200 */
  it('returns 200 { ok: true } for valid type param', async () => {
    mockAuthResult = { tenantId: 'tenant-1', userId: 'user-1' };
    const { DELETE } = await import('@/app/api/recents/route');
    const req = makeRequest('DELETE', { type: 'property' });
    const res = await DELETE(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
