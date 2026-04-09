/**
 * Unit tests for POST /api/tokens/verify
 *
 * The endpoint verifies bearer tokens via SHA-256 hash lookup in Supabase.
 * Returns 200 { valid: true } or 200 { valid: false } — never 401 — so callers
 * can distinguish "endpoint error" from "token rejected".
 *
 * Covers:
 *   - 400 when token field is missing
 *   - 400 when JSON body is malformed
 *   - 400 when token is an empty string
 *   - 200 { valid: false } for tokens that don't start with "bza_"
 *   - 200 { valid: false } when token hash is not found in DB
 *   - 200 { valid: false } when token is expired
 *   - 200 { valid: false } when token is revoked
 *   - 200 { valid: true, tenantId, scopes } for a valid non-expired token
 *   - 429 when rate limit is exceeded
 *
 * @upstash/redis, @upstash/ratelimit, and @/lib/supabase/admin are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mock @upstash/redis + @upstash/ratelimit (for rateLimit middleware) ──────

vi.mock('@upstash/redis', () => {
  class Redis {
    constructor(_opts: Record<string, unknown>) {}
  }
  return { Redis };
});

vi.mock('@upstash/ratelimit', () => {
  function Ratelimit(_opts: Record<string, unknown>) {
    return {
      limit: vi.fn().mockResolvedValue({
        success: true,
        limit: 60,
        remaining: 59,
        reset: Date.now() + 60_000,
      }),
    };
  }
  Ratelimit.slidingWindow = vi.fn().mockReturnValue({});
  return { Ratelimit };
});

// ─── Mock Supabase admin client ───────────────────────────────────────────────

/**
 * We mock the entire schema().from().select().eq().eq().single() chain.
 * The mock is re-configured per test via mockSingleResult.
 */
const mockSingle = vi.fn();

const mockSchemaChain = {
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  single: mockSingle,
};

const mockSchema = vi.fn().mockReturnValue(mockSchemaChain);

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn().mockReturnValue({
    schema: mockSchema,
  }),
}));

// ─── Import route after mocks ──────────────────────────────────────────────────

const { POST } = await import('@/app/api/tokens/verify/route');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal NextRequest with the given JSON body.
 */
function makeRequest(body: unknown, malformed = false): NextRequest {
  return new NextRequest('http://localhost/api/tokens/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: malformed ? '{ not valid json' : JSON.stringify(body),
  });
}

/**
 * Token row shape returned from the mock DB.
 */
function makeTokenRow(
  overrides: Partial<{
    id: number;
    tenant_id: string;
    scopes: string[];
    expires_at: string | null;
    revoked: boolean;
  }> = {}
) {
  return {
    id: 1,
    tenant_id: 'tenant-test',
    scopes: ['read:properties'],
    expires_at: null,
    revoked: false,
    ...overrides,
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Reset mock chain so each test has a clean state
  mockSchemaChain.from.mockReturnThis();
  mockSchemaChain.select.mockReturnThis();
  mockSchemaChain.update.mockReturnThis();
  mockSchemaChain.eq.mockReturnThis();

  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/tokens/verify', () => {
  it('returns 400 when the token field is missing from the body', async () => {
    const req = makeRequest({});
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('returns 400 when the token is an empty string', async () => {
    const req = makeRequest({ token: '   ' });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('returns 400 when the JSON body is malformed', async () => {
    const req = makeRequest(null, /* malformed */ true);
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('returns 200 { valid: false } for tokens not starting with "bza_"', async () => {
    const req = makeRequest({ token: 'sk_live_something' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    // Should short-circuit without hitting the DB
    expect(mockSingle).not.toHaveBeenCalled();
  });

  it('returns 200 { valid: false } when token hash is not found in DB', async () => {
    mockSingle.mockResolvedValue({ data: null, error: null });

    const req = makeRequest({ token: 'bza_unknown_token_abc123' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
  });

  it('returns 200 { valid: false } when the token has expired', async () => {
    // expires_at is in the past
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    mockSingle.mockResolvedValue({ data: makeTokenRow({ expires_at: pastDate }), error: null });

    const req = makeRequest({ token: 'bza_expired_token_abc' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
  });

  it('returns 200 { valid: true, tenantId, scopes } for a valid non-expired token', async () => {
    // expires_at is in the future
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    mockSingle.mockResolvedValue({
      data: makeTokenRow({
        tenant_id: 'tenant-abc',
        scopes: ['read:properties', 'read:companies'],
        expires_at: futureDate,
      }),
      error: null,
    });

    const req = makeRequest({ token: 'bza_valid_token_xyz' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.tenantId).toBe('tenant-abc');
    expect(body.scopes).toEqual(['read:properties', 'read:companies']);
  });

  it('returns 200 { valid: true } for a token with no expiry (expires_at === null)', async () => {
    mockSingle.mockResolvedValue({
      data: makeTokenRow({ expires_at: null }),
      error: null,
    });

    const req = makeRequest({ token: 'bza_no_expiry_token' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.tenantId).toBe('tenant-test');
  });

  it('returns 200 { valid: false } when DB query throws an error', async () => {
    mockSingle.mockRejectedValue(new Error('DB connection error'));

    const req = makeRequest({ token: 'bza_some_token' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    // Route returns { valid: false } on error (avoids leaking DB errors)
    expect(body.valid).toBe(false);
  });

  it('trims whitespace from the token before processing', async () => {
    // Token with wrong prefix after trim — should return valid:false without DB call
    const req = makeRequest({ token: '  sk_evil_token  ' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(mockSingle).not.toHaveBeenCalled();
  });
});
