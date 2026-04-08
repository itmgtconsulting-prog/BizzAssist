/**
 * Integration tests for POST /api/auth/logout (BIZZ-149).
 *
 * Verifies:
 * - POST without a valid session → 401
 * - POST with a valid session → signs out and returns { success: true }
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Supabase server client mock ───────────────────────────────────────────────

/** Mutable state controlled per test */
let mockGetUserResult: { data: { user: { id: string; email: string } | null }; error: null } = {
  data: { user: null },
  error: null,
};

const mockSignOut = vi.fn().mockResolvedValue({ error: null });

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => mockGetUserResult),
      signOut: mockSignOut,
    },
  })),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/auth/logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignOut.mockResolvedValue({ error: null });
  });

  /** When getUser returns null, the route must reject with 401 */
  it('returns 401 when no user session exists', async () => {
    mockGetUserResult = { data: { user: null }, error: null };

    const { POST } = await import('@/app/api/auth/logout/route');
    const res = await POST();

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Not authenticated');
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  /** When a valid session exists, signOut is called and { success: true } is returned */
  it('signs out the user and returns 200 { success: true }', async () => {
    mockGetUserResult = {
      data: { user: { id: 'user-abc', email: 'user@example.com' } },
      error: null,
    };

    const { POST } = await import('@/app/api/auth/logout/route');
    const res = await POST();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(mockSignOut).toHaveBeenCalledOnce();
  });
});
