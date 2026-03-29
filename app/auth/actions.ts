'use server';

/**
 * Supabase Auth server actions — app/auth/actions.ts
 *
 * All authentication operations are handled server-side.
 * Credentials never touch client-side JavaScript.
 *
 * ISO 27001 A.9 (Access Control):
 *   - Passwords handled only in server actions (never logged, never returned)
 *   - Rate limiting delegated to middleware.ts
 *   - Session tokens written to HttpOnly cookies by Supabase SSR
 *
 * @module app/auth/actions
 */

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthResult {
  error: string | null;
  /** True if 2FA challenge is required before the session is fully elevated */
  mfaRequired?: boolean;
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

/**
 * Signs the user in with email and password.
 * On success, redirects to /dashboard (or redirectTo if provided).
 * If MFA is enrolled, redirects to /login/mfa instead.
 *
 * @param email      - User's email address
 * @param password   - User's password
 * @param redirectTo - Optional path to redirect to after login (must be relative)
 * @returns AuthResult with error message, or redirects on success
 */
export async function signIn(
  email: string,
  password: string,
  _redirectTo = '/dashboard'
): Promise<AuthResult> {
  const supabase = await createClient();

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // Do not expose internal error details — map to user-safe messages
    if (error.message.toLowerCase().includes('invalid')) {
      return { error: 'invalid_credentials' };
    }
    if (error.message.toLowerCase().includes('email not confirmed')) {
      return { error: 'email_not_confirmed' };
    }
    return { error: 'unexpected_error' };
  }

  // Check if MFA challenge is required
  const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalData?.nextLevel === 'aal2' && aalData.nextLevel !== aalData.currentLevel) {
    redirect('/login/mfa');
  }

  // ── Subscription gate — check FRESH data from Supabase Auth database ────
  // Uses admin client to bypass JWT caching. This is the only reliable way
  // to ensure admin-set subscriptions are immediately visible.
  const {
    data: { user: authedUser },
  } = await supabase.auth.getUser();
  console.log('[signIn] authedUser:', authedUser?.email, 'id:', authedUser?.id);

  if (authedUser) {
    try {
      const admin = createAdminClient();
      const { data: freshUser, error: adminErr } = await admin.auth.admin.getUserById(
        authedUser.id
      );
      console.log('[signIn] admin getUserById error:', adminErr?.message ?? 'none');
      console.log(
        '[signIn] freshUser app_metadata:',
        JSON.stringify(freshUser?.user?.app_metadata)
      );

      const sub = freshUser?.user?.app_metadata?.subscription as
        | { status?: string; planId?: string }
        | undefined;

      console.log('[signIn] subscription:', JSON.stringify(sub));

      if (!sub || !sub.planId) {
        console.log('[signIn] → BLOCKED: no_subscription');
        await supabase.auth.signOut();
        redirect('/login?error=no_subscription');
      }
      if (sub.status === 'pending') {
        console.log('[signIn] → BLOCKED: subscription_pending');
        await supabase.auth.signOut();
        redirect('/login?error=subscription_pending');
      }
      if (sub.status === 'cancelled') {
        console.log('[signIn] → BLOCKED: subscription_cancelled');
        await supabase.auth.signOut();
        redirect('/login?error=subscription_cancelled');
      }
      console.log('[signIn] → ALLOWED: subscription active');
    } catch (err) {
      // If admin client fails, let user through — dashboard will re-check
      console.error('[signIn] Subscription check error:', err);
    }
  }

  // Return success — let the client handle the redirect.
  // This ensures cookies are properly set before navigation.
  // Using redirect() in a server action can cause cookies not to be
  // propagated to the browser in some Next.js versions.
  return { error: null };
}

// ---------------------------------------------------------------------------
// Sign up
// ---------------------------------------------------------------------------

/**
 * Creates a new user account with email, password, and full name.
 * Supabase sends a verification email automatically.
 * On success, redirects to /login/verify-email.
 *
 * @param email    - User's email address
 * @param password - User's chosen password (min 8 chars enforced by Supabase)
 * @param fullName - User's display name (stored in user_metadata)
 * @returns AuthResult with error message, or redirects on success
 */
