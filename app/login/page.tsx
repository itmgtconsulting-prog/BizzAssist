'use client';

/**
 * Login page — app/login/page.tsx
 *
 * Handles email/password sign-in via Supabase Auth server action.
 * Google and LinkedIn OAuth buttons link to Supabase OAuth flow
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
import { Eye, EyeOff, ArrowLeft, Loader2, AlertCircle } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';
import { signIn } from '@/app/auth/actions';
import { createClient } from '@/lib/supabase/client';

/** Maps server-returned error codes to bilingual user-facing messages */
const errorMessages: Record<string, { da: string; en: string }> = {
  invalid_credentials: {
    da: 'Forkert e-mail eller adgangskode.',
    en: 'Incorrect email or password.',
  },
  email_not_confirmed: {
    da: 'Bekræft din e-mail først. Tjek din indbakke.',
    en: 'Please confirm your email first. Check your inbox.',
  },
  no_subscription: {
    da: 'Velkommen! Din konto er oprettet. Vælg en plan for at komme i gang.',
    en: 'Welcome! Your account has been created. Choose a plan to get started.',
  },
  subscription_pending: {
    da: 'Din demo-anmodning afventer godkendelse af en administrator. Du vil modtage besked, når den er behandlet.',
    en: 'Your demo request is awaiting administrator approval. You will be notified when it has been processed.',
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
  const [oauthLoading, setOauthLoading] = useState<'google' | 'azure' | 'linkedin_oidc' | null>(
    null
  );
  /** Error from form submission or from URL query param (e.g. subscription_pending) */
  const [error, setError] = useState<string | null>(searchParams.get('error'));

  /** Clear the error query param from URL after displaying it, so refreshing doesn't show stale errors */
  useEffect(() => {
    if (searchParams.get('error')) {
      // Delay cleanup so the error message is visible first
      const timer = setTimeout(() => window.history.replaceState({}, '', '/login'), 2000);
      return () => clearTimeout(timer);
    }
  }, [searchParams]);

  /**
   * Initiates an OAuth sign-in flow via Supabase.
   * Redirects the browser to the provider's consent screen.
   *
   * @param provider - The OAuth provider to use ('google')
   */
  const handleOAuth = async (provider: 'google' | 'azure' | 'linkedin_oidc') => {
    setOauthLoading(provider);
    setError(null);
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

  const errorMsg = error
    ? (errorMessages[error]?.[lang] ?? errorMessages.unexpected_error[lang])
    : null;

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

            {/* OAuth buttons */}
            <div className="space-y-3 mb-6">
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

              {/* LinkedIn */}
              <button
                onClick={() => handleOAuth('linkedin_oidc')}
                disabled={!!oauthLoading}
                className="w-full flex items-center justify-center gap-3 bg-[#0A66C2] hover:bg-[#004182] disabled:opacity-50 text-white font-medium py-3 px-4 rounded-xl text-sm transition-colors"
              >
                {oauthLoading === 'linkedin_oidc' ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                  </svg>
                )}
                {lang === 'da' ? 'Fortsæt med LinkedIn' : 'Continue with LinkedIn'}
              </button>
            </div>

            {/* Divider */}
            <div className="flex items-center gap-4 mb-6">
              <div className="flex-1 border-t border-white/10" />
              <span className="text-slate-500 text-xs">{t.or}</span>
              <div className="flex-1 border-t border-white/10" />
            </div>

            {/* Error banner — amber for subscription issues, red for auth errors */}
            {errorMsg &&
              (() => {
                const isSubError =
                  error === 'subscription_pending' ||
                  error === 'no_subscription' ||
                  error === 'subscription_cancelled';
                return (
                  <div
                    className={`flex items-start gap-2 ${isSubError ? 'bg-amber-500/10 border-amber-500/30' : 'bg-red-500/10 border-red-500/30'} border rounded-xl px-4 py-3 mb-4`}
                  >
                    <AlertCircle
                      size={16}
                      className={`${isSubError ? 'text-amber-400' : 'text-red-400'} shrink-0 mt-0.5`}
                    />
                    <div className={`${isSubError ? 'text-amber-300' : 'text-red-300'} text-sm`}>
                      <p>{errorMsg}</p>
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

            {/* Email/password form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-slate-300 text-sm font-medium mb-2">
                  {t.emailLabel}
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t.emailPlaceholder}
                  autoComplete="email"
                  required
                  disabled={loading}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors text-sm disabled:opacity-50"
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
                    disabled={loading}
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
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white font-semibold py-3.5 rounded-xl transition-colors mt-2 flex items-center justify-center gap-2"
              >
                {loading && <Loader2 size={16} className="animate-spin" />}
                {t.loginButton}
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
export default function LoginPage() {
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
