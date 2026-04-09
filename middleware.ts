/**
 * Next.js Edge Middleware — Global Rate Limiting + Auth
 *
 * Execution order (for every matched request):
 *  1. Static-asset / exempt-path bypass → pass through immediately.
 *  2. Global rate limit check (Upstash sliding window, per-IP or per-user).
 *     Returns 429 if exceeded — blocks the request before any auth I/O.
 *  3. Supabase session verification.
 *     Unauthenticated API calls → 401 JSON.
 *     Unauthenticated page visits → redirect to /login?redirect=<path>.
 *
 * The global rate limiter runs first so abusive bots are dropped before we
 * spend any Supabase read quota on them.
 *
 * BIZZ-178: global rate limiting (this file)
 * BIZZ-191: auth middleware (Supabase session gate)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { applyGlobalRateLimit } from '@/app/lib/globalRateLimit';

// ─── Public allowlist ─────────────────────────────────────────────────────────

/**
 * Path prefixes and exact paths that do not require an authenticated session.
 * The global rate limiter still applies to these paths (except static assets
 * which are exempted inside `applyGlobalRateLimit` via `isExemptPath`).
 */
const PUBLIC_PATHS: string[] = [
  '/',
  '/login',
  '/signup',
  '/privacy',
  '/virksomhed',
  '/ejendom',
  '/api/auth',
  '/api/stripe/webhook', // Stripe sends raw unsigned bodies — exempt from auth
  '/api/cron', // Protected by CRON_SECRET bearer token separately
  '/manifest.json',
  '/sw.js',
  '/_next',
  '/favicon',
  '/icons',
  '/robots.txt',
];

/**
 * Returns true when the given pathname is publicly accessible without a session.
 *
 * @param pathname - The `request.nextUrl.pathname` value
 * @returns true when no session is required
 */
function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Next.js Edge Middleware — global entry point for every matched request.
 *
 * Applies global rate limiting first, then verifies the Supabase session for
 * protected routes.  See module-level JSDoc for full execution order.
 *
 * @param request - Incoming Next.js request from the Edge runtime
 * @returns NextResponse (pass-through, redirect, 401, or 429)
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // ── Step 1: Global rate limit (before auth to shed abusive load early) ──
  // We don't yet know the user ID at this point — that requires a Supabase
  // round-trip.  Pass null so the anonymous tier is used.  If the session is
  // valid the next request will still use the anonymous key because reading
  // the session cookie in middleware costs a Supabase call which we avoid for
  // performance.  Routes with known user context use per-route limiters via
  // `checkRateLimit` in `app/lib/rateLimit.ts`.
  const rateLimitResponse = await applyGlobalRateLimit(request, null);
  if (rateLimitResponse) return rateLimitResponse;

  // ── Step 2: Public-path bypass — no auth needed ──
  if (isPublicPath(pathname)) return NextResponse.next();

  // ── Step 3: Supabase session verification ──
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const response = NextResponse.next();

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  const {
    data: { session },
  } = await supabase.auth.getSession();

  // ── Step 4: Unauthenticated — reject or redirect ──
  if (!session) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

// ─── Matcher ──────────────────────────────────────────────────────────────────

export const config = {
  matcher: [
    /*
     * Match all request paths except Next.js internals and static files.
     * _next/static and _next/image are handled by the CDN and never reach
     * middleware; favicon.ico is excluded to avoid spurious 401 redirects.
     */
    '/((?!_next/static|_next/image|favicon\\.ico).*)',
  ],
};
