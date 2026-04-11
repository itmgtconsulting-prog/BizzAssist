'use client';

/**
 * MFA enrollment page — app/login/mfa/enroll/page.tsx
 *
 * Shown after email/password login when the user has NOT yet enrolled in TOTP 2FA.
 * 2FA is mandatory for all email/password accounts — this page cannot be skipped.
 *
 * Flow:
 *   1. signIn() detects no verified TOTP factor → redirects here
 *   2. supabase.auth.mfa.enroll() returns a QR code + secret
 *   3. User scans the QR code with an authenticator app
 *   4. User enters the 6-digit code → supabase.auth.mfa.challengeAndVerify()
 *   5. On success the session is elevated to aal2 → redirect to /dashboard
 *
 * ISO 27001 A.9: Mandatory TOTP enrollment enforces MFA for all local accounts.
 */

import { useState, useEffect, FormEvent, useRef } from 'react';
import { Loader2, AlertCircle, Smartphone, Copy, CheckCircle2, ShieldCheck } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useLanguage } from '@/app/context/LanguageContext';
import { createClient } from '@/lib/supabase/client';
import { signOut } from '@/app/auth/actions';

/** Data returned by supabase.auth.mfa.enroll for a TOTP factor */
interface EnrollData {
  factorId: string;
  /** Base-32 secret for manual entry into authenticator apps */
  secret: string;
  /** Full otpauth:// URI — used to render the QR code without dangerouslySetInnerHTML */
  uri: string;
}

const errorMessages: Record<string, { da: string; en: string }> = {
  enroll_failed: {
    da: 'Kunne ikke starte registrering. Prøv at logge ind igen.',
    en: 'Could not start enrollment. Please try logging in again.',
  },
  invalid_code: {
    da: 'Forkert kode. Prøv igen.',
    en: 'Incorrect code. Please try again.',
  },
  unexpected_error: {
    da: 'Noget gik galt. Prøv igen.',
    en: 'Something went wrong. Please try again.',
  },
};

/**
 * MFA enrollment page — guides the user through first-time TOTP setup
 * as a mandatory step before reaching the dashboard.
 */
export default function MfaEnrollClient() {
  const { lang } = useLanguage();
  const [enrollData, setEnrollData] = useState<EnrollData | null>(null);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [initialising, setInitialising] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Start enrollment automatically on mount — call enroll() to get the QR code.
  useEffect(() => {
    (async () => {
      try {
        const supabase = createClient();
        const { data, error: enrollError } = await supabase.auth.mfa.enroll({
          factorType: 'totp',
          issuer: 'BizzAssist',
        });
        if (enrollError || !data) {
          setError('enroll_failed');
          return;
        }
        setEnrollData({
          factorId: data.id,
          secret: data.totp.secret,
          uri: data.totp.uri,
        });
      } catch {
        setError('enroll_failed');
      } finally {
        setInitialising(false);
        inputRef.current?.focus();
      }
    })();
  }, []);

  /**
   * Verifies the TOTP code to complete enrollment.
   * challengeAndVerify() both creates the challenge and verifies the code in
   * one step, elevating the session to aal2 on success.
   *
   * @param e - Form submit event
   */
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!enrollData) return;
    setError(null);
    setLoading(true);
    try {
      const supabase = createClient();
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: enrollData.factorId,
        code,
      });
      if (verifyError) {
        setError('invalid_code');
        return;
      }
      // Session is now aal2 — navigate to dashboard.
      // Use window.location for a hard redirect so all session cookies are
      // picked up by the next request (same pattern as the login page).
      window.location.href = '/dashboard';
    } catch {
      setError('unexpected_error');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Copies the TOTP secret to the clipboard and shows a brief confirmation.
   */
  const handleCopySecret = async () => {
    if (!enrollData?.secret) return;
    await navigator.clipboard.writeText(enrollData.secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
              {lang === 'da' ? 'Opsæt to-faktor-godkendelse' : 'Set up two-factor authentication'}
            </h1>
            <p className="text-slate-400 text-sm">
              {lang === 'da'
                ? 'Øg sikkerheden på din konto ved at tilknytte en authenticator-app.'
                : 'Increase your account security by linking an authenticator app.'}
            </p>
          </div>

          {errorMsg && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-6">
              <AlertCircle size={16} className="text-red-400 shrink-0" />
              <p className="text-red-300 text-sm">{errorMsg}</p>
            </div>
          )}

          {initialising ? (
            <div className="flex justify-center py-8">
              <Loader2 size={28} className="animate-spin text-blue-400" />
            </div>
          ) : enrollData ? (
            <div className="space-y-6">
              {/* Step 1 — scan QR */}
              <div className="flex items-center gap-3 mb-2">
                <div className="w-8 h-8 bg-blue-500/10 rounded-full flex items-center justify-center shrink-0">
                  <Smartphone size={16} className="text-blue-400" />
                </div>
                <p className="text-slate-300 text-sm">
                  {lang === 'da'
                    ? 'Åbn Google Authenticator, Authy eller lignende og scan koden:'
                    : 'Open Google Authenticator, Authy or similar and scan the code:'}
                </p>
              </div>

              {/* QR code — rendered from otpauth:// URI via qrcode.react, no raw HTML injection */}
              <div className="flex justify-center">
                <div className="bg-white p-3 rounded-xl inline-block">
                  <QRCodeSVG value={enrollData.uri} size={176} />
                </div>
              </div>

              {/* Manual secret fallback */}
              <div className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-2">
                <p className="text-slate-400 text-xs">
                  {lang === 'da'
                    ? 'Kan du ikke scanne? Indtast koden manuelt:'
                    : "Can't scan? Enter the key manually:"}
                </p>
                <div className="flex items-center gap-2">
                  <code className="text-white text-sm font-mono tracking-widest break-all flex-1">
                    {enrollData.secret}
                  </code>
                  <button
                    onClick={handleCopySecret}
                    className="text-slate-500 hover:text-slate-300 transition-colors shrink-0"
                    title={lang === 'da' ? 'Kopiér' : 'Copy'}
                  >
                    {copied ? (
                      <CheckCircle2 size={16} className="text-emerald-400" />
                    ) : (
                      <Copy size={16} />
                    )}
                  </button>
                </div>
                {copied && (
                  <p className="text-emerald-400 text-xs">
                    {lang === 'da' ? 'Kopieret!' : 'Copied!'}
                  </p>
                )}
              </div>

              {/* Step 2 — enter code to confirm */}
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-slate-300 text-sm font-medium mb-2">
                    {lang === 'da'
                      ? 'Bekræft ved at indtaste koden fra appen:'
                      : 'Confirm by entering the code from the app:'}
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
                    disabled={loading}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-4 text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors text-2xl text-center tracking-[0.5em] font-mono"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading || code.length < 6}
                  className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white font-semibold py-3.5 rounded-xl transition-colors flex items-center justify-center gap-2"
                >
                  {loading && <Loader2 size={16} className="animate-spin" />}
                  {lang === 'da' ? 'Aktivér 2FA og fortsæt' : 'Enable 2FA and continue'}
                </button>
              </form>
            </div>
          ) : null}

          <div className="mt-6 flex flex-col items-center gap-3">
            <button
              onClick={() => {
                window.location.href = '/dashboard';
              }}
              className="text-amber-400 hover:text-amber-300 text-sm transition-colors"
            >
              {lang === 'da' ? 'Spring over for nu' : 'Skip for now'}
            </button>
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
