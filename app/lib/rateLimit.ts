/**
 * Rate Limiting — Upstash Redis Sliding Window
 *
 * Distributed rate limiter backed by Upstash Redis. Replaces the previous
 * in-memory token bucket implementation so limits are shared across all
 * serverless function instances (Vercel edge workers included).
 *
 * Four limiters are exported:
 *   - rateLimit      — general API routes: 60 req/min
 *   - heavyRateLimit — heavy data routes (VUR, EJF, Tinglysning, PDF): 30 req/min
 *   - aiRateLimit    — Claude AI routes: 10 req/min
 *   - braveRateLimit — Brave Search routes: 500 req/day
 *
 * Usage:
 * ```ts
 * import { checkRateLimit, aiRateLimit } from '@/app/lib/rateLimit';
 *
 * export async function POST(req: NextRequest) {
 *   const limited = await checkRateLimit(req, aiRateLimit);
 *   if (limited) return limited; // 429 response
 *   // ... handler logic
 * }
 * ```
 *
 * @module app/lib/rateLimit
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { NextRequest, NextResponse } from 'next/server';

// ─── Lazy Redis + Limiters ───────────────────────────────────────────────────
// Initialised on first use so Next.js static page collection doesn't fail
// if env vars aren't present during the build phase.

let _redis: Redis | null = null;
let _rateLimit: Ratelimit | null = null;
let _heavyRateLimit: Ratelimit | null = null;
let _aiRateLimit: Ratelimit | null = null;
let _braveRateLimit: Ratelimit | null = null;

/**
 * Returns the shared Redis client, initialising it on first call.
 * Throws if env vars are missing (expected only at runtime, not build time).
 */
function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return _redis;
}

/** Standard rate limit for general API routes: 60 req/min per IP */
export const rateLimit: Ratelimit = new Proxy({} as Ratelimit, {
  get(_target, prop) {
    if (!_rateLimit) {
      _rateLimit = new Ratelimit({
        redis: getRedis(),
        limiter: Ratelimit.slidingWindow(60, '1 m'),
        analytics: true,
        prefix: 'ba:ratelimit',
      });
    }
    return (_rateLimit as unknown as Record<string | symbol, unknown>)[prop];
  },
});

/** AI (Claude) routes: 10 req/min per IP — expensive upstream calls */
export const aiRateLimit: Ratelimit = new Proxy({} as Ratelimit, {
  get(_target, prop) {
    if (!_aiRateLimit) {
      _aiRateLimit = new Ratelimit({
        redis: getRedis(),
        limiter: Ratelimit.slidingWindow(10, '1 m'),
        analytics: true,
        prefix: 'ba:ai-ratelimit',
      });
    }
    return (_aiRateLimit as unknown as Record<string | symbol, unknown>)[prop];
  },
});

/** Heavy data routes (VUR, EJF, Tinglysning, PDF): 30 req/min per IP — costly upstream calls */
export const heavyRateLimit: Ratelimit = new Proxy({} as Ratelimit, {
  get(_target, prop) {
    if (!_heavyRateLimit) {
      _heavyRateLimit = new Ratelimit({
        redis: getRedis(),
        limiter: Ratelimit.slidingWindow(30, '1 m'),
        analytics: true,
        prefix: 'ba:heavy-ratelimit',
      });
    }
    return (_heavyRateLimit as unknown as Record<string | symbol, unknown>)[prop];
  },
});

/** Brave Search routes: 500 req/day per IP — stays within 20k/month plan */
export const braveRateLimit: Ratelimit = new Proxy({} as Ratelimit, {
  get(_target, prop) {
    if (!_braveRateLimit) {
      _braveRateLimit = new Ratelimit({
        redis: getRedis(),
        limiter: Ratelimit.slidingWindow(500, '1 d'),
        analytics: true,
        prefix: 'ba:brave-ratelimit',
      });
    }
    return (_braveRateLimit as unknown as Record<string | symbol, unknown>)[prop];
  },
});

// ─── Helper ──────────────────────────────────────────────────────────────────

/**
 * Extract a client identifier from the request headers.
 * Uses x-forwarded-for (Vercel/proxies) or x-real-ip as fallback.
 * Note: IP is only used as a rate-limit key — never logged (ISO 27001).
 *
 * @param req - Incoming Next.js request
 * @returns Opaque client key string
 */
function getClientKey(req: NextRequest | Request): string {
  const headers = req.headers;
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  const realIp = headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'anonymous';
}

/**
 * Check rate limit for an incoming request using an Upstash Ratelimit instance.
 * Returns null if the request is allowed, or a 429 NextResponse if exceeded.
 *
 * @param req     - Incoming Next.js request
 * @param limiter - Ratelimit instance (rateLimit / aiRateLimit / braveRateLimit)
 * @returns null if allowed, or a 429 NextResponse with rate limit headers
 */
export async function checkRateLimit(
  req: NextRequest | Request,
  limiter: Ratelimit
): Promise<NextResponse | null> {
  const identifier = getClientKey(req);
  const { success, limit, remaining, reset } = await limiter.limit(identifier);

  if (!success) {
    return NextResponse.json(
      { error: 'Too many requests — try again later', code: 'RATE_LIMIT_EXCEEDED' },
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit': limit.toString(),
          'X-RateLimit-Remaining': remaining.toString(),
          'X-RateLimit-Reset': reset.toString(),
          'Retry-After': Math.ceil((reset - Date.now()) / 1000).toString(),
        },
      }
    );
  }

  return null;
}
