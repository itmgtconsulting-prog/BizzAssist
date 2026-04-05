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
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Handles the OAuth/magic-link callback from Supabase.
 * Exchanges the authorization code for a session cookie.
 *
 * @param request - Incoming GET request with ?code and optional ?next params
 * @returns Redirect to the dashboard or error page
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);

  // DEBUG: log full callback URL (no PII in query params at this stage)
  console.error('[auth/callback] Full URL:', request.url);
  console.error('[auth/callback] All params:', Object.fromEntries(searchParams.entries()));

  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/dashboard';

  // OAuth providers send error + error_description on failure instead of code
  const oauthError = searchParams.get('error');
  const oauthErrorDesc = searchParams.get('error_description');
  if (oauthError) {
    console.error('[auth/callback] OAuth provider returned error:', oauthError, oauthErrorDesc);
    const details = oauthErrorDesc ?? oauthError;
    return NextResponse.redirect(
      `${origin}/login?error=auth_failed&details=${encodeURIComponent(details)}`
    );
  }

  // If no code is present, redirect to login with error
  if (!code) {
    console.error('[auth/callback] No authorization code received');
    return NextResponse.redirect(
      `${origin}/login?error=no_code&details=${encodeURIComponent('No authorization code in callback URL')}`
    );
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
  console.error('[auth/callback] Attempting code exchange, code length:', code.length);
  const { data: sessionData, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error('[auth/callback] Code exchange failed:', error.message, 'status:', error.status);
    return NextResponse.redirect(
      `${origin}/login?error=auth_failed&details=${encodeURIComponent(error.message)}`
    );
  }
  console.error('[auth/callback] Code exchange succeeded, redirecting to:', next);

  // Ensure the redirect target is relative (prevent open redirect attacks)
  const safeNext = next.startsWith('/') ? next : '/dashboard';

  // ── New OAuth user check ─────────────────────────────────────────────────
  // If this user has no subscription in app_metadata (typical for first-time
  // OAuth logins that bypass the normal signup form), redirect them to the
  // plan-selection page so they can choose and pay for a plan before accessing
  // the dashboard.
  if (sessionData?.user) {
    try {
      const admin = createAdminClient();
      const { data: freshUser } = await admin.auth.admin.getUserById(sessionData.user.id);
      const appMeta = freshUser?.user?.app_metadata ?? {};
      const role = appMeta.role as string | undefined;
      const sub = appMeta.subscription as { planId?: string } | undefined;

      if (!sub?.planId && role !== 'admin') {
        console.error(
          '[auth/callback] New OAuth user — no subscription, redirecting to select-plan'
        );
        return NextResponse.redirect(`${origin}/login/select-plan`);
      }
    } catch (err) {
      // On admin client error, continue to dashboard — layout will re-check
      console.error('[auth/callback] Subscription check error (non-fatal):', err);
    }
  }

  return NextResponse.redirect(`${origin}${safeNext}`);
}
