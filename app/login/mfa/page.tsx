'use client';

/**
 * MFA challenge page — app/login/mfa/page.tsx
 *
 * Shown after email/password login when the user has TOTP 2FA enrolled.
 * The user enters their 6-digit authenticator code to elevate their
 * session from aal1 → aal2 and gain access to the dashboard.
 *
 * Flow:
 *   1. signIn() in auth/actions.ts detects nextLevel = aal2, redirects here
 *   2. This page calls supabase.auth.mfa.getAuthenticatorAssuranceLevel()
 *      to get the factorId, then calls verifyMfa() server action
 *   3. verifyMfa() runs mfa.challenge() + mfa.verify() server-side
 *   4. On success, redirects to /dashboard
 */

import { useState, FormEvent, useEffect, useRef } from 'react';
import { Loader2, AlertCircle, ShieldCheck } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { createClient } from '@/lib/supabase/client';
import { verifyMfa, signOut } from '@/app/auth/actions';

const errorMessages: Record<string, { da: string; en: string }> = {
  mfa_invalid_code: {
    da: 'Forkert kode. Prøv igen.',
    en: 'Incorrect code. Please try again.',
  },
  mfa_challenge_failed: {
    da: 'Kunne ikke starte MFA-udfordring. Prøv at logge ind igen.',
    en: 'Could not start MFA challenge. Please try logging in again.',
  },
  factor_not_found: {
    da: 'Ingen 2FA-faktor fundet. Prøv at logge ind igen.',
    en: 'No 2FA factor found. Please try logging in again.',
  },
  unexpected_error: {
    da: 'Noget gik galt. Prøv igen.',
    en: 'Something went wrong. Please try again.',
  },
};

/**
 * MFA challenge page — prompts for the 6-digit TOTP code.
 */
export default function MfaPage() {
  const { lang } = useLanguage();
  const [code, setCode] = useState('');
  const [factorId, setFactorId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [initialising, setInitialising] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Retrieve the enrolled TOTP factor ID via listFactors().
  // AMREntry (from getAuthenticatorAssuranceLevel) does not carry factorId,
  // so we look up the verified TOTP factor from the account's factor list instead.
  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const { data } = await supabase.auth.mfa.listFactors();
      const totpFactor = data?.totp?.find((f) => f.status === 'verified');
      if (!totpFactor) {
        setError('factor_not_found');
      } else {
        setFactorId(totpFactor.id);
      }
      setInitialising(false);
      inputRef.current?.focus();
    })();
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!factorId) return;
    setError(null);
    setLoading(true);
    try {
      const result = await verifyMfa(factorId, code);
      if (result?.error) setError(result.error);
    } catch {
      // redirect on success
    } finally {
      setLoading(false);
    }
  };

  const errorMsg = error
    ? (errorMessages[error]?.[lang] ?? errorMessages.unexpected_error[lang])
    : null;

  return (
    <div className="min-h-screen bg-[#0f172a] flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-[#1e293b] border border-white/10 rounded-2xl p-8 shadow-2xl">
          {/* Header */}
          <div className="text-center mb-8">
            <div className="w-14 h-14 bg-blue-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <ShieldCheck size={28} className="text-blue-400" />
            </div>
            <h1 className="text-2xl font-bold text-white mb-2">
              {lang === 'da' ? 'To-faktor godkendelse' : 'Two-factor authentication'}
            </h1>
            <p className="text-slate-400 text-sm">
              {lang === 'da'
                ? 'Åbn din authenticator-app og indtast den 6-cifrede kode.'
                : 'Open your authenticator app and enter the 6-digit code.'}
            </p>
          </div>

          {errorMsg && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-4">
              <AlertCircle size={16} className="text-red-400 shrink-0" />
              <p className="text-red-300 text-sm">{errorMsg}</p>
            </div>
          )}

          {initialising ? (
            <div className="flex justify-center py-6">
              <Loader2 size={24} className="animate-spin text-blue-400" />
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-slate-300 text-sm font-medium mb-2">
                  {lang === 'da' ? 'Bekræftelseskode' : 'Verification code'}
                </label>
                <input
                  ref={inputRef}
                  type="text"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  autoComplete="one-time-code"
                  required
                  disabled={loading || !!error?.includes('factor')}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-4 text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors text-2xl text-center tracking-[0.5em] font-mono"
                />
              </div>

              <button
                type="submit"
                disabled={loading || code.length < 6 || !!error?.includes('factor')}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white font-semibold py-3.5 rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                {loading && <Loader2 size={16} className="animate-spin" />}
                {lang === 'da' ? 'Bekræft' : 'Verify'}
              </button>
            </form>
          )}

          <div className="mt-6 text-center">
            <button
              onClick={async () => {
                await signOut();
              }}
              className="text-slate-500 hover:text-slate-300 text-sm transition-colors"
            >
              {lang === 'da' ? 'Brug en anden konto' : 'Use a different account'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
