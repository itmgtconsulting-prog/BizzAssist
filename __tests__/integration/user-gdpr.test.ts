/**
 * Integration tests for GDPR user data routes (BIZZ-149).
 *
 * Covers:
 *   GET  /api/user/export-data
 *     - Without auth → 401
 *     - With auth → 200 + JSON attachment header
 *
 *   DELETE /api/user/delete-account
 *     - Without auth → 401
 *     - Without confirm body → 400
 *     - With wrong confirm text → 400
 *     - With correct confirm "SLET MIN KONTO" → 200
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Auth (resolveTenantId) mock ───────────────────────────────────────────────

/** Controlled per test — null = unauthenticated */
let mockAuthResult: { tenantId: string; userId: string } | null = null;

vi.mock('@/lib/api/auth', () => ({
  resolveTenantId: vi.fn(async () => mockAuthResult),
}));

// ── Supabase server client mock ───────────────────────────────────────────────

let mockServerUser: {
  id: string;
  email: string;
  user_metadata: Record<string, unknown>;
  created_at: string;
} | null = null;

const mockServerSignOut = vi.fn().mockResolvedValue({ error: null });
const _mockServerDeleteUser = vi.fn().mockResolvedValue({ error: null });

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: mockServerUser }, error: null })),
      signOut: mockServerSignOut,
    },
  })),
}));

// ── Supabase admin mock ───────────────────────────────────────────────────────

const mockAdminDeleteUser = vi.fn().mockResolvedValue({ error: null });

/** Schema-switched client stub */
const mockSchemaChain = {
  from: vi.fn(() => ({
    delete: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    }),
    insert: vi.fn().mockResolvedValue({ error: null }),
  })),
};

/** public.tenants / tenant_memberships query chains */
const mockSingle = vi
  .fn()
  .mockResolvedValue({ data: { schema_name: 'tenant_test', tenant_id: 'tenant-1' }, error: null });
const mockEq = vi
  .fn()
  .mockReturnValue({ single: mockSingle, limit: vi.fn().mockReturnValue({ single: mockSingle }) });
const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
const mockInsert = vi.fn().mockResolvedValue({ error: null });

/** Admin client export-data query: select * on tenant tables */
const _mockTenantTableSelect = vi.fn().mockResolvedValue({ data: [], error: null });
const mockTenantEq = vi
  .fn()
  .mockReturnValue({ order: vi.fn().mockResolvedValue({ data: [], error: null }) });
const mockConvoEq = vi
  .fn()
  .mockReturnValue({ order: vi.fn().mockResolvedValue({ data: [], error: null }) });

const mockFrom = vi.fn((table: string) => {
  if (table === 'tenants' || table === 'tenant_memberships') {
    return { select: mockSelect, from: mockSchemaChain.from, insert: mockInsert };
  }
  if (table === 'audit_log') {
    return { insert: mockInsert };
  }
  // Tenant-schema tables
  return {
    select: vi.fn().mockReturnValue({ eq: mockTenantEq }),
    delete: vi.fn().mockReturnValue({ eq: mockEq }),
  };
});

const mockSchema = vi.fn(() => mockSchemaChain);

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    auth: {
      admin: {
        deleteUser: mockAdminDeleteUser,
        getUserById: vi.fn().mockResolvedValue({
          data: { user: { email: 'user@example.com', app_metadata: {} } },
          error: null,
        }),
      },
    },
    from: mockFrom,
    schema: mockSchema,
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Creates a DELETE NextRequest for /api/user/delete-account with optional body.
 *
 * @param body - Request body. Pass undefined to omit body entirely.
 */