export async function signUp(
  email: string,
  password: string,
  fullName: string,
  planId: string = 'demo'
): Promise<AuthResult> {
  const supabase = await createClient();

  const { data: signupData, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
      emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
    },
  });

  if (error) {
    const msg = (error.message ?? '').toLowerCase();
    if (
      msg.includes('already registered') ||
      msg.includes('already in use') ||
      msg.includes('already been registered') ||
      msg.includes('user already') ||
      error.status === 422
    ) {
      return { error: 'email_already_registered' };
    }
    if (
      msg.includes('rate limit') ||
      msg.includes('over_email_send_rate_limit') ||
      error.status === 429
    ) {
      return { error: 'email_rate_limit' };
    }
    if (msg.includes('password')) {
      return { error: 'password_too_weak' };
    }
    return { error: 'unexpected_error' };
  }

  // Set subscription in app_metadata via admin client (so it's in the database)
  const now = new Date().toISOString();
  const requiresApproval = planId === 'demo';
  const status = requiresApproval ? 'pending' : 'active';

  if (signupData?.user?.id) {
    try {
      const admin = createAdminClient();
      await admin.auth.admin.updateUserById(signupData.user.id, {
        app_metadata: {
          subscription: {
            planId,
            status,
            createdAt: now,
            approvedAt: requiresApproval ? null : now,
            tokensUsedThisMonth: 0,
            periodStart: now,
            bonusTokens: 0,
          },
        },
      });
    } catch (err) {
      console.error('[signUp] Failed to set subscription in app_metadata:', err);
    }
  }

  // Send notification email to support (fire-and-forget)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  fetch(`${appUrl}/api/notify-signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullName, email, planId, status }),
  }).catch((err) => {
    console.error('[signUp] Failed to send notification:', err);
  });

  redirect(`/login/verify-email?email=${encodeURIComponent(email)}`);
}

// ---------------------------------------------------------------------------
// Resend verification email
// ---------------------------------------------------------------------------

/**
 * Resends the email verification link to the given address.
 * Always returns success to prevent email enumeration.
 *
 * @param email - The email address to resend the verification link to
 * @returns AuthResult — always { error: null }
 */
export async function resendVerificationEmail(email: string): Promise<AuthResult> {
  const supabase = await createClient();

  // Ignore errors — prevents enumeration of whether an unconfirmed account exists
  await supabase.auth.resend({
    type: 'signup',
    email,
    options: {
      emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
    },
  });

  return { error: null };
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

/**
 * Signs the current user out and clears their session cookie.
 * Redirects to /login after sign-out.
 */
export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}

// ---------------------------------------------------------------------------
// Password reset — request
// ---------------------------------------------------------------------------

/**
 * Sends a password reset email to the given address.
 * Always returns success (to prevent email enumeration attacks).
 *
 * @param email - The email address to send the reset link to
 * @returns AuthResult — always { error: null } to prevent enumeration
 */
export async function requestPasswordReset(email: string): Promise<AuthResult> {
  const supabase = await createClient();

  // We intentionally ignore errors here to prevent email enumeration.
  // ISO 27001 A.9: do not reveal whether an email exists in the system.
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/login/update-password`,
  });

  return { error: null };
}

// ---------------------------------------------------------------------------
// Password reset — update
// ---------------------------------------------------------------------------

/**
 * Updates the user's password after they click the reset link.
 * The user must have a valid recovery session (from the reset email link).
 *
 * @param newPassword - The new password to set
 * @returns AuthResult with error, or redirects to /dashboard on success
 */
export async function updatePassword(newPassword: string): Promise<AuthResult> {
  const supabase = await createClient();

  const { error } = await supabase.auth.updateUser({ password: newPassword });

  if (error) {
    if (error.message.toLowerCase().includes('same password')) {
      return { error: 'same_password' };
    }
    return { error: 'unexpected_error' };
  }

  redirect('/dashboard');
}

// ---------------------------------------------------------------------------
// MFA — verify TOTP challenge
// ---------------------------------------------------------------------------

/**
 * Verifies a TOTP code to elevate the session from aal1 to aal2.
 * Called from the /login/mfa challenge page.
 *
 * @param factorId - The MFA factor ID (from getAuthenticatorAssuranceLevel)
 * @param code     - The 6-digit TOTP code from the authenticator app
 * @returns AuthResult with error, or redirects to /dashboard on success
 */
export async function verifyMfa(factorId: string, code: string): Promise<AuthResult> {
  const supabase = await createClient();

  // Challenge first, then verify — required by Supabase MFA flow
  const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
    factorId,
  });

  if (challengeError) {
    return { error: 'mfa_challenge_failed' };
  }

  const { error: verifyError } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challengeData.id,
    code,
  });

  if (verifyError) {
    return { error: 'mfa_invalid_code' };
  }

  redirect('/dashboard');
}
