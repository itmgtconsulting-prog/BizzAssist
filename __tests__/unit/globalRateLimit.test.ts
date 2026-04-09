/**
 * Unit tests for app/lib/globalRateLimit.
 *
 * globalRateLimit.ts provides the middleware-level coarse rate limiter that
 * runs before any auth check.  Upstash Redis and the Ratelimit class are
 * fully mocked so no network calls are made.
 *
 * Covers:
 *  - isUpstashConfigured: true/false based on env vars
 *  - isExemptPath: static assets, /_next/*, favicon, sw.js, manifest, robots
 *  - extractClientKey: x-forwarded-for (first IP), x-real-ip, anonymous fallback
 *  - buildRateLimitResponse: status 429, correct headers, JSON body with code
 *  - applyGlobalRateLimit: pass-through when Upstash unconfigured
 *  - applyGlobalRateLimit: pass-through for exempt paths
 *  - applyGlobalRateLimit: allowed request returns null
 *  - applyGlobalRateLimit: exceeded limit returns 429 with headers
 *  - applyGlobalRateLimit: authenticated tier uses userId as key
 *  - applyGlobalRateLimit: anonymous tier uses IP key
 *  - getAnonLimiter / getAuthLimiter: return Ratelimit instances
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock Upstash before importing the module under test ──────────────────────

const mockLimit = vi.fn();

vi.mock('@upstash/ratelimit', () => {
  function Ratelimit(_opts: Record<string, unknown>) {
    return { limit: mockLimit };
  }
  Ratelimit.slidingWindow = vi.fn().mockReturnValue({});
  return { Ratelimit };
});

vi.mock('@upstash/redis', () => {
  class Redis {
    constructor(_opts: Record<string, unknown>) {}
  }
  return { Redis };
});

// Import after mocks
import {
  isUpstashConfigured,
  isExemptPath,
  extractClientKey,
  buildRateLimitResponse,
  applyGlobalRateLimit,
  getAnonLimiter,
  getAuthLimiter,
  ANON_LIMIT,
  AUTH_LIMIT,
  WINDOW_SECONDS,
} from '@/app/lib/globalRateLimit';
import { NextRequest } from 'next/server';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a minimal NextRequest for a given path and optional headers.
 */
function makeRequest(pathname = '/dashboard', headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://bizzassist.dk${pathname}`, { headers });
}

/**
 * Sets the Upstash env vars so isUpstashConfigured() returns true.
 */
function enableUpstash(): void {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
}

/**
 * Clears the Upstash env vars so isUpstashConfigured() returns false.
 */
function disableUpstash(): void {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

// ─── isUpstashConfigured ──────────────────────────────────────────────────────

describe('isUpstashConfigured', () => {
  afterEach(disableUpstash);

  it('returns true when both env vars are set', () => {
    enableUpstash();
    expect(isUpstashConfigured()).toBe(true);
  });

  it('returns false when UPSTASH_REDIS_REST_URL is missing', () => {
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    delete process.env.UPSTASH_REDIS_REST_URL;
    expect(isUpstashConfigured()).toBe(false);
  });

  it('returns false when UPSTASH_REDIS_REST_TOKEN is missing', () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    expect(isUpstashConfigured()).toBe(false);
  });

  it('returns false when both env vars are missing', () => {
    disableUpstash();
    expect(isUpstashConfigured()).toBe(false);
  });
});

// ─── isExemptPath ─────────────────────────────────────────────────────────────

describe('isExemptPath', () => {
  it('exempts /_next/ prefixed paths', () => {
    expect(isExemptPath('/_next/static/chunks/main.js')).toBe(true);
    expect(isExemptPath('/_next/image?url=foo')).toBe(true);
  });

  it('exempts /favicon files', () => {
    expect(isExemptPath('/favicon.ico')).toBe(true);
    expect(isExemptPath('/favicon-16x16.png')).toBe(true);
  });

  it('exempts /icons/ directory', () => {
    expect(isExemptPath('/icons/icon-192.png')).toBe(true);
    expect(isExemptPath('/icons/icon-512.png')).toBe(true);
  });

  it('exempts /sw.js exactly', () => {
    expect(isExemptPath('/sw.js')).toBe(true);
  });

  it('exempts /manifest.json exactly', () => {
    expect(isExemptPath('/manifest.json')).toBe(true);
  });

  it('exempts /robots.txt exactly', () => {
    expect(isExemptPath('/robots.txt')).toBe(true);
  });

  it('does not exempt /dashboard', () => {
    expect(isExemptPath('/dashboard')).toBe(false);
  });

  it('does not exempt /api/cvr', () => {
    expect(isExemptPath('/api/cvr')).toBe(false);
  });

  it('does not exempt /', () => {
    expect(isExemptPath('/')).toBe(false);
  });

  it('does not exempt /login', () => {
    expect(isExemptPath('/login')).toBe(false);
  });
});

