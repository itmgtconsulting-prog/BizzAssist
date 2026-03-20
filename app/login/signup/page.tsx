'use client';

/**
 * Signup page — app/login/signup/page.tsx
 *
 * Allows new users to create a BizzAssist account with email + password.
 * On success, Supabase sends a verification email and the user is redirected
 * to /login/verify-email to wait for confirmation.
 */

import { useState, FormEvent } from 'react';
import Link from 'next/link';
import { Eye, EyeOff, ArrowLeft, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { signUp } from '@/app/auth/actions';

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

/**
 * Signup page component.
 *
 * @returns The signup form with real-time password strength feedback.
 */
export default function SignupPage() {
  const { lang, setLang } = useLanguage();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const strength = passwordStrength(password);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('password_too_weak');
      return;
    }
    setLoading(true);
    try {
      const result = await signUp(email, password, fullName);
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
        <div className="w-full max-w-md">
          <div className="bg-[#1e293b] border border-white/10 rounded-2xl p-8 shadow-2xl">
            <div className="text-center mb-8">
              <h1 className="text-2xl font-bold text-white mb-2">
                {lang === 'da' ? 'Opret din konto' : 'Create your account'}
              </h1>
              <p className="text-slate-400 text-sm">
                {lang === 'da'
                  ? 'Gratis i 14 dage — intet kreditkort'
                  : 'Free for 14 days — no credit card'}
              </p>
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
                        {lang === 'da' ? 'Log ind i stedet' : 'Log in instead'}
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
                  {lang === 'da' ? 'Fulde navn' : 'Full name'}
                </label>
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder={lang === 'da' ? 'Jakob Juul Rasmussen' : 'Jane Smith'}
                  autoComplete="name"
                  required
                  disabled={loading}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors text-sm disabled:opacity-50"
                />
              </div>

              {/* Email */}
              <div>
                <label className="block text-slate-300 text-sm font-medium mb-2">
                  {lang === 'da' ? 'E-mail' : 'Email'}
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={lang === 'da' ? 'navn@virksomhed.dk' : 'name@company.com'}
                  autoComplete="email"
                  required
                  disabled={loading}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors text-sm disabled:opacity-50"
                />
              </div>

              {/* Password + strength */}
              <div>
                <label className="block text-slate-300 text-sm font-medium mb-2">
                  {lang === 'da' ? 'Adgangskode' : 'Password'}
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

              {/* What you get */}
              <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 space-y-2">
                {[
                  lang === 'da' ? '14 dages gratis prøveperiode' : '14-day free trial',
                  lang === 'da' ? 'Ingen kreditkort kræves' : 'No credit card required',
                  lang === 'da' ? 'Opsig når som helst' : 'Cancel anytime',
                ].map((item) => (
                  <div key={item} className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />
                    <span className="text-slate-400 text-xs">{item}</span>
                  </div>
                ))}
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white font-semibold py-3.5 rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                {loading && <Loader2 size={16} className="animate-spin" />}
                {lang === 'da' ? 'Opret konto' : 'Create account'}
              </button>
            </form>

            <p className="text-center text-slate-500 text-sm mt-6">
              {lang === 'da' ? 'Har du allerede en konto?' : 'Already have an account?'}{' '}
              <Link
                href="/login"
                className="text-blue-400 hover:text-blue-300 font-medium transition-colors"
              >
                {lang === 'da' ? 'Log ind' : 'Log in'}
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
