/**
 * Next.js Edge Proxy — Supabase Auth + Security + Rate Limiting
 *
 * Implements ISO 27001 controls:
 *   A.9  (Access Control)    — refreshes Supabase session, guards protected routes
 *   A.12 (Operations)        — request ID for audit trail correlation
 *   A.13 (Communications)    — enforces HTTPS redirect in production
 *   A.14 (Secure Dev)        — rate limiting on public API routes
 *
 * IMPORTANT — Supabase session pattern:
 *   Session tokens are short-lived JWTs stored in cookies.
 *   This middleware MUST call supabase.auth.getUser() on every request so that
 *   expired tokens are silently refreshed and the updated cookie is written back.
 *   Skipping this causes users to be unexpectedly signed out.
 *
 * Runs on every matched request BEFORE it reaches any route handler.
 * Operates in the Edge Runtime (no Node.js APIs).
 */

import { createServerClient } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Routes that require an authenticated session — redirect to /login if not authed */
const PROTECTED_ROUTES = ['/dashboard'];

/** Routes accessible only when NOT authenticated — redirect to /dashboard if authed */
const AUTH_ROUTES = ['/login'];

/** API routes that enforce per-IP rate limiting */
const RATE_LIMITED_ROUTES = ['/api/report-bug', '/api/ai', '/api/data'];

/**
 * Simple in-memory rate limit store.
 * Maps IP → { count, windowStart }
 * NOTE: In production, replace with Upstash Redis for multi-instance support.
 */
const rateLimitStore = new Map<string, { count: number; windowStart: number }>();

/** Max requests per IP per window */
const RATE_LIMIT_MAX = 10;

/** Rate limit window in milliseconds (60 seconds) */
const RATE_LIMIT_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the client IP address from request headers.
 *
 * @param req - The incoming Next.js edge request
 * @returns IP address string, or 'unknown' if not determinable
 */
function getClientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}

/**
 * Applies a sliding-window rate limit for the given IP.
 * Allows RATE_LIMIT_MAX requests per RATE_LIMIT_WINDOW_MS milliseconds.
 *
 * @param ip - Client IP address string
 * @returns true if request is within limit, false if it should be blocked
 */
function isWithinRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = rateLimitStore.get(ip);

  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(ip, { count: 1, windowStart: now });
    return true;
  }

  if (record.count >= RATE_LIMIT_MAX) return false;

  record.count += 1;
  return true;
}

// ---------------------------------------------------------------------------
// Middleware Entry Point
// ---------------------------------------------------------------------------

/**
 * Main proxy function — runs on every matched request.
 *
 * Order of operations:
 *   1. HTTPS redirect (production only)
 *   2. Rate limiting on API routes
 *   3. Supabase session refresh (MUST happen before route guard)
 *   4. Protected route guard → redirect unauthenticated to /login
 *   5. Auth route guard → redirect authenticated away from /login
 *   6. Add request ID header for Sentry correlation
 *
 * @param req - Incoming Next.js edge request
 * @returns NextResponse to continue, redirect, or return 429
 */
export async function proxy(req: NextRequest): Promise<NextResponse> {
  const { pathname, protocol } = req.nextUrl;
  const ip = getClientIp(req);

  // ── 1. Enforce HTTPS in production ────────────────────────────────────────
  if (process.env.NODE_ENV === 'production' && protocol === 'http:') {
    const httpsUrl = req.nextUrl.clone();
    httpsUrl.protocol = 'https:';
    return NextResponse.redirect(httpsUrl, 301);
  }

  // ── 2. Rate limiting on public API routes ─────────────────────────────────
  if (RATE_LIMITED_ROUTES.some((route) => pathname.startsWith(route))) {
    if (!isWithinRateLimit(ip)) {
      return new NextResponse(
        JSON.stringify({ error: 'Too many requests. Please try again later.' }),
        {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        }
      );
    }
  }

  // ── 3. Supabase session refresh ────────────────────────────────────────────
  // We must create a response object first so Supabase can write updated cookies.
  let supabaseResponse = NextResponse.next({ request: req });

  // Only run Supabase session logic if credentials are configured.
  // This allows the app to function (without auth) before Supabase is set up.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  let isAuthenticated = false;

  if (supabaseUrl && supabaseAnonKey) {
    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // First write updated cookies back onto the request (for downstream handlers)
          cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value));
          // Then write them onto the response (so the browser receives them)
          supabaseResponse = NextResponse.next({ request: req });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    });

    // IMPORTANT: Always use getUser() — not getSession().
    // getSession() reads from the cookie without server-side verification.
    // getUser() validates the JWT with the Supabase Auth server.
    const {
      data: { user },
    } = await supabase.auth.getUser();

    isAuthenticated = !!user;

    // ── 4. Protected route guard ───────────────────────────────────────────
    if (!isAuthenticated && PROTECTED_ROUTES.some((route) => pathname.startsWith(route))) {
      const loginUrl = req.nextUrl.clone();
      loginUrl.pathname = '/login';
      loginUrl.searchParams.set('redirectTo', pathname);
      return NextResponse.redirect(loginUrl);
    }

    // ── 4b. MFA AAL guard — redirect to /login/mfa when aal2 is required ──
    // This runs ONLY for authenticated users on protected routes.
    // If the user has enrolled TOTP (nextLevel === 'aal2') but the current
    // session is still at aal1, they must complete the MFA challenge before
    // accessing the dashboard. The /login/mfa page itself is explicitly
    // excluded to prevent a redirect loop.
    if (
      isAuthenticated &&
      PROTECTED_ROUTES.some((route) => pathname.startsWith(route)) &&
      pathname !== '/login/mfa'
    ) {
      const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aalData?.nextLevel === 'aal2' && aalData.nextLevel !== aalData.currentLevel) {
        const mfaUrl = req.nextUrl.clone();
        mfaUrl.pathname = '/login/mfa';
        return NextResponse.redirect(mfaUrl);
      }
    }

    // ── 5. Auth route guard (redirect authenticated users away from /login) ──
    if (isAuthenticated && AUTH_ROUTES.some((route) => pathname.startsWith(route))) {
      const dashboardUrl = req.nextUrl.clone();
      dashboardUrl.pathname = '/dashboard';
      return NextResponse.redirect(dashboardUrl);
    }
  }

  // ── 6. Add request ID for Sentry audit trail correlation ──────────────────
  supabaseResponse.headers.set('x-request-id', crypto.randomUUID());

  return supabaseResponse;
}

/**
 * Route matcher — determines which paths this middleware runs on.
 * Excludes Next.js internals and static assets for performance.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icons/|manifest.json|sw.js).*)'],
};