// ─── extractClientKey ─────────────────────────────────────────────────────────

describe('extractClientKey', () => {
  it('returns the first IP from x-forwarded-for', () => {
    const req = makeRequest('/dashboard', {
      'x-forwarded-for': '1.2.3.4, 10.0.0.1',
    });
    expect(extractClientKey(req)).toBe('1.2.3.4');
  });

  it('trims whitespace from x-forwarded-for', () => {
    const req = makeRequest('/dashboard', {
      'x-forwarded-for': '  172.16.0.1  , 10.0.0.2',
    });
    expect(extractClientKey(req)).toBe('172.16.0.1');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    const req = makeRequest('/dashboard', { 'x-real-ip': '203.0.113.1' });
    expect(extractClientKey(req)).toBe('203.0.113.1');
  });

  it('trims whitespace from x-real-ip', () => {
    const req = makeRequest('/dashboard', { 'x-real-ip': '  99.99.99.99  ' });
    expect(extractClientKey(req)).toBe('99.99.99.99');
  });

  it('returns "anonymous" when no IP headers are present', () => {
    const req = makeRequest('/dashboard');
    expect(extractClientKey(req)).toBe('anonymous');
  });

  it('prefers x-forwarded-for over x-real-ip', () => {
    const req = makeRequest('/dashboard', {
      'x-forwarded-for': '5.5.5.5',
      'x-real-ip': '6.6.6.6',
    });
    expect(extractClientKey(req)).toBe('5.5.5.5');
  });
});

// ─── buildRateLimitResponse ───────────────────────────────────────────────────

