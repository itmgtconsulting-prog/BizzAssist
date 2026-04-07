/**
 * Integration tests for /api/recents (BIZZ-149).
 *
 * Verifies:
 * - GET without auth → 401
 * - GET with auth → returns recents array
 * - POST without auth → 401
 * - POST with valid body → 200 { ok: true }
 * - POST missing required fields → 400
 * - DELETE without auth → 401
 * - DELETE with valid type param → 200 { ok: true }
 * - DELETE without type param → 400
 *
 * Note: route uses public.recent_entities (migration 027) — no tenant schema lookup.
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
 * The recents route calls admin.from('recent_entities').select / upsert / delete.
 * Chainable stub: supports .select().eq().eq().eq().order().limit()
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

/** Chainable select chain — supports up to 3 .eq() calls + .order().limit() */
const mockSelectChain = {
  eq: vi.fn(),
  order: vi.fn(),
  limit: vi.fn(),
};
mockSelectChain.eq.mockReturnValue(mockSelectChain);
mockSelectChain.order.mockReturnValue(mockSelectChain);
mockSelectChain.limit.mockResolvedValue({ data: mockRecentsData, error: null });

/** Prune select chain (3 .eq() + .order() → resolves) */
const mockPruneChain = {
  eq: vi.fn(),
  order: vi.fn(),
};
mockPruneChain.eq.mockReturnValue(mockPruneChain);
mockPruneChain.order.mockResolvedValue({ data: [], error: null });

/** Delete chain */
const mockDeleteChain = {
  eq: vi.fn(),
  in: vi.fn().mockResolvedValue({ error: null }),
};
mockDeleteChain.eq.mockReturnValue(mockDeleteChain);

const mockUpsertChain = vi.fn().mockResolvedValue({ error: null });

/**
 * Route only calls admin.from('recent_entities') — no tenant lookup in new impl.
 * First .select() call is for GET/prune, .upsert() for POST, .delete() for DELETE.
 */
let selectCallCount = 0;
const mockFrom = vi.fn((_table: string) => ({
  select: vi.fn(() => {
    selectCallCount += 1;
    // First call = GET (returns data), second call = prune (returns empty)
    if (selectCallCount === 1) return mockSelectChain;
    return mockPruneChain;
  }),
  upsert: mockUpsertChain,
  delete: vi.fn().mockReturnValue(mockDeleteChain),
}));

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
    selectCallCount = 0;

    mockSelectChain.eq.mockReturnValue(mockSelectChain);
    mockSelectChain.order.mockReturnValue(mockSelectChain);
    mockSelectChain.limit.mockResolvedValue({ data: mockRecentsData, error: null });

    mockFrom.mockImplementation((_table: string) => ({
      select: vi.fn().mockReturnValue(mockSelectChain),
      upsert: mockUpsertChain,
      delete: vi.fn().mockReturnValue(mockDeleteChain),
    }));
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

  /** DB error → returns empty array, not a 500 */
  it('returns empty recents on DB error', async () => {
    mockAuthResult = { tenantId: 'tenant-1', userId: 'user-1' };
    mockSelectChain.limit.mockResolvedValue({ data: null, error: { message: 'DB error' } });

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
    selectCallCount = 0;

    mockUpsertChain.mockResolvedValue({ error: null });
    mockDeleteChain.eq.mockReturnValue(mockDeleteChain);
    mockDeleteChain.in.mockResolvedValue({ error: null });

    // POST uses: upsert() + select().eq().eq().eq().order() for prune
    const mockPruneLocal = {
      eq: vi.fn(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    mockPruneLocal.eq.mockReturnValue(mockPruneLocal);

    mockFrom.mockImplementation((_table: string) => ({
      select: vi.fn().mockReturnValue(mockPruneLocal),
      upsert: mockUpsertChain,
      delete: vi.fn().mockReturnValue(mockDeleteChain),
    }));
  });

  /** Unauthenticated POST must be rejected */
  it('returns 401 when not authenticated', async () => {
    mockAuthResult = null;
    const { POST } = await import('@/app/api/recents/route');
    const req = makeRequest(
      'POST',
      {},
      { entity_type: 'property', entity_id: '123', display_name: 'Testvej 1' }
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
      { entity_type: 'property', entity_id: 'bfe-456', display_name: 'Nørrebrogade 1' }
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
    selectCallCount = 0;

    mockDeleteChain.eq.mockReturnValue(mockDeleteChain);
    mockDeleteChain.in.mockResolvedValue({ error: null });

    mockFrom.mockImplementation((_table: string) => ({
      delete: vi.fn().mockReturnValue(mockDeleteChain),
    }));
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
