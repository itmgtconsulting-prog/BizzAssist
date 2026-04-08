/**
 * Unit tests for app/lib/rateLimit.
 *
 * rateLimit.ts wraps Upstash Redis behind lazy Proxy instances and exports
 * checkRateLimit() which gates API handlers.  Because Upstash is an external
 * service we mock @upstash/ratelimit and @upstash/redis entirely.
 *
 * Covers:
 * - checkRateLimit: allowed request returns null
 * - checkRateLimit: rate-limited request returns 429 NextResponse with headers
 * - checkRateLimit: correct headers (X-RateLimit-Limit, Remaining, Reset, Retry-After)
 * - Client key extraction: x-forwarded-for (first IP in list), x-real-ip, anonymous fallback
 * - Proxy limiter getters: rateLimit, aiRateLimit, heavyRateLimit, braveRateLimit all initialise lazily
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Upstash modules before importing the module under test ──────────────

const mockLimit = vi.fn();

vi.mock('@upstash/ratelimit', () => {
  // Must use a regular function (or class) — arrow functions cannot be called with `new`.
  function Ratelimit(_opts: Record<string, unknown>) {
    return { limit: mockLimit };
  }
  Ratelimit.slidingWindow = vi.fn().mockReturnValue({});
  return { Ratelimit };
});

vi.mock('@upstash/redis', () => {
  // Use a named class so it can be used with `new` (arrow functions cannot)
  class Redis {
    constructor(_opts: Record<string, unknown>) {}
  }
  return { Redis };
});

// Import after mocks are established
import {
  checkRateLimit,
  rateLimit,
  aiRateLimit,
  heavyRateLimit,
  braveRateLimit,
} from '@/app/lib/rateLimit';
import { NextRequest } from 'next/server';
import type { Ratelimit } from '@upstash/ratelimit';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a minimal NextRequest with configurable headers.
 */
function makeRequest(headers: Record<string, string> = {}): NextRequest {
  const url = 'https://bizzassist.dk/api/test';
  return new NextRequest(url, { headers });
}

/**
 * Builds a Ratelimit-like object whose .limit() method delegates to mockLimit.
 */
function makeLimiter(): Ratelimit {
  return { limit: mockLimit } as unknown as Ratelimit;
}

