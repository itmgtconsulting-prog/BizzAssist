'use client';

/**
 * Email verification pending page — app/login/verify-email/page.tsx
 *
 * Shown immediately after signup. Tells the user to check their inbox
 * and click the verification link. Allows resending the email with a
 * 60-second cooldown to prevent abuse.
 *
 * The email address is passed via the `email` query parameter from signup.
 * The auth/callback route handler completes the sign-in after clicking the link.
 */

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Mail, ArrowLeft, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { resendVerificationEmail } from '@/app/auth/actions';

/** Cooldown in seconds before the user can resend again */
const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Inner component that reads the email query param and renders the resend UI.
 * Wrapped in Suspense because useSearchParams() requires it in Next.js App Router.
 */
function VerifyEmailContent() {
  const { lang } = useLanguage();
  const searchParams = useSearchParams();
  const email = searchParams.get('email') ?? '';

  const [cooldown, setCooldown] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(false);

  // Tick down the cooldown counter every second
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  /**
   * Calls the resend server action and starts the cooldown timer.
   */
  const handleResend = useCallback(async () => {
    if (!email || cooldown > 0 || loading) return;
    setLoading(true);
    setError(false);
    setSent(false);

    try {
      await resendVerificationEmail(email);
      setSent(true);
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [email, cooldown, loading]);

  return (
    <div className="bg-[#1e293b] border border-white/10 rounded-2xl p-8 shadow-2xl text-center">
      {/* Icon */}
      <div className="w-16 h-16 bg-blue-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
        <Mail size={32} className="text-blue-400" />
      </div>

      <h1 className="text-2xl font-bold text-white mb-3">
        {lang === 'da' ? 'Tjek din indbakke' : 'Check your inbox'}
      </h1>

      <p className="text-slate-400 text-sm leading-relaxed mb-2">
        {lang === 'da'
          ? 'Vi har sendt dig et bekræftelseslink.'
          : "We've sent you a confirmation link."}
      </p>
      {email && <p className="text-white text-sm font-medium mb-6">{email}</p>}

      <div className="bg-white/5 border border-white/10 rounded-xl p-4 mb-6 text-left space-y-2">
        <p className="text-slate-400 text-xs">
          {lang === 'da'
            ? '✓  Tjek din spam-mappe, hvis du ikke kan se e-mailen'
            : "✓  Check your spam folder if you don't see the email"}
        </p>
        <p className="text-slate-400 text-xs">
          {lang === 'da'
            ? '✓  Linket udløber efter 24 timer'
            : '✓  The link expires after 24 hours'}
        </p>
        <p className="text-slate-400 text-xs">
          {lang === 'da' ? '✓  Du kan lukke denne side' : '✓  You can close this page'}
        </p>
      </div>

      {/* Resend section */}
      <div className="border-t border-white/10 pt-6 space-y-3">
        <p className="text-slate-500 text-xs">
          {lang === 'da' ? 'Fik du ikke e-mailen?' : "Didn't receive the email?"}
        </p>

        {/* Success feedback */}
        {sent && (
          <div className="flex items-center justify-center gap-2 text-emerald-400 text-sm">
            <CheckCircle2 size={15} />
            {lang === 'da' ? 'E-mail gensendt!' : 'Email resent!'}
          </div>
        )}

        {/* Error feedback */}
        {error && (
          <div className="flex items-center justify-center gap-2 text-red-400 text-sm">
            <AlertCircle size={15} />
            {lang === 'da'
              ? 'Noget gik galt. Prøv igen.'
              : 'Something went wrong. Please try again.'}
          </div>
        )}

        <button
          onClick={handleResend}
          disabled={loading || cooldown > 0 || !email}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium border border-white/10 text-slate-300 hover:text-white hover:bg-white/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading && <Loader2 size={14} className="animate-spin" />}
          {cooldown > 0
            ? lang === 'da'
              ? `Gensend om ${cooldown}s`
              : `Resend in ${cooldown}s`
            : lang === 'da'
              ? 'Gensend bekræftelsesmail'
              : 'Resend verification email'}
        </button>
      </div>

      <Link
        href="/login"
        className="inline-flex items-center gap-2 text-blue-400 hover:text-blue-300 text-sm font-medium transition-colors mt-5"
      >
        <ArrowLeft size={16} />
        {lang === 'da' ? 'Tilbage til log ind' : 'Back to log in'}
      </Link>
    </div>
  );
}

/**
 * Verify email pending page.
 * Wrapped in Suspense to satisfy Next.js App Router's useSearchParams requirement.
 *
 * @returns The email verification waiting screen with resend functionality.
 */
export default function VerifyEmailPage() {
  return (
    <div className="min-h-screen bg-[#0f172a] flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-md">
        <Suspense
          fallback={
            <div className="flex justify-center py-20">
              <Loader2 size={28} className="animate-spin text-blue-400" />
            </div>
          }
        >
          <VerifyEmailContent />
        </Suspense>
      </div>
    </div>
  );
}
