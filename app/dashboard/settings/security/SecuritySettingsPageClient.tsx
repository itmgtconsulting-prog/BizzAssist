'use client';

/**
 * Security settings page — app/dashboard/settings/security/page.tsx
 *
 * Allows users to enroll in, verify, and remove TOTP-based 2FA.
 *
 * Flow:
 *   Idle        → user clicks "Enable 2FA" → Enrolling
 *   Enrolling   → supabase.auth.mfa.enroll() returns QR code + secret
 *               → user scans QR and enters 6-digit code
 *               → supabase.auth.mfa.challengeAndVerify() → Enrolled
 *   Enrolled    → user sees status badge + "Remove 2FA" button
 *               → supabase.auth.mfa.unenroll() → Idle
 *
 * The QR code is rendered from the SVG string returned by Supabase's
 * enroll() call — no third-party QR libraries needed.
 *
 * ISO 27001 A.9: Multi-factor authentication reduces account takeover risk.
 */

import { useState, useEffect, FormEvent } from 'react';
import {
  ShieldCheck,
  ShieldOff,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Copy,
  Smartphone,
  Info,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { createClient } from '@/lib/supabase/client';
import { logger } from '@/app/lib/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** State machine for the enrollment UI */
type MfaState = 'loading' | 'idle' | 'enrolling' | 'enrolled';

/** Data returned by supabase.auth.mfa.enroll for a TOTP factor */
interface EnrollData {
  factorId: string;
  /** SVG string of the QR code */
  qrCode: string;
  /** Base-32 secret for manual entry into authenticator apps */
  secret: string;
  /** Full otpauth:// URI */
  uri: string;
}

// ---------------------------------------------------------------------------
// Translations
// ---------------------------------------------------------------------------

const t = {
  title: { da: 'To-faktor-godkendelse (2FA)', en: 'Two-factor authentication (2FA)' },
  subtitle: {
    da: 'Øg sikkerheden på din konto ved at tilføje TOTP-godkendelse.',
    en: 'Increase your account security by adding TOTP authentication.',
  },
  statusEnabled: { da: '2FA er aktiv', en: '2FA is enabled' },
  statusDisabled: { da: '2FA er ikke aktiveret', en: '2FA is not enabled' },
  enableBtn: { da: 'Aktiver 2FA', en: 'Enable 2FA' },
  removeBtn: { da: 'Fjern 2FA', en: 'Remove 2FA' },
  enrollTitle: { da: 'Scan QR-koden', en: 'Scan the QR code' },
  enrollDesc: {
    da: 'Åbn din authenticator-app (fx Google Authenticator eller Authy) og scan koden nedenfor.',
    en: 'Open your authenticator app (e.g. Google Authenticator or Authy) and scan the code below.',
  },
  manualEntry: {
    da: 'Kan du ikke scanne? Indtast koden manuelt:',
    en: "Can't scan? Enter the key manually:",
  },
  copied: { da: 'Kopieret!', en: 'Copied!' },
  verifyLabel: { da: 'Bekræftelseskode', en: 'Verification code' },
  verifyPlaceholder: { da: '000000', en: '000000' },
  verifyBtn: { da: 'Bekræft og aktivér', en: 'Confirm and enable' },
  cancelBtn: { da: 'Annullér', en: 'Cancel' },
  successTitle: { da: '2FA er nu aktiveret', en: '2FA is now enabled' },
  successDesc: {
    da: 'Din konto er beskyttet med to-faktor-godkendelse.',
    en: 'Your account is protected with two-factor authentication.',
  },
  removeConfirmTitle: { da: 'Fjern 2FA?', en: 'Remove 2FA?' },
  removeConfirmDesc: {
    da: 'Din konto vil kun være beskyttet af din adgangskode. Er du sikker?',
    en: 'Your account will only be protected by your password. Are you sure?',
  },
  removeConfirmBtn: { da: 'Ja, fjern 2FA', en: 'Yes, remove 2FA' },
  removeConfirmCancel: { da: 'Behold 2FA', en: 'Keep 2FA' },
  err_enroll_failed: {
    da: 'Kunne ikke starte registrering. Prøv igen.',
    en: 'Could not start enrollment. Please try again.',
  },
  err_invalid_code: { da: 'Forkert kode. Prøv igen.', en: 'Incorrect code. Please try again.' },
  err_unenroll_failed: {
    da: 'Kunne ikke fjerne 2FA. Prøv igen.',
    en: 'Could not remove 2FA. Please try again.',
  },
  err_unexpected: {
    da: 'Noget gik galt. Prøv igen.',
    en: 'Something went wrong. Please try again.',
  },
  oauthTitle: {
    da: '2FA håndteres af din identity provider',
    en: '2FA is managed by your identity provider',
  },
  oauthDesc: {
    da: 'Du logger ind via {provider}. Din identity provider kræver allerede 2FA — BizzAssist tilføjer ikke et ekstra trin.',
    en: 'You sign in via {provider}. Your identity provider already requires 2FA — BizzAssist does not add an additional step.',
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Security settings page — manage TOTP 2FA enrollment.
 *
 * @returns The 2FA management UI embedded in the dashboard settings layout.
 */
export default function SecuritySettingsPageClient() {
  const { lang } = useLanguage();
  const [mfaState, setMfaState] = useState<MfaState>('loading');
  const [enrollData, setEnrollData] = useState<EnrollData | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [enrolledFactorId, setEnrolledFactorId] = useState<string | null>(null);
  /** Detected OAuth provider name if user signed in via SSO (azure/google/linkedin_oidc) */
  const [oauthProvider, setOauthProvider] = useState<string | null>(null);

  // Fetch current MFA status and detect OAuth-only users on mount.
  // OAuth users (azure, google, linkedin_oidc) already have 2FA at their IDP
  // — we skip TOTP enrollment for them entirely.
  useEffect(() => {
    (async () => {
      const supabase = createClient();

      // Detect OAuth-only login
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const providers = (user?.app_metadata?.providers as string[] | undefined) ?? [];
      const oauthProviders = ['azure', 'google', 'linkedin_oidc'];
      const detectedOAuth = providers.find((p) => oauthProviders.includes(p));
      if (detectedOAuth && !providers.includes('email')) {
        const providerLabel =
          detectedOAuth === 'azure'
            ? 'Microsoft'
            : detectedOAuth === 'google'
              ? 'Google'
              : 'LinkedIn';
        setOauthProvider(providerLabel);
        setMfaState('idle');
        return;
      }

      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      if (listError) {
        setMfaState('idle');
        return;
      }
      const verified = data?.totp?.find((f) => f.status === 'verified');
      if (verified) {
        setEnrolledFactorId(verified.id);
        setMfaState('enrolled');
      } else {
        setMfaState('idle');
      }
    })();
  }, []);

  // ── Start enrollment ────────────────────────────────────────────────────────

  /**
   * Initiates TOTP enrollment — runs a server-side cleanup of unverified factors
   * first, then fetches a fresh QR code and secret from Supabase.
   *
   * The cleanup uses /api/auth/mfa/cleanup (service_role) instead of client-side
   * unenroll() because Supabase JS v2.99+ will reject a new enroll() call when
   * an unverified factor already exists, and client-side unenroll() silently
   * fails when the session AAL level is inconsistent after a previous removal.
   */
  const handleStartEnroll = async () => {
    setError(null);
    setLoading(true);
    try {
      // Server-side cleanup: remove any stale unverified factors via service_role.
      // This is more reliable than client-side unenroll() which can fail silently
      // when the session is in an inconsistent AAL state.
      await fetch('/api/auth/mfa/cleanup', { method: 'POST' }).catch(() => {
        // Non-fatal — proceed even if cleanup fails; enroll() may still work
        // if there are no leftover factors.
      });

      const supabase = createClient();
      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        issuer: 'BizzAssist',
      });
      if (enrollError || !data) {
        logger.error('[mfa] enroll() failed:', enrollError?.code, enrollError?.message);
        setError('err_enroll_failed');
        return;
      }
      setEnrollData({
        factorId: data.id,
        qrCode: data.totp.qr_code,
        secret: data.totp.secret,
        uri: data.totp.uri,
      });
      setCode('');
      setMfaState('enrolling');
    } catch {
      setError('err_unexpected');
    } finally {
      setLoading(false);
    }
  };

  // ── Verify enrollment code ─────────────────────────────────────────────────

  /**
   * Verifies the TOTP code to complete enrollment.
   * On success transitions to the 'enrolled' state.
   *
   * Distinguishes between "wrong code" (mfa_code_invalid) and other errors
   * (e.g. expired session, factor not found) so the user gets actionable feedback.
   *
   * @param e - Form submit event
   */
  const handleVerify = async (e: FormEvent) => {
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
        // mfa_code_invalid / mfa_totp_code_invalid → wrong code entered
        // anything else (e.g. no_session, factor_not_found) → unexpected error
        const isWrongCode =
          verifyError.code === 'mfa_totp_code_invalid' ||
          verifyError.code === 'mfa_code_invalid' ||
          verifyError.message?.toLowerCase().includes('invalid');
        setError(isWrongCode ? 'err_invalid_code' : 'err_unexpected');
        return;
      }
      setEnrolledFactorId(enrollData.factorId);
      setEnrollData(null);
      setMfaState('enrolled');
    } catch {
      setError('err_unexpected');
    } finally {
      setLoading(false);
    }
  };

  // ── Cancel enrollment ──────────────────────────────────────────────────────

  /**
   * Cancels an in-progress enrollment by unenrolling the unverified factor
   * and returning to the idle state.
   */
  const handleCancelEnroll = async () => {
    if (enrollData) {
      const supabase = createClient();
      // Best-effort cleanup of the unverified factor — ignore errors
      await supabase.auth.mfa.unenroll({ factorId: enrollData.factorId }).catch(() => {});
    }
    setEnrollData(null);
    setCode('');
    setError(null);
    setMfaState('idle');
  };

  // ── Remove 2FA ─────────────────────────────────────────────────────────────

  /**
   * Unenrolls the verified TOTP factor, disabling 2FA for the account.
   *
   * After unenrolling, the session is refreshed so Supabase issues a new token
   * at AAL1. Without this refresh the old AAL2 token is cached locally, and any
   * subsequent enroll + challengeAndVerify() call will fail with a session-state
   * mismatch even though the code is correct.
   */
  const handleRemove = async () => {
    if (!enrolledFactorId) return;
    setError(null);
    setLoading(true);
    try {
      const supabase = createClient();
      const { error: unenrollError } = await supabase.auth.mfa.unenroll({
        factorId: enrolledFactorId,
      });
      if (unenrollError) {
        setError('err_unenroll_failed');
        return;
      }
      // Refresh session so the client gets a new AAL1 token now that the
      // verified TOTP factor is gone. Ignore errors — worst case the old token
      // is still valid and the user can re-enroll on the next page load.
      await supabase.auth.refreshSession().catch(() => {});
      setEnrolledFactorId(null);
      setConfirmRemove(false);
      setMfaState('idle');
    } catch {
      setError('err_unexpected');
    } finally {
      setLoading(false);
    }
  };

  // ── Copy secret to clipboard ───────────────────────────────────────────────

  /**
   * Copies the TOTP secret to the clipboard and shows a brief confirmation.
   */
  const handleCopySecret = async () => {
    if (!enrollData?.secret) return;
    await navigator.clipboard.writeText(enrollData.secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const errorMsg = error
    ? ((t[error as keyof typeof t]?.[lang] as string | undefined) ?? t.err_unexpected[lang])
    : null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex-1 overflow-y-auto bg-[#0f172a] px-4 py-10 sm:px-8">
      <div className="max-w-xl mx-auto space-y-6">
        {/* Page heading */}
        <div>
          <h1 className="text-2xl font-bold text-white">{t.title[lang]}</h1>
          <p className="text-slate-400 text-sm mt-1">{t.subtitle[lang]}</p>
        </div>

        {/* Error banner */}
        {errorMsg && (
          <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3">
            <AlertCircle size={16} className="text-red-400 shrink-0" />
            <p className="text-red-300 text-sm">{errorMsg}</p>
          </div>
        )}

        {/* ── OAuth info banner — shown instead of TOTP UI for SSO users ──── */}
        {oauthProvider && (
          <div className="bg-[#1e293b] border border-blue-500/30 rounded-2xl p-6 flex items-start gap-4">
            <div className="w-10 h-10 bg-blue-500/10 rounded-full flex items-center justify-center shrink-0">
              <Info size={20} className="text-blue-400" />
            </div>
            <div>
              <p className="text-white font-medium">{t.oauthTitle[lang]}</p>
              <p className="text-slate-400 text-sm mt-1">
                {t.oauthDesc[lang].replace('{provider}', oauthProvider)}
              </p>
            </div>
          </div>
        )}

        {/* ── TOTP UI — only shown for email/password users ─────────────────── */}
        {/* ── Loading ────────────────────────────────────────────────────────── */}
        {!oauthProvider && mfaState === 'loading' && (
          <div className="flex justify-center py-12">
            <Loader2 size={28} className="animate-spin text-blue-400" />
          </div>
        )}

        {/* ── Idle — not enrolled ────────────────────────────────────────────── */}
        {!oauthProvider && mfaState === 'idle' && (
          <div className="bg-[#1e293b] border border-white/10 rounded-2xl p-6 flex items-start gap-4">
            <div className="w-10 h-10 bg-slate-700 rounded-full flex items-center justify-center shrink-0">
              <ShieldOff size={20} className="text-slate-400" />
            </div>
            <div className="flex-1">
              <p className="text-white font-medium">{t.statusDisabled[lang]}</p>
              <p className="text-slate-400 text-sm mt-1">{t.subtitle[lang]}</p>
            </div>
            <button
              onClick={handleStartEnroll}
              disabled={loading}
              className="shrink-0 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors flex items-center gap-2"
            >
              {loading && <Loader2 size={14} className="animate-spin" />}
              {t.enableBtn[lang]}
            </button>
          </div>
        )}

        {/* ── Enrolling — QR code + verification ────────────────────────────── */}
        {!oauthProvider && mfaState === 'enrolling' && enrollData && (
          <div className="bg-[#1e293b] border border-white/10 rounded-2xl p-6 space-y-6">
            {/* Step header */}
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-500/10 rounded-full flex items-center justify-center shrink-0">
                <Smartphone size={20} className="text-blue-400" />
              </div>
              <div>
                <p className="text-white font-medium">{t.enrollTitle[lang]}</p>
                <p className="text-slate-400 text-sm">{t.enrollDesc[lang]}</p>
              </div>
            </div>

            {/* QR code — SVG from Supabase enroll response */}
            <div className="flex justify-center">
              <div
                className="bg-white p-3 rounded-xl inline-block"
                /* SVG QR code returned by Supabase — no external scripts, purely geometric paths */
                dangerouslySetInnerHTML={{ __html: enrollData.qrCode }}
              />
            </div>

            {/* Manual secret */}
            <div className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-2">
              <p className="text-slate-400 text-xs">{t.manualEntry[lang]}</p>
              <div className="flex items-center gap-2">
                <code className="text-white text-sm font-mono tracking-widest break-all flex-1">
                  {enrollData.secret}
                </code>
                <button
                  onClick={handleCopySecret}
                  className="text-slate-500 hover:text-slate-300 transition-colors shrink-0"
                  title="Copy"
                >
                  {copied ? (
                    <CheckCircle2 size={16} className="text-emerald-400" />
                  ) : (
                    <Copy size={16} />
                  )}
                </button>
              </div>
              {copied && <p className="text-emerald-400 text-xs">{t.copied[lang]}</p>}
            </div>

            {/* Verification form */}
            <form onSubmit={handleVerify} className="space-y-4">
              <div>
                <label className="block text-slate-300 text-sm font-medium mb-2">
                  {t.verifyLabel[lang]}
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder={t.verifyPlaceholder[lang]}
                  autoComplete="one-time-code"
                  required
                  disabled={loading}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-4 text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors text-2xl text-center tracking-[0.5em] font-mono"
                />
              </div>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={handleCancelEnroll}
                  disabled={loading}
                  className="flex-1 bg-white/5 hover:bg-white/10 disabled:opacity-50 text-slate-300 font-semibold py-3 rounded-xl transition-colors text-sm"
                >
                  {t.cancelBtn[lang]}
                </button>
                <button
                  type="submit"
                  disabled={loading || code.length < 6}
                  className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2 text-sm"
                >
                  {loading && <Loader2 size={14} className="animate-spin" />}
                  {t.verifyBtn[lang]}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* ── Enrolled ──────────────────────────────────────────────────────── */}
        {!oauthProvider && mfaState === 'enrolled' && !confirmRemove && (
          <div className="bg-[#1e293b] border border-white/10 rounded-2xl p-6 flex items-start gap-4">
            <div className="w-10 h-10 bg-emerald-500/10 rounded-full flex items-center justify-center shrink-0">
              <ShieldCheck size={20} className="text-emerald-400" />
            </div>
            <div className="flex-1">
              <p className="text-white font-medium">{t.statusEnabled[lang]}</p>
              <p className="text-slate-400 text-sm mt-1">{t.successDesc[lang]}</p>
            </div>
            <button
              onClick={() => {
                setError(null);
                setConfirmRemove(true);
              }}
              className="shrink-0 bg-white/5 hover:bg-red-500/10 border border-white/10 hover:border-red-500/30 text-slate-300 hover:text-red-300 text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
            >
              {t.removeBtn[lang]}
            </button>
          </div>
        )}

        {/* ── Confirm remove ────────────────────────────────────────────────── */}
        {!oauthProvider && mfaState === 'enrolled' && confirmRemove && (
          <div className="bg-[#1e293b] border border-red-500/30 rounded-2xl p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-red-500/10 rounded-full flex items-center justify-center shrink-0">
                <AlertCircle size={20} className="text-red-400" />
              </div>
              <div>
                <p className="text-white font-medium">{t.removeConfirmTitle[lang]}</p>
                <p className="text-slate-400 text-sm">{t.removeConfirmDesc[lang]}</p>
              </div>
            </div>

            {errorMsg && (
              <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
                <AlertCircle size={14} className="text-red-400 shrink-0" />
                <p className="text-red-300 text-xs">{errorMsg}</p>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setConfirmRemove(false);
                  setError(null);
                }}
                disabled={loading}
                className="flex-1 bg-white/5 hover:bg-white/10 disabled:opacity-50 text-slate-300 font-semibold py-3 rounded-xl transition-colors text-sm"
              >
                {t.removeConfirmCancel[lang]}
              </button>
              <button
                onClick={handleRemove}
                disabled={loading}
                className="flex-1 bg-red-600 hover:bg-red-500 disabled:bg-red-600/50 text-white font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2 text-sm"
              >
                {loading && <Loader2 size={14} className="animate-spin" />}
                {t.removeConfirmBtn[lang]}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
