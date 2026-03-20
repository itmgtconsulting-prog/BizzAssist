/**
 * OAuth callback handler — GET /auth/callback
 *
 * Supabase redirects here after a successful Google or LinkedIn OAuth flow.
 * This route exchanges the temporary authorization code for a real session
 * and writes the session cookie before redirecting the user into the app.
 *
 * Flow:
 *   1. User clicks "Sign in with Google/LinkedIn"
 *   2. Supabase redirects to the OAuth provider
 *   3. Provider redirects back to /auth/callback?code=XXX
 *   4. This route exchanges the code for a session (server-side)
 *   5. Redirects to /dashboard (or the original redirectTo URL)
 *
 * ISO 27001 A.9 (Access Control): validates the auth code server-side —
 * the session token is never exposed in the URL or client-side JavaScript.
 */

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Handles the OAuth/magic-link callback from Supabase.
 * Exchanges the authorization code for a session cookie.
 *
 * @param request - Incoming GET request with ?code and optional ?next params
 * @returns Redirect to the dashboard or error page
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/dashboard';

  // If no code is present, redirect to login with error
  if (!code) {
    console.error('[auth/callback] No authorization code received');
    return NextResponse.redirect(`${origin}/login?error=no_code`);
  }

  const cookieStore = await cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        },
      },
    }
  );

  // Exchange the authorization code for a session.
  // This sets the session cookies and authenticates the user.
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error('[auth/callback] Code exchange failed:', error.message);
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  // Ensure the redirect target is relative (prevent open redirect attacks)
  const safeNext = next.startsWith('/') ? next : '/dashboard';

  return NextResponse.redirect(`${origin}${safeNext}`);
}
