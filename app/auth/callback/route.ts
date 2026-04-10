/**
 * OAuth / email-verification callback handler — GET /auth/callback
 *
 * Supabase redirects here in three distinct flows:
 *
 *   A) PKCE code flow (OAuth + email signup with PKCE enabled):
 *      /auth/callback?code=XXX[&type=signup][&next=/path]
 *      → exchanges code for session via exchangeCodeForSession()
 *
 *   B) token_hash flow (email OTP / confirmation without PKCE verifier):
 *      /auth/callback?token_hash=XXX&type=signup
 *      → verifies token via verifyOtp()
 *
 *   C) type=signup with no code/token_hash:
 *      Account was already confirmed (auto-confirm, re-used link, or
 *      the verification completed in another tab/device).
 *      → show the verified success page.
 *
 * ISO 27001 A.9 (Access Control): all code/token exchange happens server-side —
 * session tokens are never exposed in the URL or client-side JavaScript.
 */

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { EmailOtpType } from '@supabase/supabase-js';

/**
 * Handles the Supabase auth callback — OAuth, email verification, magic link.
 *
 * @param request - Incoming GET request with query params from Supabase
 * @returns Redirect to verified page, dashboard, or error page
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);

  // DEBUG: log param keys only (values omitted to avoid leaking tokens)
  console.error('[auth/callback] Params received:', [...searchParams.keys()].join(', '));

  const code = searchParams.get('code');
  const token_hash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
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

  // ── Build Supabase client (needed for both PKCE and token_hash flows) ────
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

  // ── Flow B: token_hash (Supabase OTP / email confirmation without PKCE) ──
  // Supabase sends this when PKCE is not in use, or when the email client
  // opens the link on a different device (no code-verifier cookie available).
  if (!code && token_hash && type) {
    console.error('[auth/callback] token_hash flow, type:', type);
    const { error: otpError } = await supabase.auth.verifyOtp({ type, token_hash });

    if (type === 'signup' || type === 'email') {
      // Email confirmed — sign out so the user must log in manually.
      // verifyOtp() creates a session as a side effect; we don't want that
      // for signup verification — the user should authenticate explicitly.
      await supabase.auth.signOut();
      console.error(
        '[auth/callback] token_hash signup verified, signed out, redirecting to /login/verified'
      );
      return NextResponse.redirect(`${origin}/login/verified`);
    }

    if (type === 'recovery') {
      if (otpError) {
        return NextResponse.redirect(
          `${origin}/login?error=auth_failed&details=${encodeURIComponent(otpError.message)}`
        );
      }
      return NextResponse.redirect(`${origin}/login/reset-password`);
    }

    if (otpError) {
      console.error('[auth/callback] token_hash verifyOtp error:', otpError.message);
      return NextResponse.redirect(
        `${origin}/login?error=auth_failed&details=${encodeURIComponent(otpError.message)}`
      );
    }

    const safeNext = next.startsWith('/') ? next : '/dashboard';
    return NextResponse.redirect(`${origin}${safeNext}`);
  }

  // ── Flow C: no code, no token_hash ───────────────────────────────────────
  // If type=signup: the account was confirmed already (auto-confirm on,
  // re-used verification link, or verified in another browser tab).
  if (!code) {
    console.error('[auth/callback] No code or token_hash. type:', type);
    if (type === 'signup' || type === 'email') {
      return NextResponse.redirect(`${origin}/login/verified`);
    }
    return NextResponse.redirect(
      `${origin}/login?error=no_code&details=${encodeURIComponent('No authorization code in callback URL')}`
    );
  }

  // ── Flow A: PKCE code exchange ────────────────────────────────────────────
  console.error('[auth/callback] PKCE code exchange, code length:', code.length);
  const { data: sessionData, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error('[auth/callback] Code exchange failed:', error.message, 'status:', error.status);

    // Graceful handling for signup verification links:
    // The PKCE code verifier cookie may be missing (different device/browser,
    // expired, or already consumed). The account IS confirmed — show verified page.
    if (type === 'signup' || type === 'email') {
      console.error('[auth/callback] Signup code exchange failed — showing verified page');
      return NextResponse.redirect(`${origin}/login/verified`);
    }

    return NextResponse.redirect(
      `${origin}/login?error=auth_failed&details=${encodeURIComponent(error.message)}`
    );
  }

  console.error('[auth/callback] Code exchange succeeded, type:', type);

  // ── Email verification success ────────────────────────────────────────────
  // When the user clicks the verification link from their signup email,
  // emailRedirectTo was tagged with ?type=signup.
  // exchangeCodeForSession() verifies the email but also creates a session as
  // a side effect — sign the user out so they must log in manually afterward.
  if (type === 'signup' || type === 'email') {
    await supabase.auth.signOut();
    console.error(
      '[auth/callback] signup code exchanged, signed out, redirecting to /login/verified'
    );
    return NextResponse.redirect(`${origin}/login/verified`);
  }

  // Ensure the redirect target is relative (prevent open redirect attacks)
  const safeNext = next.startsWith('/') ? next : '/dashboard';

  // ── New OAuth user check ──────────────────────────────────────────────────
  // First-time OAuth logins bypass the normal signup form and have no plan yet.
  // Redirect them to plan selection before granting dashboard access.
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
