/**
 * Unit tests for BIZZ-189 — tokensUsed server-side validation in
 * /api/subscription/track-tokens.
 *
 * Verifies that the route returns HTTP 400 for every invalid tokensUsed value
 * and only proceeds to Supabase when the value is a positive integer ≤ 10 000.
 *
 * Supabase auth and admin client are mocked so the test runs in isolation
 * without a live database connection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mock Supabase clients ────────────────────────────────────────────────────
// vi.mock is hoisted, so factory functions must not reference variables that
// are declared later in the file.  Use vi.fn() inline and capture the mocks
// via vi.mocked() after import.

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
    },
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn().mockReturnValue({
    auth: {
      admin: {
        getUserById: vi.fn().mockResolvedValue({
          data: {
            user: {
              app_metadata: { subscription: { tokensUsedThisMonth: 0 } },
            },
          },
          error: null,
        }),
        updateUserById: vi.fn().mockResolvedValue({ error: null }),
      },
    },
  }),
}));

// ─── Import route after mocks ─────────────────────────────────────────────────

import { POST } from '@/app/api/subscription/track-tokens/route';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/subscription/track-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Reset the mock implementations to their defaults before each test. */
function resetMocks() {
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
    },
  } as unknown as Awaited<ReturnType<typeof createClient>>);

  vi.mocked(createAdminClient).mockReturnValue({
    auth: {
      admin: {
        getUserById: vi.fn().mockResolvedValue({
          data: {
            user: { app_metadata: { subscription: { tokensUsedThisMonth: 0 } } },
          },
          error: null,
        }),
        updateUserById: vi.fn().mockResolvedValue({ error: null }),
      },
    },
  } as unknown as ReturnType<typeof createAdminClient>);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/subscription/track-tokens — BIZZ-189 validation', () => {
  beforeEach(resetMocks);

  it('returns 400 for a negative tokensUsed', async () => {
    const res = await POST(makeRequest({ tokensUsed: -5 }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toHaveProperty('error');
  });

  it('returns 400 for tokensUsed = 0', async () => {
    const res = await POST(makeRequest({ tokensUsed: 0 }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for tokensUsed > 10000', async () => {
    const res = await POST(makeRequest({ tokensUsed: 10_001 }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for a floating-point tokensUsed', async () => {
    const res = await POST(makeRequest({ tokensUsed: 3.14 }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when tokensUsed is a string', async () => {
    const res = await POST(makeRequest({ tokensUsed: '500' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when tokensUsed is null', async () => {
    const res = await POST(makeRequest({ tokensUsed: null }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when tokensUsed is missing', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it('accepts tokensUsed = 1 (minimum valid)', async () => {
    const res = await POST(makeRequest({ tokensUsed: 1 }));
    expect(res.status).toBe(200);
  });

  it('accepts tokensUsed = 10000 (maximum valid)', async () => {
    const res = await POST(makeRequest({ tokensUsed: 10_000 }));
    expect(res.status).toBe(200);
  });
});
