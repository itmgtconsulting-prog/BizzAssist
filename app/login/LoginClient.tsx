'use client';

/**
 * Login page — app/login/page.tsx
 *
 * Handles email/password sign-in via Supabase Auth server action.
 * Google and Microsoft OAuth buttons link to Supabase OAuth flow
 * (wired in BIZZ-11 / BIZZ-12).
 *
 * On successful login:
 *   - No MFA enrolled → redirects to /dashboard (or ?redirectTo param)
 *   - MFA enrolled    → redirects to /login/mfa (handled in signIn action)
 *
 * Error codes returned by signIn():
 *   invalid_credentials   — wrong email or password
 *   email_not_confirmed   — user hasn't clicked the verification email
 *   unexpected_error      — catch-all
 */

import { useState, useEffect, FormEvent, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Eye, EyeOff, ArrowLeft, Loader2, AlertCircle, Info } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';
import { signIn, resendVerificationEmail } from '@/app/auth/actions';
import { createClient } from '@/lib/supabase/client';

/** Maps server-returned error codes to bilingual user-facing messages */
const errorMessages: Record<string, { da: string; en: string }> = {
  account_locked: {
    da: 'Kontoen er midlertidigt låst. Vi har sendt dig et link til at nulstille din adgangskode.',
    en: 'Account temporarily locked. We have sent you a password reset link.',
  },
  invalid_credentials: {
    da: 'Forkert e-mail eller adgangskode.',
    en: 'Incorrect email or password.',
  },
  oauth_user_no_password: {
    da: 'Denne konto er oprettet via Microsoft eller Google — ikke med e-mail og adgangskode. Brug den knap du oprettede kontoen med.',
    en: 'This account was created via Microsoft or Google — not with email and password. Use the button you signed up with.',
  },
  email_not_confirmed: {
    da: 'Bekræft din e-mail først. Tjek din indbakke.',
    en: 'Please confirm your email first. Check your inbox.',
  },
  subscription_pending: {
    da: 'Din adgang afventer godkendelse fra en administrator. Du modtager en e-mail, når din konto er aktiveret.',
    en: 'Your access is pending approval from an administrator. You will receive an email when your account is activated.',
  },
  subscription_cancelled: {
    da: 'Dit abonnement er blevet annulleret. Kontakt administrator for at genaktivere.',
    en: 'Your subscription has been cancelled. Contact your administrator to reactivate.',
  },
  unexpected_error: {
    da: 'Noget gik galt. Prøv igen.',
    en: 'Something went wrong. Please try again.',
  },
};

/**
 * Inner login form — reads redirectTo from search params.
 * Must be wrapped in Suspense because useSearchParams() requires it in Next.js App Router.
 */
