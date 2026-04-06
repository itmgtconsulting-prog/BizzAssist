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
  /** True if a 2FA step is required before the session is fully elevated */
  mfaRequired?: boolean;
  /**
   * Only set when mfaRequired is true.
   * true  → TOTP is already enrolled, redirect to /login/mfa for the challenge.
   * false → No TOTP enrolled yet, redirect to /login/mfa/enroll to set it up first.
   */
  mfaEnrolled?: boolean;
  /**
   * Set when error === 'oauth_user_no_password'.
   * Contains the OAuth provider the user registered with (e.g. 'azure', 'google', 'linkedin_oidc').
   */
  oauthProvider?: string;
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
    console.error('[signIn] Supabase auth error:', error.message, '| status:', error.status);
    // Do not expose internal error details — map to user-safe messages
    if (error.message.toLowerCase().includes('invalid')) {
      // Check if the account was created via OAuth (no password identity).
      // listUsers is acceptable here — only runs on failed logins, small user base.
      try {
        const admin = createAdminClient();
        const { data: usersData } = await admin.auth.admin.listUsers({ perPage: 1000 });
        const matchUser = usersData?.users?.find(
          (u) => u.email?.toLowerCase() === email.toLowerCase()
        );
        if (matchUser) {
          // app_metadata.providers is reliably populated by Supabase for all auth methods.
          // identities[] is not reliably returned by listUsers, so we use providers instead.
          const providers = (matchUser.app_metadata?.providers as string[] | undefined) ?? [];
          const hasEmailProvider = providers.includes('email');
          const hasOAuthProvider = providers.some((p) => p !== 'email');
          if (!hasEmailProvider && hasOAuthProvider) {
            // Return the first OAuth provider so the UI can highlight the right button
            const oauthProvider = providers.find((p) => p !== 'email') ?? 'oauth';
            return { error: 'oauth_user_no_password', oauthProvider };
          }
        }
      } catch {
        // Non-fatal — fall through to generic invalid_credentials
      }
      return { error: 'invalid_credentials' };
    }
    if (error.message.toLowerCase().includes('email not confirmed')) {
      return { error: 'email_not_confirmed' };
    }
    return { error: 'unexpected_error' };
  }

  // Check if MFA is required.
  // OAuth users (azure, google, linkedin_oidc) already authenticate with 2FA at
  // their identity provider — do NOT add a second TOTP step for them.
  // Email/password users MUST use TOTP 2FA — enforce both enrollment and challenge.
  //
  // We return mfaRequired here rather than calling redirect() directly because
  // redirect() in server actions can fail to propagate session cookies to the
  // browser in some Next.js versions (see note near the bottom of this function).
  const {
    data: { user: userForMfa },
  } = await supabase.auth.getUser();
  const providers = (userForMfa?.app_metadata?.providers as string[] | undefined) ?? [];
  const isOAuthOnly =
    providers.length > 0 &&
    !providers.includes('email') &&
    providers.some((p) => ['azure', 'google', 'linkedin_oidc'].includes(p));

  // On localhost (development) skip MFA entirely so developers can log in without a TOTP app.
  const isLocalDev = process.env.NODE_ENV === 'development';

  if (!isOAuthOnly && !isLocalDev) {
    // List enrolled TOTP factors to decide which MFA step is needed.
    const { data: factorsData } = await supabase.auth.mfa.listFactors();
    const verifiedTotp = factorsData?.totp?.find((f) => f.status === 'verified');

    if (!verifiedTotp) {
      // No TOTP factor enrolled yet — send user to the enrollment page.
      // The enrollment page runs challengeAndVerify which elevates the session
      // to aal2 on success, so no separate challenge step is needed afterwards.
      return { error: null, mfaRequired: true, mfaEnrolled: false };
    }

    // Factor is enrolled — check if the session still needs to be elevated.
    const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalData?.nextLevel === 'aal2' && aalData.nextLevel !== aalData.currentLevel) {
      // Session is aal1 but aal2 is required — redirect to TOTP challenge.
      return { error: null, mfaRequired: true, mfaEnrolled: true };
    }
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

      const appMeta = freshUser?.user?.app_metadata ?? {};
      const role = appMeta.role as string | undefined;
      const sub = appMeta.subscription as { status?: string; planId?: string } | undefined;

      console.log('[signIn] role:', role, 'subscription:', JSON.stringify(sub));

      // Admin users bypass subscription checks entirely
      if (role === 'admin') {
        console.log('[signIn] → ALLOWED: admin role bypass');
      } else {
        if (!sub || !sub.planId) {
          console.log('[signIn] → BLOCKED: no_subscription');
          await supabase.auth.signOut();
          return { error: 'no_subscription' };
        }
        // During beta: pending demo users are allowed in (auto-approval)
        if (sub.status === 'pending') {
          console.log('[signIn] → ALLOWED: pending subscription (beta auto-approval)');
        }
        if (sub.status === 'cancelled') {
          console.log('[signIn] → BLOCKED: subscription_cancelled');
          await supabase.auth.signOut();
          return { error: 'subscription_cancelled' };
        }
        console.log('[signIn] → ALLOWED: subscription active');
      }
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
      emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?type=signup`,
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

  // Look up requires_approval from DB for all plans (including demo)
  let requiresApproval = false;
  if (signupData?.user?.id) {
    try {
      const admin = createAdminClient();

      const { data: planRow } = (await admin
        .from('plan_configs')
        .select('requires_approval')
        .eq('plan_id', planId)
        .limit(1)
        .single()) as { data: { requires_approval: boolean } | null; error: unknown };
      if (planRow) {
        requiresApproval = planRow.requires_approval;
      }
    } catch {
      // Fallback: no approval required if DB lookup fails
    }
  }

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
      emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?type=signup`,
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
// Select free / demo plan for an already-authenticated OAuth user
// ---------------------------------------------------------------------------

/**
 * Sets a free or demo plan subscription in app_metadata for the currently
 * authenticated user. Called from the /login/select-plan page for users who
 * signed up via OAuth and were redirected before choosing a plan.
 *
 * @param planId - The plan ID to assign (e.g. 'demo')
 * @returns AuthResult with error message, or { error: null } on success
 */
export async function selectFreePlan(planId: string): Promise<AuthResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: 'not_authenticated' };
  }

  const now = new Date().toISOString();

  try {
    const admin = createAdminClient();

    // Look up requires_approval from DB for all plans (including demo)
    let requiresApproval = false;
    const { data: planRow } = (await admin
      .from('plan_configs')
      .select('requires_approval')
      .eq('plan_id', planId)
      .limit(1)
      .single()) as { data: { requires_approval: boolean } | null; error: unknown };
    if (planRow) {
      requiresApproval = planRow.requires_approval;
    }

    const status = requiresApproval ? 'pending' : 'active';

    await admin.auth.admin.updateUserById(user.id, {
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

    console.log('[selectFreePlan] Set plan', planId, 'status', status, 'for user', user.id);
    return { error: null };
  } catch (err) {
    console.error('[selectFreePlan] Error:', err);
    return { error: 'unexpected_error' };
  }
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