function makeDeleteRequest(body?: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/user/delete-account', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ── export-data tests ─────────────────────────────────────────────────────────

describe('GET /api/user/export-data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSingle.mockResolvedValue({
      data: { schema_name: 'tenant_test', tenant_id: 'tenant-1' },
      error: null,
    });
    mockEq.mockReturnValue({
      single: mockSingle,
      limit: vi.fn().mockReturnValue({ single: mockSingle }),
    });
    mockSelect.mockReturnValue({ eq: mockEq });
    mockTenantEq.mockReturnValue({ order: vi.fn().mockResolvedValue({ data: [], error: null }) });
    mockConvoEq.mockReturnValue({ order: vi.fn().mockResolvedValue({ data: [], error: null }) });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants' || table === 'tenant_memberships') {
        return { select: mockSelect };
      }
      return {
        select: vi.fn().mockReturnValue({ eq: mockTenantEq }),
      };
    });
  });

  /** Unauthenticated requests are rejected with 401 */
  it('returns 401 when not authenticated', async () => {
    mockAuthResult = null;

    const { GET } = await import('@/app/api/user/export-data/route');
    const res = await GET();

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  /**
   * Authenticated user receives a JSON attachment.
   * Content-Disposition must include the expected filename pattern.
   */
  it('returns 200 with JSON attachment for authenticated user', async () => {
    mockAuthResult = { tenantId: 'tenant-1', userId: 'user-abc' };
    mockServerUser = {
      id: 'user-abc',
      email: 'user@example.com',
      user_metadata: { full_name: 'Test User' },
      created_at: '2025-01-01T00:00:00Z',
    };

    const { GET } = await import('@/app/api/user/export-data/route');
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');

    const disposition = res.headers.get('Content-Disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('mine-data-');
    expect(disposition).toContain('.json');
  });

  /** Exported payload contains the expected top-level GDPR fields */
  it('returned JSON payload contains gdprArticle and profile fields', async () => {
    mockAuthResult = { tenantId: 'tenant-1', userId: 'user-abc' };
    mockServerUser = {
      id: 'user-abc',
      email: 'export@example.com',
      user_metadata: {},
      created_at: '2025-01-01T00:00:00Z',
    };

    const { GET } = await import('@/app/api/user/export-data/route');
    const res = await GET();
    const text = await res.text();
    const payload = JSON.parse(text) as {
      gdprArticle: string;
      profile: { id: string; email: string };
      recentEntities: unknown[];
    };

    expect(payload.gdprArticle).toBe('20');
    expect(payload.profile.id).toBe('user-abc');
    expect(payload.profile.email).toBe('export@example.com');
    expect(Array.isArray(payload.recentEntities)).toBe(true);
  });
});

// ── delete-account tests ──────────────────────────────────────────────────────

describe('DELETE /api/user/delete-account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdminDeleteUser.mockResolvedValue({ error: null });
    mockInsert.mockResolvedValue({ error: null });
    mockSingle.mockResolvedValue({
      data: { schema_name: 'tenant_test', tenant_id: 'tenant-1' },
      error: null,
    });
    mockEq.mockReturnValue({
      single: mockSingle,
      limit: vi.fn().mockReturnValue({ single: mockSingle }),
    });
    mockSelect.mockReturnValue({ eq: mockEq });
    mockSchema.mockReturnValue(mockSchemaChain);
    mockSchemaChain.from.mockReturnValue({
      delete: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
      insert: vi.fn().mockResolvedValue({ error: null }),
    });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'tenants' || table === 'tenant_memberships') {
        return { select: mockSelect };
      }
      if (table === 'audit_log') {
        return { insert: mockInsert };
      }
      return {
        delete: vi.fn().mockReturnValue({ eq: mockEq }),
      };
    });
  });

  /** No user session → 401 */
  it('returns 401 when not authenticated', async () => {
    mockServerUser = null;

    const { DELETE } = await import('@/app/api/user/delete-account/route');
    const res = await DELETE(makeDeleteRequest({ confirm: 'SLET MIN KONTO' }));

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Ikke logget ind');
  });

  /** No body → 400 (JSON parse fails) */
  it('returns 400 when request body is missing/invalid', async () => {
    mockServerUser = {
      id: 'user-abc',
      email: 'u@e.com',
      user_metadata: {},
      created_at: '2025-01-01T00:00:00Z',
    };

    const { DELETE } = await import('@/app/api/user/delete-account/route');
    // Send request with no body — will fail JSON parse inside the route
    const req = new NextRequest('http://localhost:3000/api/user/delete-account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      // no body
    });
    const res = await DELETE(req);

    expect(res.status).toBe(400);
  });

  /** Wrong confirm text → 400 */
  it('returns 400 when confirm phrase is wrong', async () => {
    mockServerUser = {
      id: 'user-abc',
      email: 'u@e.com',
      user_metadata: {},
      created_at: '2025-01-01T00:00:00Z',
    };

    const { DELETE } = await import('@/app/api/user/delete-account/route');
    const res = await DELETE(makeDeleteRequest({ confirm: 'delete my account' }));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('SLET MIN KONTO');
  });

  /** Correct confirm phrase → 200, Supabase user deleted */
  it('returns 200 and deletes user when confirm phrase is correct', async () => {
    mockServerUser = {
      id: 'user-del',
      email: 'del@example.com',
      user_metadata: {},
      created_at: '2025-01-01T00:00:00Z',
    };

    const { DELETE } = await import('@/app/api/user/delete-account/route');
    const res = await DELETE(makeDeleteRequest({ confirm: 'SLET MIN KONTO' }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mockAdminDeleteUser).toHaveBeenCalledWith('user-del');
  });
});
