/**
 * Rate Limiting — Token Bucket Algorithm
 *
 * In-memory rate limiter for API routes. Uses a Map keyed by client IP
 * with a token bucket per key. Tokens refill at a steady rate; each
 * request consumes one token. When the bucket is empty the client
 * receives HTTP 429 Too Many Requests.
 *
 * Usage:
 * ```ts
 * import { rateLimit } from '@/app/lib/rateLimit';
 *
 * export async function POST(req: NextRequest) {
 *   const limited = rateLimit(req, { maxRequests: 20, windowMs: 60_000 });
 *   if (limited) return limited; // 429 response
 *   // ... handler logic
 * }
 * ```
 *
 * @module app/lib/rateLimit
 */

import { NextRequest, NextResponse } from 'next/server';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Configuration for a rate limit bucket. */
export interface RateLimitConfig {
  /** Maximum number of requests allowed in the window. */
  maxRequests: number;
  /** Time window in milliseconds (e.g. 60_000 for 1 minute). */
  windowMs: number;
}

/** Internal bucket state per client key. */
interface TokenBucket {
  /** Current number of available tokens. */
  tokens: number;
  /** Timestamp (ms) of last refill calculation. */
  lastRefill: number;
}

// ─── Default configs ────────────────────────────────────────────────────────

/** Default rate limit for standard API routes: 100 req/min */
export const API_DEFAULT: RateLimitConfig = { maxRequests: 100, windowMs: 60_000 };

/** Rate limit for AI chat endpoint: 20 req/min */
export const AI_CHAT_LIMIT: RateLimitConfig = { maxRequests: 20, windowMs: 60_000 };

/** Rate limit for search endpoint: 60 req/min */
export const SEARCH_LIMIT: RateLimitConfig = { maxRequests: 60, windowMs: 60_000 };

/** Rate limit for export endpoint: 10 req/min */
export const EXPORT_LIMIT: RateLimitConfig = { maxRequests: 10, windowMs: 60_000 };

// ─── In-memory store ────────────────────────────────────────────────────────

/** Map of client key → token bucket. Shared across all routes in-process. */
const buckets = new Map<string, TokenBucket>();

/** Interval (ms) between cleanup sweeps of expired buckets. */
const CLEANUP_INTERVAL = 5 * 60_000; // 5 minutes

/** Timestamp of last cleanup sweep. */
let lastCleanup = Date.now();

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract a client identifier from the request. Uses x-forwarded-for
 * when behind a reverse proxy, otherwise falls back to a generic key.
 * Note: IP is only used as a rate-limit key — never logged (ISO 27001).
 *
 * @param req - Incoming Next.js request
 * @returns Opaque client key string
 */
function getClientKey(req: NextRequest): string {
  // x-forwarded-for may contain comma-separated IPs; take the first
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  // Next.js on Vercel provides x-real-ip
  const realIp = req.headers.get('x-real-ip');
  if (realIp) {
    return realIp.trim();
  }
  // Fallback — all requests share one bucket (single-user dev)
  return '__default__';
}

/**
 * Refill tokens in a bucket based on elapsed time.
 *
 * @param bucket - The token bucket to refill
 * @param config - Rate limit configuration
 * @param now    - Current timestamp (ms)
 */
function refill(bucket: TokenBucket, config: RateLimitConfig, now: number): void {
  const elapsed = now - bucket.lastRefill;
  // Tokens to add based on elapsed time and refill rate
  const refillRate = config.maxRequests / config.windowMs;
  const newTokens = elapsed * refillRate;
  bucket.tokens = Math.min(config.maxRequests, bucket.tokens + newTokens);
  bucket.lastRefill = now;
}

/**
 * Remove stale buckets that haven't been touched in over 2x the window.
 * Called lazily — not on every request, only when CLEANUP_INTERVAL has passed.
 *
 * @param maxAge - Maximum age in ms before a bucket is removed
 */
function cleanupBuckets(maxAge: number): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;

  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefill > maxAge) {
      buckets.delete(key);
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Check rate limit for an incoming request. Returns null if the request
 * is allowed, or a 429 NextResponse if the client has exceeded the limit.
 *
 * @param req    - Incoming Next.js request
 * @param config - Rate limit configuration (defaults to API_DEFAULT)
 * @returns null if allowed, or a 429 NextResponse with Retry-After header
 */
export function rateLimit(
  req: NextRequest,
  config: RateLimitConfig = API_DEFAULT
): NextResponse | null {
  const now = Date.now();
  const key = getClientKey(req);

  // Lazy cleanup of stale buckets
  cleanupBuckets(config.windowMs * 2);

  let bucket = buckets.get(key);
  if (!bucket) {
    // First request from this client — create a full bucket
    bucket = { tokens: config.maxRequests, lastRefill: now };
    buckets.set(key, bucket);
  }

  // Refill tokens based on elapsed time
  refill(bucket, config, now);

  if (bucket.tokens < 1) {
    // Calculate how long until one token is available
    const refillRate = config.maxRequests / config.windowMs;
    const retryAfterMs = Math.ceil((1 - bucket.tokens) / refillRate);
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);

    return NextResponse.json(
      { error: 'Too many requests — try again later', code: 'RATE_LIMIT_EXCEEDED' },
      {
        status: 429,
        headers: {
          'Retry-After': String(retryAfterSec),
          'X-RateLimit-Limit': String(config.maxRequests),
          'X-RateLimit-Remaining': '0',
        },
      }
    );
  }

  // Consume one token
  bucket.tokens -= 1;

  return null;
}