function LoginForm() {
  const { lang, setLang } = useLanguage();
  const t = translations[lang].login;
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get('redirectTo') ?? '/dashboard';
  // DEBUG: capture details param from auth callback for display
  const debugDetails = searchParams.get('details');

  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<'google' | 'azure' | null>(null);
  /** Error from form submission or from URL query param (e.g. subscription_pending) */
  const [error, setError] = useState<string | null>(searchParams.get('error'));
  /** OAuth provider returned when error === 'oauth_user_no_password' (e.g. 'azure', 'google') */
  const [detectedProvider, setDetectedProvider] = useState<string | null>(null);
  /** Seconds remaining until account auto-unlocks (0 = not locked) */
  const [lockCountdown, setLockCountdown] = useState(0);
  /** Warning: one attempt left before lockout */
  const [loginWarning, setLoginWarning] = useState<number | null>(null);
  /** True while resend verification email request is in-flight */
  const [resendLoading, setResendLoading] = useState(false);
  /** True after a successful resend — shows confirmation message */
  const [resendSent, setResendSent] = useState(false);
  /** Seconds remaining in resend cooldown (Supabase rate-limits to 1 email/60 s) */
  const [resendCooldown, setResendCooldown] = useState(0);

  /** Clear the error query param from URL after displaying it, so refreshing doesn't show stale errors */
  useEffect(() => {
    if (searchParams.get('error')) {
      // Delay cleanup so the error message is visible first
      const timer = setTimeout(() => window.history.replaceState({}, '', '/login'), 2000);
      return () => clearTimeout(timer);
    }
  }, [searchParams]);

  /**
   * Countdown timer — ticks down lockCountdown every second.
   * When it reaches 0 the form is re-enabled automatically.
   */
  useEffect(() => {
    if (lockCountdown <= 0) return;
    const interval = setInterval(() => {
      setLockCountdown((prev) => {
        if (prev <= 1) {
          setError(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [lockCountdown]);

  /**
   * Countdown timer for resend email cooldown (60 s Supabase rate limit).
   * When it reaches 0 the resend button is re-enabled.
   */
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const interval = setInterval(() => {
      setResendCooldown((prev) => Math.max(prev - 1, 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [resendCooldown]);

  /**
   * Initiates an OAuth sign-in flow via Supabase.
   * Redirects the browser to the provider's consent screen.
   *
   * @param provider - The OAuth provider to use ('google')
   */
  const handleOAuth = async (provider: 'google' | 'azure') => {
    setOauthLoading(provider);
    setError(null);
    setDetectedProvider(null);
    const supabase = createClient();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(redirectTo)}`,
        // Force account picker so users can switch accounts after logout
        queryParams: { prompt: 'select_account' },
        // Request email + profile scopes explicitly so Azure/Microsoft returns the user's email
        ...(provider === 'azure' && { scopes: 'email openid profile User.Read' }),
      },
    });
    if (oauthError) {
      setError('unexpected_error');
      setOauthLoading(null);
    }
    // On success the browser is redirected — no further action needed
  };

  /**
   * Handles form submission — calls the signIn server action.
   * On success the action redirects; on failure we show the error.
   *
   * @param e - Form submit event
   */
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await signIn(email, password, redirectTo);
      if (result?.error) {
        setError(result.error);
        if (result.oauthProvider) {
          setDetectedProvider(result.oauthProvider);
        }
        if (result.error === 'account_locked' && result.lockedForSeconds) {
          setLockCountdown(result.lockedForSeconds);
        }
        if (result.loginWarning && result.attemptsLeft !== undefined) {
          setLoginWarning(result.attemptsLeft);
        } else {
          setLoginWarning(null);
        }
      } else if (result?.mfaRequired) {
        // MFA challenge needed — user has enrolled TOTP and must verify it.
        // Pass factorId via URL so MfaClient doesn't need a second listFactors() call
        // (avoids a race where client-side session cookies aren't fully set yet).
        const mfaUrl = result.mfaFactorId
          ? `/login/mfa?factorId=${encodeURIComponent(result.mfaFactorId)}`
          : '/login/mfa';
        window.location.href = mfaUrl;
        return; // Keep loading state while redirecting
      } else {
        // Login succeeded — redirect client-side so cookies are properly set.
        // Hard redirect (window.location) ensures proxy.ts runs and session is valid.
        window.location.href = redirectTo;
        return; // Keep loading state while redirecting
      }
    } catch {
      // Unexpected error
      setError('unexpected_error');
    }
    setLoading(false);
  };

  /**
   * Resends the email verification link to the address currently in the email field.
   * Starts a 60-second cooldown after sending to match Supabase's rate limit.
   * Resets the resendSent state if the user changes the email field after a send.
   */
  const handleResendVerification = async () => {
    if (!email || resendLoading || resendCooldown > 0) return;
    setResendLoading(true);
    await resendVerificationEmail(email);
    setResendLoading(false);
    setResendSent(true);
    setResendCooldown(60); // Supabase rate-limits email sends to 1 per 60 s
  };

  const errorMsg = error
    ? (errorMessages[error]?.[lang] ?? errorMessages.unexpected_error[lang])
    : null;

  const isLocked = lockCountdown > 0;

  /** Format seconds as mm:ss for countdown display */
  const formatCountdown = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  /** Maps Supabase provider ID to a human-readable name */
  const providerDisplayName: Record<string, string> = {
    azure: 'Microsoft',
    google: 'Google',
  };
  const detectedProviderName = detectedProvider
    ? (providerDisplayName[detectedProvider] ?? detectedProvider)
    : null;

  /**
   * True when we should highlight the OAuth buttons because the user either
   * tried email/password on an OAuth-only account or has no subscription yet.
   */
  const highlightOAuth = error === 'oauth_user_no_password' || error === 'no_subscription';

  return (
    <div className="min-h-screen bg-[#0f172a] flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-5">
        <Link
          href="/"
          className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft size={18} />
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-xs">B</span>
            </div>
            <span className="text-white font-bold text-lg">
              Bizz<span className="text-blue-400">Assist</span>
            </span>
          </div>
        </Link>
        <div className="flex items-center bg-white/10 rounded-full p-1 gap-1">
          {(['da', 'en'] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLang(l)}
              className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                lang === l ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="bg-[#1e293b] border border-white/10 rounded-2xl p-8 shadow-2xl">
            {/* Header */}
            <div className="text-center mb-8">
              <h1 className="text-2xl font-bold text-white mb-2">{t.title}</h1>
              <p className="text-slate-400 text-sm">{t.subtitle}</p>
            </div>

            {/* OAuth login hint — shown when user tried email/password on an OAuth account,
                or when they have no subscription (likely an OAuth signup without plan selection) */}
            {highlightOAuth && (
              <div className="flex items-start gap-2 bg-blue-500/10 border border-blue-500/30 rounded-xl px-4 py-3 mb-4 text-blue-300 text-sm">
                <Info size={16} className="shrink-0 mt-0.5 text-blue-400" />
                <p>
                  {detectedProviderName
                    ? lang === 'da'
                      ? `Log ind med "Fortsæt med ${detectedProviderName}" knappen nedenfor ↓`
                      : `Sign in with the "Continue with ${detectedProviderName}" button below ↓`
                    : lang === 'da'
                      ? 'Log ind med den knap du oprettede din konto med ↓'
                      : 'Sign in with the button you used to create your account ↓'}
                </p>
              </div>
            )}

            {/* OAuth buttons */}
            <div
              className={`space-y-3 mb-6${highlightOAuth ? ' ring-2 ring-blue-500/40 rounded-2xl p-3' : ''}`}
            >
              {/* Microsoft / Office 365 */}
              <button
                onClick={() => handleOAuth('azure')}
                disabled={!!oauthLoading}
                className="w-full flex items-center justify-center gap-3 bg-[#0078D4] hover:bg-[#106EBE] disabled:opacity-50 text-white font-medium py-3 px-4 rounded-xl text-sm transition-colors"
              >
                {oauthLoading === 'azure' ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <svg width="18" height="18" viewBox="0 0 23 23" fill="none">
                    <path d="M11 11H0V0h11v11z" fill="#F25022" />
                    <path d="M23 11H12V0h11v11z" fill="#7FBA00" />
                    <path d="M11 23H0V12h11v11z" fill="#00A4EF" />
                    <path d="M23 23H12V12h11v11z" fill="#FFB900" />
                  </svg>
                )}
                {lang === 'da' ? 'Fortsæt med Microsoft' : 'Continue with Microsoft'}
              </button>

              {/* Google */}
              <button
                onClick={() => handleOAuth('google')}
                disabled={!!oauthLoading}
                className="w-full flex items-center justify-center gap-3 bg-white hover:bg-gray-50 disabled:opacity-50 text-gray-700 font-medium py-3 px-4 rounded-xl text-sm transition-colors"
              >
                {oauthLoading === 'google' ? (
                  <Loader2 size={16} className="animate-spin text-gray-500" />
                ) : (
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                    <path
                      d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
                      fill="#4285F4"
                    />
                    <path
                      d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z"
                      fill="#34A853"
                    />
                    <path
                      d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
                      fill="#FBBC05"
                    />
                    <path
                      d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
                      fill="#EA4335"
                    />
                  </svg>
                )}
                {lang === 'da' ? 'Fortsæt med Google' : 'Continue with Google'}
              </button>
            </div>

            {/* Divider */}
            <div className="flex items-center gap-4 mb-6">
              <div className="flex-1 border-t border-white/10" />
              <span className="text-slate-500 text-xs">{t.or}</span>
              <div className="flex-1 border-t border-white/10" />
            </div>

            {/* Error banner — blue for OAuth guidance, amber for subscription issues, red for auth errors */}
            {errorMsg &&
              (() => {
                const isSubError =
                  error === 'subscription_pending' ||
                  error === 'no_subscription' ||
                  error === 'subscription_cancelled';
                const isOAuthGuidance = error === 'oauth_user_no_password';
                const bannerColor = isOAuthGuidance
                  ? 'bg-blue-500/10 border-blue-500/30'
                  : isSubError
                    ? 'bg-amber-500/10 border-amber-500/30'
                    : 'bg-red-500/10 border-red-500/30';
                const iconColor = isOAuthGuidance
                  ? 'text-blue-400'
                  : isSubError
                    ? 'text-amber-400'
                    : 'text-red-400';
                const textColor = isOAuthGuidance
                  ? 'text-blue-300'
                  : isSubError
                    ? 'text-amber-300'
                    : 'text-red-300';
                const IconComponent = isOAuthGuidance ? Info : AlertCircle;
                return (
                  <div
                    className={`flex items-start gap-2 ${bannerColor} border rounded-xl px-4 py-3 mb-4`}
                  >
                    <IconComponent size={16} className={`${iconColor} shrink-0 mt-0.5`} />
                    <div className={`${textColor} text-sm`}>
                      <p>{errorMsg}</p>
                      {error === 'email_not_confirmed' && (
                        <div className="mt-2">
                          {resendSent ? (
                            <div>
                              <p className="text-green-400 text-xs font-medium mb-1">
                                {lang === 'da'
                                  ? '✓ E-mail sendt! Tjek din indbakke (inkl. spam).'
                                  : '✓ Email sent! Check your inbox (incl. spam).'}
                              </p>
                              {resendCooldown > 0 ? (
                                <p className="text-slate-500 text-xs">
                                  {lang === 'da'
                                    ? `Kan gensende om ${resendCooldown} sek.`
                                    : `Can resend in ${resendCooldown} sec.`}
                                </p>
                              ) : (
                                <button
                                  type="button"
                                  onClick={handleResendVerification}
                                  disabled={resendLoading || !email}
                                  className="inline-flex items-center gap-1.5 text-xs font-medium text-red-300 hover:text-white underline underline-offset-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  {lang === 'da' ? 'Send igen' : 'Send again'}
                                </button>
                              )}
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={handleResendVerification}
                              disabled={resendLoading || !email || resendCooldown > 0}
                              className="inline-flex items-center gap-1.5 text-xs font-medium text-red-300 hover:text-white underline underline-offset-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {resendLoading && <Loader2 size={12} className="animate-spin" />}
                              {lang === 'da'
                                ? 'Gensend verifikations-e-mail'
                                : 'Resend verification email'}
                            </button>
                          )}
                        </div>
                      )}
                      {error === 'no_subscription' && (
                        <Link
                          href="/login/select-plan"
                          className="inline-flex items-center gap-1 mt-1.5 text-blue-400 hover:text-blue-300 font-medium underline underline-offset-2 transition-colors"
                        >
                          {lang === 'da' ? 'Vælg plan →' : 'Select plan →'}
                        </Link>
                      )}
                      {debugDetails && (
                        <span className="block mt-1 text-xs font-mono opacity-80">
                          DEBUG: {debugDetails}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })()}

            {/* Lockout countdown banner */}
            {isLocked && (
              <div className="flex items-center gap-3 bg-orange-500/10 border border-orange-500/30 rounded-xl px-4 py-3 mb-4">
                <AlertCircle size={16} className="text-orange-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-orange-300 text-sm font-medium">
                    {lang === 'da' ? 'Kontoen er midlertidigt låst' : 'Account temporarily locked'}
                  </p>
                  <p className="text-orange-400/70 text-xs mt-0.5">
                    {lang === 'da'
                      ? `Prøv igen om ${formatCountdown(lockCountdown)} — tjek din mail for et reset-link.`
                      : `Try again in ${formatCountdown(lockCountdown)} — check your email for a reset link.`}
                  </p>
                </div>
                <span className="text-orange-300 font-mono text-sm font-bold shrink-0">
                  {formatCountdown(lockCountdown)}
                </span>
              </div>
            )}

            {/* Warning: one attempt left */}
            {loginWarning !== null && !isLocked && (
              <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 mb-4">
                <AlertCircle size={16} className="text-amber-400 shrink-0" />
                <p className="text-amber-300 text-sm">
                  {lang === 'da'
                    ? `Advarsel: kun ${loginWarning} forsøg tilbage før kontoen låses midlertidigt.`
                    : `Warning: only ${loginWarning} attempt left before the account is temporarily locked.`}
                </p>
              </div>
            )}

            {/* Email/password form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-slate-300 text-sm font-medium mb-2">
                  {t.emailLabel}
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setResendSent(false);
                  }}
                  placeholder={t.emailPlaceholder}
                  autoComplete="email"
                  required
                  disabled={loading || isLocked}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors text-base disabled:opacity-50"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-slate-300 text-sm font-medium">{t.passwordLabel}</label>
                  <Link
                    href="/login/forgot-password"
                    className="text-blue-400 text-xs hover:text-blue-300 transition-colors"
                  >
                    {t.forgotPassword}
                  </Link>
                </div>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t.passwordPlaceholder}
                    autoComplete="current-password"
                    required
                    disabled={loading || isLocked}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 pr-12 text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors text-sm disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || isLocked}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 disabled:cursor-not-allowed text-white font-semibold py-3.5 rounded-xl transition-colors mt-2 flex items-center justify-center gap-2"
              >
                {loading && <Loader2 size={16} className="animate-spin" />}
                {isLocked
                  ? lang === 'da'
                    ? `Låst (${formatCountdown(lockCountdown)})`
                    : `Locked (${formatCountdown(lockCountdown)})`
                  : t.loginButton}
              </button>
            </form>

            {/* Sign up link */}
            <p className="text-center text-slate-500 text-sm mt-6">
              {t.noAccount}{' '}
              <Link
                href="/login/signup"
                className="text-blue-400 hover:text-blue-300 font-medium transition-colors"
              >
                {t.signUp}
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Login page — wraps LoginForm in Suspense to satisfy Next.js App Router
 * requirement for useSearchParams().
 */
export default function LoginClient() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#0f172a] flex items-center justify-center">
          <Loader2 size={28} className="animate-spin text-blue-400" />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
