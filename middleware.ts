/**
 * Next.js middleware — authentication guard + rate-limit headers.
 *
 * Runs on every request matched by the `config.matcher` below.
 *
 * Responsibilities:
 *  1. Session refresh — calls Supabase to refresh the access token cookie so
 *     Server Components always receive a fresh session.
 *  2. Auth guard — redirects unauthenticated requests to /dashboard/* → /login.
 *  3. Rate-limit headers — adds X-RateLimit-* headers on API responses so
 *     clients (and future edge-layer tooling) can observe limits.
 *
 * ISO 27001 A.9 (Access Control): unauthenticated users cannot reach any
 * /dashboard route even if they guess a direct URL.
 *
 * @see https://supabase.com/docs/guides/auth/server-side/nextjs
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/** API routes that are public (no auth required). */
const PUBLIC_API_PREFIXES = [
  '/api/health',
  '/api/notify-signup',
  '/api/stripe/webhook',
  '/api/plans',
];

/**
 * Returns true if the pathname is a public API route that must not be
 * blocked by the auth guard.
 *
 * @param pathname - Request pathname
 */
function isPublicApi(pathname: string): boolean {
  return PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Adds baseline rate-limit information headers to an API response.
 * Actual enforcement lives in app/lib/rateLimit.ts — these headers are
 * informational only so dashboards and clients can read the policy.
 *
 * @param response - Mutable NextResponse to annotate
 */
function addRateLimitHeaders(response: NextResponse): void {
  response.headers.set('X-RateLimit-Limit', '60');
  response.headers.set('X-RateLimit-Window', '60s');
  response.headers.set('X-RateLimit-Policy', 'sliding-window');
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Create a mutable response so Supabase can update the session cookie
  let response = NextResponse.next({
    request: { headers: request.headers },
  });

  // ── Supabase session refresh ──────────────────────────────────────────────
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request: { headers: request.headers } });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: getUser() (not getSession()) is used to validate the JWT with
  // Supabase's auth server — not just read from the cookie. This prevents
  // spoofed cookies from bypassing the guard.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // ── Auth guard for /dashboard/* ──────────────────────────────────────────
  if (pathname.startsWith('/dashboard') && !user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('redirectTo', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // ── Rate-limit headers on API routes ────────────────────────────────────
  if (pathname.startsWith('/api') && !isPublicApi(pathname)) {
    addRateLimitHeaders(response);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT:
     *  - _next/static  (static files)
     *  - _next/image   (Next.js image optimisation)
     *  - favicon.ico   (browser default request)
     *  - public assets (icons, manifest, sw.js)
     *
     * This pattern keeps middleware off the hot path for static assets
     * while still running on every page and API route.
     */
    '/((?!_next/static|_next/image|favicon\\.ico|icons/|manifest\\.json|sw\\.js).*)',
  ],
};