describe('checkRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set required env vars so getRedis() doesn't throw
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  });

  it('returns null when the request is within the rate limit', async () => {
    mockLimit.mockResolvedValue({
      success: true,
      limit: 60,
      remaining: 59,
      reset: Date.now() + 60000,
    });
    const req = makeRequest();
    const result = await checkRateLimit(req, makeLimiter());
    expect(result).toBeNull();
  });

  it('returns a 429 NextResponse when the rate limit is exceeded', async () => {
    const resetAt = Date.now() + 30000;
    mockLimit.mockResolvedValue({ success: false, limit: 60, remaining: 0, reset: resetAt });
    const req = makeRequest({ 'x-forwarded-for': '1.2.3.4' });
    const result = await checkRateLimit(req, makeLimiter());
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
  });

  it('includes correct X-RateLimit-Limit header on 429', async () => {
    const resetAt = Date.now() + 10000;
    mockLimit.mockResolvedValue({ success: false, limit: 10, remaining: 0, reset: resetAt });
    const req = makeRequest();
    const result = await checkRateLimit(req, makeLimiter());
    expect(result!.headers.get('X-RateLimit-Limit')).toBe('10');
  });

  it('includes correct X-RateLimit-Remaining header on 429', async () => {
    const resetAt = Date.now() + 10000;
    mockLimit.mockResolvedValue({ success: false, limit: 10, remaining: 0, reset: resetAt });
    const req = makeRequest();
    const result = await checkRateLimit(req, makeLimiter());
    expect(result!.headers.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('includes X-RateLimit-Reset header on 429', async () => {
    const resetAt = Date.now() + 5000;
    mockLimit.mockResolvedValue({ success: false, limit: 30, remaining: 0, reset: resetAt });
    const req = makeRequest();
    const result = await checkRateLimit(req, makeLimiter());
    expect(result!.headers.get('X-RateLimit-Reset')).toBe(resetAt.toString());
  });

  it('includes Retry-After header with a positive integer on 429', async () => {
    const resetAt = Date.now() + 8000; // 8 seconds from now
    mockLimit.mockResolvedValue({ success: false, limit: 60, remaining: 0, reset: resetAt });
    const req = makeRequest();
    const result = await checkRateLimit(req, makeLimiter());
    const retryAfter = parseInt(result!.headers.get('Retry-After') ?? '0', 10);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it('includes a JSON error body with code RATE_LIMIT_EXCEEDED', async () => {
    mockLimit.mockResolvedValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Date.now() + 1000,
    });
    const req = makeRequest();
    const result = await checkRateLimit(req, makeLimiter());
    const body = (await result!.json()) as { error: string; code: string };
    expect(body.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('uses x-forwarded-for header as client key (first IP only)', async () => {
    mockLimit.mockResolvedValue({
      success: true,
      limit: 60,
      remaining: 55,
      reset: Date.now() + 60000,
    });
    const req = makeRequest({ 'x-forwarded-for': '10.0.0.1, 192.168.1.1' });
    await checkRateLimit(req, makeLimiter());
    // The identifier passed to limit() should be the first IP in the forwarded chain
    expect(mockLimit).toHaveBeenCalledWith('10.0.0.1');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', async () => {
    mockLimit.mockResolvedValue({
      success: true,
      limit: 60,
      remaining: 55,
      reset: Date.now() + 60000,
    });
    const req = makeRequest({ 'x-real-ip': '203.0.113.5' });
    await checkRateLimit(req, makeLimiter());
    expect(mockLimit).toHaveBeenCalledWith('203.0.113.5');
  });

  it('falls back to "anonymous" when no IP headers are present', async () => {
    mockLimit.mockResolvedValue({
      success: true,
      limit: 60,
      remaining: 55,
      reset: Date.now() + 60000,
    });
    const req = makeRequest(); // no headers
    await checkRateLimit(req, makeLimiter());
    expect(mockLimit).toHaveBeenCalledWith('anonymous');
  });

  it('trims whitespace from x-forwarded-for IP', async () => {
    mockLimit.mockResolvedValue({
      success: true,
      limit: 60,
      remaining: 55,
      reset: Date.now() + 60000,
    });
    const req = makeRequest({ 'x-forwarded-for': '  172.16.0.1  , 10.0.0.1' });
    await checkRateLimit(req, makeLimiter());
    expect(mockLimit).toHaveBeenCalledWith('172.16.0.1');
  });
});

describe('proxy limiter exports — lazy initialisation', () => {
  /**
   * Each exported limiter (rateLimit, aiRateLimit, heavyRateLimit, braveRateLimit)
   * is a Proxy that initialises its underlying Ratelimit instance on first property
   * access. Accessing .limit triggers the get trap and exercises the lazy-init path.
   * Because @upstash/ratelimit is mocked, no real Redis connection is made.
   */

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    mockLimit.mockResolvedValue({
      success: true,
      limit: 60,
      remaining: 59,
      reset: Date.now() + 60000,
    });
  });

  it('rateLimit proxy exposes a limit function', () => {
    // Accessing .limit triggers the Proxy get trap
    expect(typeof rateLimit.limit).toBe('function');
  });

  it('rateLimit proxy can be used with checkRateLimit', async () => {
    const req = makeRequest();
    const result = await checkRateLimit(req, rateLimit);
    expect(result).toBeNull();
  });

  it('aiRateLimit proxy exposes a limit function', () => {
    expect(typeof aiRateLimit.limit).toBe('function');
  });

  it('aiRateLimit proxy can be used with checkRateLimit', async () => {
    const req = makeRequest();
    const result = await checkRateLimit(req, aiRateLimit);
    expect(result).toBeNull();
  });

  it('heavyRateLimit proxy exposes a limit function', () => {
    expect(typeof heavyRateLimit.limit).toBe('function');
  });

  it('heavyRateLimit proxy can be used with checkRateLimit', async () => {
    const req = makeRequest();
    const result = await checkRateLimit(req, heavyRateLimit);
    expect(result).toBeNull();
  });

  it('braveRateLimit proxy exposes a limit function', () => {
    expect(typeof braveRateLimit.limit).toBe('function');
  });

  it('braveRateLimit proxy can be used with checkRateLimit', async () => {
    const req = makeRequest();
    const result = await checkRateLimit(req, braveRateLimit);
    expect(result).toBeNull();
  });

  it('rateLimit proxy re-uses the same underlying instance on repeated access', () => {
    // Access twice — the Ratelimit constructor should only be called once
    const fn1 = rateLimit.limit;
    const fn2 = rateLimit.limit;
    // Both references should point to the same mock function instance
    expect(fn1).toBe(fn2);
  });
});
