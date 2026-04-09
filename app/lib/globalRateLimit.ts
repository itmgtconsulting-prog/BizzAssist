/**
 * Global Rate Limiting — Middleware-level Upstash Sliding Window
 *
 * Provides a coarse-grained request budget applied in `middleware.ts` before
 * any auth check or route handler runs.  Because middleware executes on the
 * Vercel Edge Runtime this module must be import-safe from both Node.js and
 * the Edge runtime (no Node-only APIs).
 *
 * Two tiers are defined:
 *   - anonymous  — 100 requests per 10 seconds per IP
 *   - authenticated — 200 requests per 10 seconds per user ID
 *
 * If the Upstash env vars are absent the helpers return `null` (pass-through)
 * so local development and cold-start static rendering are never blocked.
 *
 * Usage (in middleware.ts):
 * ```ts
 * const limited = await applyGlobalRateLimit(request, userId);
 * if (limited) return limited; // 429 response
 * ```
 *
 * @module app/lib/globalRateLimit
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { NextRequest, NextResponse } from 'next/server';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum requests per window for unauthenticated (IP-keyed) traffic. */
export const ANON_LIMIT = 100;

/** Maximum requests per window for authenticated (user-ID-keyed) traffic. */
export const AUTH_LIMIT = 200;

/** Sliding window duration in seconds. */
export const WINDOW_SECONDS = 10;

// ─── Lazy singletons ─────────────────────────────────────────────────────────
// Initialised on first use so Next.js static-page collection (which runs
// without env vars during `next build`) never throws.

let _redis: Redis | null = null;
let _anonLimiter: Ratelimit | null = null;
let _authLimiter: Ratelimit | null = null;

/**
 * Returns true when the required Upstash env vars are present.
 * When false all rate-limit checks are skipped (graceful degradation).
 */
export function isUpstashConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

/**
 * Returns (and lazily initialises) the shared Redis client.
 * Caller must guard with `isUpstashConfigured()` before calling.
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

/**
 * Returns the sliding-window limiter for anonymous (IP-keyed) requests.
 * Lazily initialised on first call.
 */
export function getAnonLimiter(): Ratelimit {
  if (!_anonLimiter) {
    _anonLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(ANON_LIMIT, `${WINDOW_SECONDS} s`),
      analytics: true,
      prefix: 'ba:global:anon',
    });
  }
  return _anonLimiter;
}

/**
 * Returns the sliding-window limiter for authenticated (user-ID-keyed) requests.
 * Lazily initialised on first call.
 */
export function getAuthLimiter(): Ratelimit {
  if (!_authLimiter) {
    _authLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(AUTH_LIMIT, `${WINDOW_SECONDS} s`),
      analytics: true,
      prefix: 'ba:global:auth',
    });
  }
  return _authLimiter;
}

// ─── IP extraction ────────────────────────────────────────────────────────────

/**
 * Extracts a stable, opaque client key from request headers.
 *
 * Order of preference:
 *  1. `x-forwarded-for` first entry (set by Vercel / load balancers)
 *  2. `x-real-ip`
 *  3. Literal string `"anonymous"` as a final catch-all
 *
 * The value is used only as a Redis key — it is never logged (ISO 27001 §8).
 *
 * @param request - Incoming Edge request
 * @returns Opaque rate-limit key string
 */
export function extractClientKey(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();

  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();

  return 'anonymous';
}

// ─── Static-asset exemption ───────────────────────────────────────────────────

/**
 * Returns true if the request path should be exempt from global rate limiting.
 *
 * Exempt paths:
 *  - `/_next/*`  — Next.js static chunks and images
 *  - `/favicon*` — Favicon files
 *  - `/icons/*`  — PWA icon assets
 *  - `/sw.js`    — Service worker
 *  - `/manifest.json` — PWA manifest
 *  - `/robots.txt` — Crawler hint file
 *
 * @param pathname - The `request.nextUrl.pathname` value
 * @returns true when the path is exempt from global rate limiting
 */
export function isExemptPath(pathname: string): boolean {
  return (
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/icons/') ||
    pathname === '/sw.js' ||
    pathname === '/manifest.json' ||
    pathname === '/robots.txt'
  );
}

// ─── 429 response builder ─────────────────────────────────────────────────────

/**
 * Builds a 429 Too Many Requests response with standard rate-limit headers.
 *
 * Headers returned:
 *  - `X-RateLimit-Limit`     — window ceiling
 *  - `X-RateLimit-Remaining` — tokens left (always 0 on rejection)
 *  - `X-RateLimit-Reset`     — Unix ms timestamp when the window resets
 *  - `Retry-After`           — seconds until the window resets (RFC 7231)
 *
 * @param limit     - The configured request ceiling for this window
 * @param remaining - Tokens remaining (0 on block)
 * @param reset     - Unix millisecond timestamp of window expiry
 * @returns A 429 NextResponse
 */
export function buildRateLimitResponse(
  limit: number,
  remaining: number,
  reset: number
): NextResponse {
  const retryAfterSeconds = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
  return NextResponse.json(
    { error: 'Too many requests — slow down', code: 'GLOBAL_RATE_LIMIT_EXCEEDED' },
    {
      status: 429,
      headers: {
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': String(remaining),
        'X-RateLimit-Reset': String(reset),
        'Retry-After': String(retryAfterSeconds),
      },
    }
  );
}

// ─── Main helper ──────────────────────────────────────────────────────────────

/**
 * Applies the appropriate global rate limit tier to an incoming request.
 *
 * - If Upstash is not configured, returns `null` (pass-through).
 * - If the path is a static-asset exempt path, returns `null`.
 * - If `userId` is provided, uses the higher authenticated-user limit keyed
 *   by user ID so tokens are not shared across users.
 * - Otherwise falls back to the anonymous IP-keyed limit.
 *
 * Returns `null` when the request is allowed, or a 429 `NextResponse` when
 * the limit is exceeded.
 *
 * @param request - Incoming Next.js Edge request
 * @param userId  - Authenticated Supabase user ID if already known, or null
 * @returns null if allowed, or a 429 NextResponse if the limit is exceeded
 */
export async function applyGlobalRateLimit(
  request: NextRequest,
  userId: string | null
): Promise<NextResponse | null> {
  // Graceful degradation — don't block requests when Redis isn't configured.
  if (!isUpstashConfigured()) return null;

  // Static assets don't contribute to the rate-limit budget.
  if (isExemptPath(request.nextUrl.pathname)) return null;

  let identifier: string;
  let limiter: Ratelimit;

  if (userId) {
    // Authenticated tier: keyed by user ID, higher ceiling.
    identifier = `user:${userId}`;
    limiter = getAuthLimiter();
  } else {
    // Anonymous tier: keyed by IP, lower ceiling.
    identifier = extractClientKey(request);
    limiter = getAnonLimiter();
  }

  const { success, limit, remaining, reset } = await limiter.limit(identifier);

  if (!success) {
    return buildRateLimitResponse(limit, remaining, reset);
  }

  return null;
}