describe('buildRateLimitResponse', () => {
  it('returns status 429', () => {
    const res = buildRateLimitResponse(100, 0, Date.now() + 5000);
    expect(res.status).toBe(429);
  });

  it('includes X-RateLimit-Limit header', () => {
    const res = buildRateLimitResponse(100, 0, Date.now() + 5000);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('100');
  });

  it('includes X-RateLimit-Remaining header', () => {
    const res = buildRateLimitResponse(100, 0, Date.now() + 5000);
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('includes X-RateLimit-Reset header matching the reset timestamp', () => {
    const reset = Date.now() + 8000;
    const res = buildRateLimitResponse(100, 0, reset);
    expect(res.headers.get('X-RateLimit-Reset')).toBe(String(reset));
  });

  it('includes Retry-After header as a positive integer', () => {
    const res = buildRateLimitResponse(100, 0, Date.now() + 7000);
    const retryAfter = parseInt(res.headers.get('Retry-After') ?? '0', 10);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it('sets Retry-After to at least 1 when reset is in the past', () => {
    // Reset in the past — Retry-After should be clamped to 1
    const res = buildRateLimitResponse(100, 0, Date.now() - 1000);
    const retryAfter = parseInt(res.headers.get('Retry-After') ?? '0', 10);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  it('includes JSON body with code GLOBAL_RATE_LIMIT_EXCEEDED', async () => {
    const res = buildRateLimitResponse(100, 0, Date.now() + 5000);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('GLOBAL_RATE_LIMIT_EXCEEDED');
  });

  it('includes a human-readable error string in the body', async () => {
    const res = buildRateLimitResponse(100, 0, Date.now() + 5000);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });
});

// ─── applyGlobalRateLimit ─────────────────────────────────────────────────────

describe('applyGlobalRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enableUpstash();
    // Default: allow the request
    mockLimit.mockResolvedValue({
      success: true,
      limit: ANON_LIMIT,
      remaining: ANON_LIMIT - 1,
      reset: Date.now() + WINDOW_SECONDS * 1000,
    });
  });

  afterEach(disableUpstash);

  it('returns null (pass-through) when Upstash env vars are not set', async () => {
    disableUpstash();
    const req = makeRequest('/dashboard');
    const result = await applyGlobalRateLimit(req, null);
    expect(result).toBeNull();
    // limiter should never be called
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it('returns null for /_next/ static asset paths', async () => {
    const req = makeRequest('/_next/static/chunks/main.js');
    const result = await applyGlobalRateLimit(req, null);
    expect(result).toBeNull();
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it('returns null for /sw.js', async () => {
    const req = makeRequest('/sw.js');
    const result = await applyGlobalRateLimit(req, null);
    expect(result).toBeNull();
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it('returns null for /manifest.json', async () => {
    const req = makeRequest('/manifest.json');
    const result = await applyGlobalRateLimit(req, null);
    expect(result).toBeNull();
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it('returns null when the request is within the anonymous limit', async () => {
    const req = makeRequest('/dashboard');
    const result = await applyGlobalRateLimit(req, null);
    expect(result).toBeNull();
  });

  it('returns a 429 NextResponse when the anonymous limit is exceeded', async () => {
    mockLimit.mockResolvedValue({
      success: false,
      limit: ANON_LIMIT,
      remaining: 0,
      reset: Date.now() + 5000,
    });
    const req = makeRequest('/dashboard');
    const result = await applyGlobalRateLimit(req, null);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
  });

  it('uses "user:<userId>" as the limiter key for authenticated requests', async () => {
    const req = makeRequest('/dashboard');
    await applyGlobalRateLimit(req, 'user-uuid-123');
    expect(mockLimit).toHaveBeenCalledWith('user:user-uuid-123');
  });

  it('uses the IP as the limiter key for anonymous requests', async () => {
    const req = makeRequest('/dashboard', { 'x-forwarded-for': '1.2.3.4' });
    await applyGlobalRateLimit(req, null);
    expect(mockLimit).toHaveBeenCalledWith('1.2.3.4');
  });

  it('uses "anonymous" as the limiter key when there is no IP header', async () => {
    const req = makeRequest('/dashboard');
    await applyGlobalRateLimit(req, null);
    expect(mockLimit).toHaveBeenCalledWith('anonymous');
  });

  it('returns 429 with correct headers when auth limit is exceeded', async () => {
    mockLimit.mockResolvedValue({
      success: false,
      limit: AUTH_LIMIT,
      remaining: 0,
      reset: Date.now() + 3000,
    });
    const req = makeRequest('/api/ejendomme');
    const result = await applyGlobalRateLimit(req, 'user-abc');
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
    expect(result!.headers.get('X-RateLimit-Limit')).toBe(String(AUTH_LIMIT));
  });

  it('does not call the limiter for /robots.txt', async () => {
    const req = makeRequest('/robots.txt');
    const result = await applyGlobalRateLimit(req, null);
    expect(result).toBeNull();
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it('does call the limiter for /api/cvr (non-exempt path)', async () => {
    const req = makeRequest('/api/cvr');
    await applyGlobalRateLimit(req, null);
    expect(mockLimit).toHaveBeenCalledTimes(1);
  });
});

// ─── Limiter singletons ───────────────────────────────────────────────────────

describe('getAnonLimiter and getAuthLimiter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enableUpstash();
  });

  afterEach(disableUpstash);

  it('getAnonLimiter returns an object with a limit method', () => {
    const limiter = getAnonLimiter();
    expect(typeof limiter.limit).toBe('function');
  });

  it('getAuthLimiter returns an object with a limit method', () => {
    const limiter = getAuthLimiter();
    expect(typeof limiter.limit).toBe('function');
  });

  it('getAnonLimiter returns the same instance on repeated calls', () => {
    const a = getAnonLimiter();
    const b = getAnonLimiter();
    expect(a).toBe(b);
  });

  it('getAuthLimiter returns the same instance on repeated calls', () => {
    const a = getAuthLimiter();
    const b = getAuthLimiter();
    expect(a).toBe(b);
  });
});

// ─── Constants ────────────────────────────────────────────────────────────────

describe('exported constants', () => {
  it('ANON_LIMIT is a positive integer', () => {
    expect(Number.isInteger(ANON_LIMIT)).toBe(true);
    expect(ANON_LIMIT).toBeGreaterThan(0);
  });

  it('AUTH_LIMIT is greater than ANON_LIMIT', () => {
    expect(AUTH_LIMIT).toBeGreaterThan(ANON_LIMIT);
  });

  it('WINDOW_SECONDS is a positive integer', () => {
    expect(Number.isInteger(WINDOW_SECONDS)).toBe(true);
    expect(WINDOW_SECONDS).toBeGreaterThan(0);
  });
});
