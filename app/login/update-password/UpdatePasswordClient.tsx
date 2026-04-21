'use client';

/**
 * Update password page — app/login/update-password/page.tsx
 *
 * Reached via the password reset link emailed by Supabase.
 * The auth/callback route exchanges the token and sets a recovery session.
 * This page then lets the user set their new password.
 */

import { useState, FormEvent } from 'react';
import Link from 'next/link';
import { Eye, EyeOff, Loader2, AlertCircle, KeyRound } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { updatePassword } from '@/app/auth/actions';

const errorMessages: Record<string, { da: string; en: string }> = {
  same_password: {
    da: 'Ny adgangskode må ikke være den samme som den gamle.',
    en: 'New password cannot be the same as the old one.',
  },
  unexpected_error: {
    da: 'Noget gik galt. Prøv at klikke på linket i e-mailen igen.',
    en: 'Something went wrong. Try clicking the link in your email again.',
  },
};

/**
 * Set new password form — displayed after arriving via reset email link.
 */
export default function UpdatePasswordClient() {
  const { lang } = useLanguage();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError('password_too_weak');
      return;
    }
    if (password !== confirm) {
      setError('passwords_no_match');
      return;
    }

    setLoading(true);
    try {
      const result = await updatePassword(password);
      if (result?.error) setError(result.error);
    } catch {
      // redirect on success
    } finally {
      setLoading(false);
    }
  };

  const localErrors: Record<string, { da: string; en: string }> = {
    ...errorMessages,
    password_too_weak: {
      da: 'Adgangskoden skal være mindst 8 tegn.',
      en: 'Password must be at least 8 characters.',
    },
    passwords_no_match: { da: 'Adgangskoderne er ikke ens.', en: 'Passwords do not match.' },
  };
  const errorMsg = error
    ? (localErrors[error]?.[lang] ?? errorMessages.unexpected_error[lang])
    : null;

  return (
    <div className="min-h-screen bg-[#0f172a] flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-[#1e293b] border border-white/10 rounded-2xl p-8 shadow-2xl">
          <div className="text-center mb-8">
            <div className="w-14 h-14 bg-blue-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <KeyRound size={28} className="text-blue-400" />
            </div>
            <h1 className="text-2xl font-bold text-white mb-2">
              {lang === 'da' ? 'Vælg ny adgangskode' : 'Set new password'}
            </h1>
            <p className="text-slate-400 text-sm">
              {lang === 'da' ? 'Mindst 8 tegn.' : 'At least 8 characters.'}
            </p>
          </div>

          {errorMsg && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-4">
              <AlertCircle size={16} className="text-red-400 shrink-0" />
              <p className="text-red-300 text-sm">{errorMsg}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-slate-300 text-sm font-medium mb-2">
                {lang === 'da' ? 'Ny adgangskode' : 'New password'}
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
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 pr-12 text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-slate-300 text-sm font-medium mb-2">
                {lang === 'da' ? 'Bekræft adgangskode' : 'Confirm password'}
              </label>
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                required
                disabled={loading}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors text-base"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white font-semibold py-3.5 rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {loading && <Loader2 size={16} className="animate-spin" />}
              {lang === 'da' ? 'Gem ny adgangskode' : 'Save new password'}
            </button>
          </form>

          <p className="text-center mt-6">
            <Link
              href="/login"
              className="text-slate-400 hover:text-white text-sm transition-colors"
            >
              {lang === 'da' ? 'Tilbage til log ind' : 'Back to log in'}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
