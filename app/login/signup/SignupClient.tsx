'use client';

/**
 * Signup page — app/login/signup/page.tsx
 *
 * Allows new users to create a BizzAssist account with email + password.
 * User selects a plan from the active plans fetched via /api/plans.
 * Must accept terms of service before creating account.
 * On success, Supabase sends a verification email and the user is redirected
 * to /login/verify-email to wait for confirmation.
 */

import { useState, useEffect, FormEvent } from 'react';
import Link from 'next/link';
import {
  Eye,
  EyeOff,
  ArrowLeft,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Clock,
  Zap,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { signUp } from '@/app/auth/actions';
import { formatTokens } from '@/app/lib/subscriptions';
import { createClient } from '@/lib/supabase/client';

/** Plan data from /api/plans */
interface PlanOption {
  id: string;
  nameDa: string;
  nameEn: string;
  descDa: string;
  descEn: string;
  priceDkk: number;
  aiTokensPerMonth: number;
  aiEnabled: boolean;
  requiresApproval: boolean;
  freeTrialDays: number;
  color: string;
}

const errorMessages: Record<string, { da: string; en: string }> = {
  email_rate_limit: {
    da: 'For mange forsøg. Vent en time og prøv igen.',
    en: 'Too many attempts. Please wait an hour and try again.',
  },
  email_already_registered: {
    da: 'Denne e-mail er allerede registreret.',
    en: 'This email is already registered.',
  },
  password_too_weak: {
    da: 'Adgangskoden skal være mindst 8 tegn.',
    en: 'Password must be at least 8 characters.',
  },
  passwords_mismatch: {
    da: 'Adgangskoderne er ikke ens.',
    en: 'Passwords do not match.',
  },
  terms_not_accepted: {
    da: 'Du skal acceptere betingelserne for at oprette en konto.',
    en: 'You must accept the terms to create an account.',
  },
  unexpected_error: {
    da: 'Noget gik galt. Prøv igen.',
    en: 'Something went wrong. Please try again.',
  },
};

/** Password strength indicator colours */
function passwordStrength(pw: string): { score: number; label: { da: string; en: string } } {
  if (pw.length === 0) return { score: 0, label: { da: '', en: '' } };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const labels = [
    { da: 'Meget svag', en: 'Very weak' },
    { da: 'Svag', en: 'Weak' },
    { da: 'Middel', en: 'Fair' },
    { da: 'Stærk', en: 'Strong' },
    { da: 'Meget stærk', en: 'Very strong' },
  ];
  return { score, label: labels[Math.min(score, 4)] };
}

const strengthColours = [
  'bg-red-500',
  'bg-orange-500',
  'bg-yellow-500',
  'bg-emerald-400',
  'bg-emerald-500',
];

/** Color map for plan borders */
const PLAN_COLORS: Record<string, { border: string; ring: string }> = {
  amber: { border: 'border-amber-500/40', ring: 'ring-amber-500/30' },
  slate: { border: 'border-slate-400/40', ring: 'ring-slate-400/30' },
  blue: { border: 'border-blue-500/40', ring: 'ring-blue-500/30' },
  purple: { border: 'border-purple-500/40', ring: 'ring-purple-500/30' },
};

/**
 * Signup page component.
 *
 * @returns The signup form with plan selection, terms acceptance, and password strength feedback.
 */
export default function SignupClient() {
  const { lang, setLang } = useLanguage();
  const da = lang === 'da';
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<string>('demo');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<'google' | 'azure' | 'linkedin_oidc' | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  /** Available plans from API */
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);

  const strength = passwordStrength(password);

  /** Fetch active plans on mount */
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/plans');
        if (res.ok) {
          const data: PlanOption[] = await res.json();
          setPlans(data);
          if (data.length > 0 && !data.find((p) => p.id === selectedPlan)) {
            setSelectedPlan(data[0].id);
          }
        }
      } catch {
        /* fallback: plans stays empty, user gets default */
      } finally {
        setPlansLoading(false);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const currentPlan = plans.find((p) => p.id === selectedPlan);

  /**
   * Initiates an OAuth sign-up/sign-in flow via Supabase.
   * Redirects the browser to the provider's consent screen.
   *
   * @param provider - The OAuth provider ('google', 'azure', or 'linkedin_oidc')
   */
  const handleOAuth = async (provider: 'google' | 'azure' | 'linkedin_oidc') => {
    setOauthLoading(provider);
    setError(null);
    const supabase = createClient();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!acceptedTerms) {
      setError('terms_not_accepted');
      return;
    }
    if (password.length < 8) {
      setError('password_too_weak');
      return;
    }
    if (password !== confirmPassword) {
      setError('passwords_mismatch');
      return;
    }
    setLoading(true);
    try {
      const result = await signUp(email, password, fullName, selectedPlan);
      if (result?.error) setError(result.error);
    } catch {
      // signUp redirects on success
    } finally {
      setLoading(false);
    }
  };

  const errorMsg = error
    ? (errorMessages[error]?.[lang] ?? errorMessages.unexpected_error[lang])
    : null;

  return (
    <div className="min-h-screen bg-[#0f172a] flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-5">
        <Link
          href="/login"
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
              className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${lang === l ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-lg">
          <div className="bg-[#1e293b] border border-white/10 rounded-2xl p-8 shadow-2xl">
            <div className="text-center mb-8">
              <h1 className="text-2xl font-bold text-white mb-2">
                {da ? 'Opret din konto' : 'Create your account'}
              </h1>
              <p className="text-slate-400 text-sm">
                {da ? 'Kom i gang med BizzAssist' : 'Get started with BizzAssist'}
              </p>
            </div>

            {/* OAuth buttons */}
            <div className="space-y-3 mb-6">
              {/* Microsoft / Office 365 */}
              <button
                type="button"
                onClick={() => handleOAuth('azure')}
                disabled={!!oauthLoading || loading}
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
                {da ? 'Fortsæt med Microsoft' : 'Continue with Microsoft'}
              </button>

              {/* Google */}
              <button
                type="button"
                onClick={() => handleOAuth('google')}
                disabled={!!oauthLoading || loading}
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
                {da ? 'Fortsæt med Google' : 'Continue with Google'}
              </button>
            </div>

            {/* Divider */}
            <div className="flex items-center gap-4 mb-6">
              <div className="flex-1 border-t border-white/10" />
              <span className="text-slate-500 text-xs">
                {da ? 'eller opret med e-mail' : 'or sign up with email'}
              </span>
              <div className="flex-1 border-t border-white/10" />
            </div>

            {errorMsg && (
              <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-4">
                <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
                <p className="text-red-300 text-sm">
                  {errorMsg}
                  {error === 'email_already_registered' && (
                    <>
                      {' '}
                      <Link
                        href="/login"
                        className="text-blue-400 hover:text-blue-300 underline font-medium"
                      >
                        {da ? 'Log ind i stedet' : 'Log in instead'}
                      </Link>
                    </>
                  )}
                </p>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Full name */}
              <div>
                <label className="block text-slate-300 text-sm font-medium mb-2">
                  {da ? 'Fulde navn' : 'Full name'}
                </label>
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder={da ? 'Jakob Juul Rasmussen' : 'Jane Smith'}
                  autoComplete="name"
                  required
                  disabled={loading}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors text-sm disabled:opacity-50"
                />
              </div>

              {/* Email */}
              <div>
                <label className="block text-slate-300 text-sm font-medium mb-2">
                  {da ? 'E-mail' : 'Email'}
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={da ? 'navn@virksomhed.dk' : 'name@company.com'}
                  autoComplete="email"
                  required
                  disabled={loading}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors text-sm disabled:opacity-50"
                />
              </div>

              {/* Password + strength */}
              <div>
                <label className="block text-slate-300 text-sm font-medium mb-2">
                  {da ? 'Adgangskode' : 'Password'}
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    disabled={loading}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 pr-12 text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors text-sm disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                {/* Strength meter */}
                {password.length > 0 && (
                  <div className="mt-2 space-y-1">
                    <div className="flex gap-1">
                      {[0, 1, 2, 3, 4].map((i) => (
                        <div
                          key={i}
                          className={`h-1 flex-1 rounded-full transition-colors ${i < strength.score ? strengthColours[strength.score - 1] : 'bg-white/10'}`}
                        />
                      ))}
                    </div>
                    <p className="text-xs text-slate-500">{strength.label[lang]}</p>
                  </div>
                )}
              </div>

              {/* Confirm password */}
              <div>
                <label className="block text-slate-300 text-sm font-medium mb-2">
                  {da ? 'Bekræft adgangskode' : 'Confirm password'}
                </label>
                <div className="relative">
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    disabled={loading}
                    className={`w-full bg-white/5 border rounded-xl px-4 py-3 pr-12 text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors text-sm disabled:opacity-50 ${
                      confirmPassword.length > 0 && password !== confirmPassword
                        ? 'border-red-500/50'
                        : 'border-white/10'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                {confirmPassword.length > 0 && password !== confirmPassword && (
                  <p className="text-red-400 text-xs mt-1">
                    {da ? 'Adgangskoderne er ikke ens' : 'Passwords do not match'}
                  </p>
                )}
              </div>

              {/* ─── Plan selection ─── */}
              <div>
                <label className="block text-slate-300 text-sm font-medium mb-2">
                  {da ? 'Vælg abonnement' : 'Choose plan'}
                </label>

                {plansLoading ? (
                  <div className="flex items-center justify-center gap-2 text-slate-500 py-4">
                    <Loader2 size={14} className="animate-spin" />
                    <span className="text-xs">{da ? 'Henter planer…' : 'Loading plans…'}</span>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {plans.map((plan) => {
                      const isSelected = selectedPlan === plan.id;
                      const colors = PLAN_COLORS[plan.color] || PLAN_COLORS.slate;

                      return (
                        <button
                          key={plan.id}
                          type="button"
                          onClick={() => setSelectedPlan(plan.id)}
                          className={`text-left rounded-xl p-3 border-2 transition-all ${
                            isSelected
                              ? `${colors.border} bg-white/5 ring-2 ${colors.ring}`
                              : 'border-white/10 hover:border-white/20 bg-white/[0.02]'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-white text-sm font-semibold">
                              {da ? plan.nameDa : plan.nameEn}
                            </span>
                            {isSelected && <CheckCircle2 size={14} className="text-blue-400" />}
                          </div>
                          <p className="text-white text-base font-bold">
                            {plan.priceDkk === 0 ? (da ? 'Gratis' : 'Free') : `${plan.priceDkk} kr`}
                            {plan.priceDkk > 0 && (
                              <span className="text-slate-500 text-xs font-normal">/md</span>
                            )}
                          </p>
                          {plan.aiEnabled && (
                            <div className="flex items-center gap-1 mt-1">
                              <Zap size={10} className="text-blue-400" />
                              <span className="text-slate-400 text-[11px]">
                                AI — {formatTokens(plan.aiTokensPerMonth)} tokens
                              </span>
                            </div>
                          )}
                          {plan.freeTrialDays > 0 && (
                            <span className="text-emerald-400 text-[11px]">
                              {plan.freeTrialDays} {da ? 'dage gratis' : 'days free'}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Info box for selected plan */}
                {currentPlan?.requiresApproval && (
                  <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-3 mt-2 space-y-1">
                    <div className="flex items-center gap-2">
                      <Clock size={14} className="text-amber-400 shrink-0" />
                      <span className="text-amber-300 text-xs font-medium">
                        {da ? 'Denne plan kræver godkendelse' : 'This plan requires approval'}
                      </span>
                    </div>
                    <p className="text-slate-500 text-xs leading-relaxed pl-[22px]">
                      {da
                        ? 'Din konto oprettes med det samme, men du får begrænset adgang indtil en administrator godkender din anmodning.'
                        : 'Your account is created immediately, but you will have limited access until an administrator approves your request.'}
                    </p>
                  </div>
                )}
              </div>

              {/* ─── Terms acceptance ─── */}
              <label className="flex items-start gap-3 cursor-pointer group">
                <div className="relative mt-0.5 shrink-0">
                  <input
                    type="checkbox"
                    checked={acceptedTerms}
                    onChange={(e) => {
                      setAcceptedTerms(e.target.checked);
                      if (error === 'terms_not_accepted') setError(null);
                    }}
                    className="sr-only peer"
                  />
                  <div
                    className={`w-5 h-5 rounded-md border-2 bg-white/5 peer-checked:bg-blue-600 peer-checked:border-blue-600 transition-colors flex items-center justify-center ${
                      error === 'terms_not_accepted' ? 'border-red-500' : 'border-slate-600'
                    }`}
                  >
                    {acceptedTerms && (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        fill="none"
                        stroke="white"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M2.5 6l2.5 2.5 4.5-5" />
                      </svg>
                    )}
                  </div>
                </div>
                <div>
                  <span className="text-slate-300 text-sm">
                    {da ? (
                      <>
                        Jeg accepterer{' '}
                        <Link
                          href="/terms"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300 underline"
                        >
                          betingelserne for brug
                        </Link>{' '}
                        af BizzAssist
                      </>
                    ) : (
                      <>
                        I accept the{' '}
                        <Link
                          href="/terms"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300 underline"
                        >
                          terms of service
                        </Link>{' '}
                        for BizzAssist
                      </>
                    )}
                  </span>
                </div>
              </label>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white font-semibold py-3.5 rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                {loading && <Loader2 size={16} className="animate-spin" />}
                {da ? 'Opret konto' : 'Create account'}
              </button>
            </form>

            <p className="text-center text-slate-500 text-sm mt-6">
              {da ? 'Har du allerede en konto?' : 'Already have an account?'}{' '}
              <Link
                href="/login"
                className="text-blue-400 hover:text-blue-300 font-medium transition-colors"
              >
                {da ? 'Log ind' : 'Log in'}
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
