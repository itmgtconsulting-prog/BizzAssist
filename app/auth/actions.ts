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
import { checkLoginThrottle, recordFailedLogin, clearLoginThrottle } from '@/app/lib/loginThrottle';
import { logger } from '@/app/lib/logger';
import { provisionTenantForUser } from '@/lib/tenant/provisionTenant';

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
   * The verified TOTP factor ID — passed to /login/mfa via URL so the client
   * doesn't have to call listFactors() again (avoids session-not-ready race).
   */
  mfaFactorId?: string;
  /**
   * Set when error === 'oauth_user_no_password'.
   * Contains the OAuth provider the user registered with (e.g. 'azure', 'google', 'linkedin_oidc').
   */
  oauthProvider?: string;
  /**
   * Set when error === 'account_locked'.
   * Seconds remaining until the account auto-unlocks.
   */
  lockedForSeconds?: number;
  /**
   * Set when error === 'invalid_credentials' and only one attempt remains.
   * True triggers a "1 forsøg tilbage" warning in the UI.
   */
  loginWarning?: boolean;
  /** Remaining attempts before lockout (for UI warning display) */
  attemptsLeft?: number;
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
  // ── Brute-force protection: check lockout BEFORE authenticating ──────────
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk';
  const throttle = await checkLoginThrottle(email);
  if (throttle.locked) {
    return { error: 'account_locked', lockedForSeconds: throttle.lockedForSeconds };
  }

  const supabase = await createClient();

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // Record failed attempt and check if lockout should be triggered
    const afterFail = await recordFailedLogin(email, appBaseUrl);
    if (afterFail.locked) {
      return { error: 'account_locked', lockedForSeconds: afterFail.lockedForSeconds };
    }

    logger.error('[signIn] Supabase auth error:', error.message, '| status:', error.status);
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
      return {
        error: 'invalid_credentials',
        attemptsLeft: afterFail.attemptsLeft,
        loginWarning: afterFail.warningShown,
      };
    }
    if (error.message.toLowerCase().includes('email not confirmed')) {
      return { error: 'email_not_confirmed' };
    }
    return {
      error: 'unexpected_error',
      attemptsLeft: afterFail.attemptsLeft,
      loginWarning: afterFail.warningShown,
    };
  }

  // ── BIZZ-1875: Single session per device ─────────────────────────────────
  // Register session in user_sessions table + terminate other device sessions.
  // Also clean up auth.sessions from other IPs as a secondary safety net.
  try {
    const { headers: getHeaders } = await import('next/headers');
    const hdrs = await getHeaders();
    const currentIp =
      hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? hdrs.get('x-real-ip') ?? 'unknown';
    const userAgent = hdrs.get('user-agent') ?? 'unknown';
    const admin = createAdminClient();
    const {
      data: { user: sessionUser },
    } = await supabase.auth.getUser();
    if (sessionUser) {
      // Register in user_sessions + revoke other devices
      const { registerSession } = await import('@/app/lib/auth/sessionTracker');
      const { revokedCount } = await registerSession(sessionUser.id, null, userAgent, currentIp);
      if (revokedCount > 0) {
        logger.log(`[signIn] BIZZ-1875: Revoked ${revokedCount} sessions from other devices`);
      }

      // Secondary: also clean auth.sessions from other IPs
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: authSessions } = await (admin as any)
        .schema('auth')
        .from('sessions')
        .select('id, ip')
        .eq('user_id', sessionUser.id);
      if (authSessions && authSessions.length > 1) {
        const otherSessions = (authSessions as Array<{ id: string; ip: string }>).filter(
          (s) => s.ip !== currentIp
        );
        for (const s of otherSessions) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (admin as any).schema('auth').from('sessions').delete().eq('id', s.id);
        }
      }
    }
  } catch {
    // Non-fatal — login skal stadig virke
  }

  // Check if MFA challenge is required.
  // OAuth users (azure, google, linkedin_oidc) already authenticate with 2FA at
  // their identity provider — do NOT add a second TOTP step for them.
  // Email/password users are RECOMMENDED to use TOTP 2FA but it is not mandatory.
  // Users who have already enrolled TOTP MUST complete the challenge on every login.
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
    // Use the admin client to look up enrolled TOTP factors for this user.
    // The user client's mfa.listFactors() relies on the fresh aal1 session —
    // but mfa_allow_low_aal: false (enforced in prod) can cause that call to
    // silently return empty data for MFA-enrolled users, causing the challenge
    // to be skipped. The admin client bypasses AAL restrictions entirely.
    let verifiedTotp: { id: string } | undefined;
    try {
      const adminForMfa = createAdminClient();
      const { data: userWithFactors } = await adminForMfa.auth.admin.getUserById(userForMfa!.id);
      const factors =
        (
          userWithFactors?.user as {
            factors?: { id: string; factor_type: string; status: string }[];
          }
        )?.factors ?? [];
      verifiedTotp = factors.find((f) => f.factor_type === 'totp' && f.status === 'verified');
    } catch {
      // Non-fatal — fall back to user-client call if admin lookup fails
      const { data: factorsData } = await supabase.auth.mfa.listFactors();
      verifiedTotp = factorsData?.totp?.find((f) => f.status === 'verified');
    }

    if (verifiedTotp) {
      // Factor is enrolled — a fresh signInWithPassword session is always aal1,
      // so we always require the TOTP challenge. No need to call
      // getAuthenticatorAssuranceLevel() since the session was just created.
      return { error: null, mfaRequired: true, mfaEnrolled: true, mfaFactorId: verifiedTotp.id };
    }
    // No TOTP enrolled — MFA is optional, proceed to dashboard.
    // The dashboard shows a recommendation banner to encourage enrollment.
  }

  // ── Subscription gate — check FRESH data from Supabase Auth database ────
  // Uses admin client to bypass JWT caching. This is the only reliable way
  // to ensure admin-set subscriptions are immediately visible.
  const {
    data: { user: authedUser },
  } = await supabase.auth.getUser();
  logger.log('[signIn] authedUser resolved:', authedUser ? 'yes' : 'no');

  if (authedUser) {
    try {
      const admin = createAdminClient();
      const { data: freshUser, error: adminErr } = await admin.auth.admin.getUserById(
        authedUser.id
      );
      logger.log('[signIn] admin getUserById error:', adminErr?.message ?? 'none');
      logger.log('[signIn] freshUser app_metadata:', JSON.stringify(freshUser?.user?.app_metadata));

      const appMeta = freshUser?.user?.app_metadata ?? {};
      const role = appMeta.role as string | undefined;
      const sub = appMeta.subscription as { status?: string; planId?: string } | undefined;

      logger.log('[signIn] role:', role, 'subscription:', JSON.stringify(sub));

      // Admin users bypass subscription checks entirely
      if (role === 'admin') {
        logger.log('[signIn] → ALLOWED: admin role bypass');
      } else {
        if (!sub || !sub.planId) {
          logger.log('[signIn] → BLOCKED: no_subscription');
          await supabase.auth.signOut();
          return { error: 'no_subscription' };
        }
        if (sub.status === 'pending') {
          logger.log('[signIn] → BLOCKED: subscription_pending');
          await supabase.auth.signOut();
          return { error: 'subscription_pending' };
        }
        if (sub.status === 'cancelled') {
          logger.log('[signIn] → BLOCKED: subscription_cancelled');
          await supabase.auth.signOut();
          return { error: 'subscription_cancelled' };
        }
        logger.log('[signIn] → ALLOWED: subscription active');
      }
    } catch (err) {
      // If admin client fails, let user through — dashboard will re-check
      logger.error('[signIn] Subscription check error:', err);
    }
  }

  // Clear failed-login counter on successful authentication
  await clearLoginThrottle(email);

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
/**
 * Validerer at email-domænet har MX-records (kan modtage mail).
 * Fanger fake signups med ugyldige domæner.
 *
 * @param email - Email-adresse
 * @returns true hvis domænet har MX-records, false ellers
 */
