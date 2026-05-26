/**
 * Next.js Edge Middleware
 *
 * Responsibilities:
 *   1. BIZZ-1783: PKCE fallback redirect — when Supabase sends `?code=XXX`
 *      to the homepage (site_url) instead of /auth/callback, we redirect it
 *      so the auth flow completes without forcing homepage into dynamic mode.
 *
 *   2. BIZZ-209: CSP nonce injection (placeholder — nonce-based CSP can be
 *      added here when required without affecting other functionality).
 *
 * @module middleware
 */

import { NextRequest, NextResponse } from 'next/server';

/**
 * Edge middleware — runs on every request before routing.
 *
 * @param request - Incoming Next.js edge request
 * @returns NextResponse (redirect or passthrough)
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname, searchParams } = request.nextUrl;

  // BIZZ-1783: PKCE fallback — Supabase sends /?code=XXX to site_url when
  // the callback URI is not in uri_allow_list. Forward to /auth/callback so
  // the code is exchanged server-side. Hompage stays static/cacheable.
  if (pathname === '/') {
    const code = searchParams.get('code');
    const tokenHash = searchParams.get('token_hash');
    const type = searchParams.get('type');
    const error = searchParams.get('error');

    if (code || tokenHash || type || error) {
      const callbackUrl = new URL('/auth/callback', request.url);
      // Forward all auth-related params to the callback route
      searchParams.forEach((value, key) => {
        callbackUrl.searchParams.set(key, value);
      });
      return NextResponse.redirect(callbackUrl, { status: 302 });
    }
  }

  return NextResponse.next();
}

/**
 * Matcher config — only run middleware on homepage (for PKCE redirect).
 * Excludes static assets, _next internals, and API routes to avoid overhead.
 */
export const config = {
  matcher: [
    '/',
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|ico|webp)).*)',
  ],
};
