/**
 * Next.js Edge Middleware.
 *
 * BIZZ-1783: Intercept Supabase PKCE callback codes at / before they
 * reach the homepage server component. Redirects /?code=X to
 * /auth/callback?code=X so the homepage can be statically cached.
 *
 * @module middleware
 */

import { NextResponse, type NextRequest } from 'next/server';

export function middleware(request: NextRequest): NextResponse | undefined {
  const { pathname, searchParams } = request.nextUrl;

  // BIZZ-1783: PKCE code fallback — Supabase redirects to site_url when
  // uri_allow_list doesn't include the callback URL
  if (pathname === '/' && (searchParams.has('code') || searchParams.has('token_hash'))) {
    const url = request.nextUrl.clone();
    url.pathname = '/auth/callback';
    // Preserve type; default to 'signup' for PKCE codes
    if (searchParams.has('code') && !searchParams.has('type')) {
      url.searchParams.set('type', 'signup');
    }
    return NextResponse.redirect(url);
  }

  return undefined;
}

export const config = {
  // Only run on homepage — don't add overhead to other routes
  matcher: '/',
};