async function validateEmailMx(email: string): Promise<boolean> {
  const domain = email.split('@')[1];
  if (!domain) return false;
  try {
    const dns = await import('dns');
    return new Promise((resolve) => {
      dns.resolveMx(domain, (err, addresses) => {
        if (err || !addresses || addresses.length === 0) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  } catch {
    // DNS lookup fejl — lad signup fortsætte (fail-open)
    return true;
  }
}

export async function signUp(
  email: string,
  password: string,
  fullName: string,
  planId: string = 'demo'
): Promise<AuthResult> {
  // BIZZ-1172: MX-validering — bloker fake domæner
  const hasMx = await validateEmailMx(email);
  if (!hasMx) {
    return { error: 'invalid_email_domain' };
  }

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

  // Provision tenant schema for the new user (fire-and-forget, non-fatal)
  if (signupData?.user?.id && signupData?.user?.email) {
    provisionTenantForUser(signupData.user.id, signupData.user.email).catch((err) => {
      logger.error('[signUp] Tenant provisioning failed:', err);
    });
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
      logger.error('[signUp] Failed to set subscription in app_metadata:', err);
    }
  }

  // Send notification email to support (fire-and-forget)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  fetch(`${appUrl}/api/notify-signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullName, email, planId, status }),
  }).catch((err) => {
    logger.error('[signUp] Failed to send notification:', err);
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

    // Read fresh app_metadata via admin client — client-side getUser() does not
    // expose app_metadata, so we must go through the admin API to check whether
    // the user was already approved before reaching this step (e.g. admin
    // pre-approved the account before onboarding completed).
    const { data: freshUserData } = await admin.auth.admin.getUserById(user.id);
    const existingSub =
      (freshUserData?.user?.app_metadata?.subscription as {
        status?: string;
        approvedAt?: string | null;
        createdAt?: string;
        tokensUsedThisMonth?: number;
        periodStart?: string;
        bonusTokens?: number;
      }) ?? {};

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

    // If the user was already approved by an admin (status === 'active'), preserve
    // that approval — do NOT reset to 'pending'. This prevents the double-approval
    // loop where an admin pre-approves before onboarding and selectFreePlan then
    // overwrites the active subscription with a fresh pending one.
    const alreadyApproved = existingSub.status === 'active';
    const status = alreadyApproved ? 'active' : requiresApproval ? 'pending' : 'active';
    const approvedAt = alreadyApproved
      ? (existingSub.approvedAt ?? now)
      : requiresApproval
        ? null
        : now;

    await admin.auth.admin.updateUserById(user.id, {
      app_metadata: {
        subscription: {
          planId,
          status,
          // Preserve createdAt from the original subscription if it exists
          createdAt: existingSub.createdAt ?? now,
          approvedAt,
          tokensUsedThisMonth: existingSub.tokensUsedThisMonth ?? 0,
          periodStart: existingSub.periodStart ?? now,
          bonusTokens: existingSub.bonusTokens ?? 0,
        },
      },
    });

    logger.log(
      '[selectFreePlan] Set plan',
      planId,
      'status',
      status,
      'alreadyApproved',
      alreadyApproved,
      'for user',
      '[user]'
    );
    return { error: null };
  } catch (err) {
    logger.error('[selectFreePlan] Error:', err);
    return { error: 'unexpected_error' };
  }
}

/**
 * Start a free trial for a paid plan — creates subscription with isPaid=false.
 * Access is granted via isSubscriptionFunctional() while within freeTrialDays.
 * When the trial expires, the user must pay to continue using the platform.
 *
 * @param planId - Plan identifier (must have freeTrialDays > 0 in plan_configs)
 * @returns AuthResult with error message, or { error: null } on success
 */
export async function startTrialPlan(planId: string): Promise<AuthResult> {
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

    // Verify the plan exists and has a trial period
    const { data: planRow } = (await admin
      .from('plan_configs')
      .select('free_trial_days')
      .eq('plan_id', planId)
      .single()) as { data: { free_trial_days: number } | null; error: unknown };

    if (!planRow || !planRow.free_trial_days || planRow.free_trial_days <= 0) {
      return { error: 'no_trial_available' };
    }

    // BIZZ-2028: Check if this email previously had a trial (deleted + re-registered)
    if (user.email) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: prevAccount } = (await (admin as any)
        .from('deleted_accounts')
        .select('id')
        .eq('email', user.email.toLowerCase())
        .eq('had_trial', true)
        .limit(1)) as { data: { id: string }[] | null };

      if (prevAccount && prevAccount.length > 0) {
        logger.warn('[startTrialPlan] Trial abuse blocked for re-registered email:', '[email]');
        return { error: 'trial_already_used' };
      }
    }

    // Check for existing subscription — don't overwrite an active paid sub
    const { data: freshUserData } = await admin.auth.admin.getUserById(user.id);
    const existingSub =
      (freshUserData?.user?.app_metadata?.subscription as {
        status?: string;
        isPaid?: boolean;
      }) ?? {};

    if (existingSub.status === 'active' && existingSub.isPaid) {
      return { error: 'already_paid' };
    }

    await admin.auth.admin.updateUserById(user.id, {
      app_metadata: {
        subscription: {
          planId,
          status: 'active',
          createdAt: now,
          approvedAt: now,
          tokensUsedThisMonth: 0,
          periodStart: now,
          accumulatedTokens: 0,
          topUpTokens: 0,
          bonusTokens: 0,
          isPaid: false,
        },
      },
    });

    // Provision tenant if user doesn't have one yet (new OAuth users)
    try {
      await provisionTenantForUser(user.id, user.email ?? '');
    } catch (provErr) {
      // Non-fatal — user can still use the platform, just without chat persistence
      logger.warn('[startTrialPlan] Tenant provision failed:', provErr);
    }

    logger.log('[startTrialPlan] Started trial for plan', planId, 'for user [user]');
    return { error: null };
  } catch (err) {
    logger.error('[startTrialPlan] Error:', err);
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
