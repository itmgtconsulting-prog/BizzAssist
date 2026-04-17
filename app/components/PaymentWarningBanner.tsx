'use client';

/**
 * PaymentWarningBanner — persistent banner shown across the dashboard when a
 * subscription is in `past_due` (grace) or `payment_failed` (blocked) state.
 *
 * Reads from SubscriptionContext (server-authoritative). Offers a direct link
 * to the Stripe customer portal so the user can update their payment method
 * without first navigating to settings.
 *
 * BIZZ-541:
 *   - `past_due`: amber warning, access still granted inside grace window.
 *     Shows countdown to next_payment_attempt.
 *   - `payment_failed`: red blocking warning, access is gated by
 *     SubscriptionGate. Shows "please update payment method".
 *
 * Accessibility (WCAG AA):
 *   - `role="alert"` so assistive tech announces the payment problem.
 *   - Update-payment button is a real `<button>` (keyboard-accessible).
 *   - Text colors meet AA contrast against #0f172a background.
 *
 * @see app/api/stripe/webhook/route.ts — sets status + nextPaymentAttempt
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { useSubscription } from '@/app/context/SubscriptionContext';
import { useLanguage } from '@/app/context/LanguageContext';
import { logger } from '@/app/lib/logger';

/**
 * Format the relative time until `target` as a short human string.
 * Returns e.g. "om 2 timer" / "in 2 hours", or "snart" / "soon" when imminent.
 *
 * @param target - Future Date
 * @param lang   - 'da' | 'en'
 */
function formatCountdown(target: Date, lang: 'da' | 'en'): string {
  const deltaMs = target.getTime() - Date.now();
  if (deltaMs <= 0) return lang === 'da' ? 'snart' : 'soon';

  const minutes = Math.round(deltaMs / 60000);
  if (minutes < 60) {
    return lang === 'da' ? `om ${minutes} min` : `in ${minutes} min`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return lang === 'da' ? `om ${hours} timer` : `in ${hours} hours`;
  }
  const days = Math.round(hours / 24);
  return lang === 'da' ? `om ${days} dage` : `in ${days} days`;
}

/**
 * PaymentWarningBanner — top-of-dashboard banner for past_due / payment_failed state.
 * Renders nothing when the subscription is healthy.
 */
export default function PaymentWarningBanner(): React.ReactElement | null {
  const { subscription, checked, isAdmin } = useSubscription();
  const { lang } = useLanguage();
  const [portalLoading, setPortalLoading] = useState(false);

  // Ticking state so the countdown re-renders each minute without a full refresh
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Don't show anything until we know the subscription state. Admins see it
  // too so they can spot payment-failure banners on their own accounts.
  if (!checked || !subscription) return null;

  const status = subscription.status;
  if (status !== 'past_due' && status !== 'payment_failed') return null;

  const isHard = status === 'payment_failed';
  const da = lang === 'da';

  const nextRetryAt = subscription.nextPaymentAttempt
    ? new Date(subscription.nextPaymentAttempt)
    : null;
  const countdownLabel = nextRetryAt ? formatCountdown(nextRetryAt, lang) : null;

  /**
   * Create a Stripe customer portal session and redirect to it. Falls back to
   * the settings page on any failure so the user still has a path to fix.
   */
  const handleUpdateClick = async (): Promise<void> => {
    if (portalLoading) return;
    setPortalLoading(true);
    try {
      const res = await fetch('/api/stripe/portal', { method: 'POST' });
      if (res.ok) {
        const { url } = (await res.json()) as { url?: string };
        if (url) {
          window.location.href = url;
          return;
        }
      }
      // Stripe portal unavailable — fall back to settings
      window.location.href = '/dashboard/settings?tab=abonnement';
    } catch (err) {
      logger.error('[PaymentWarningBanner] portal fetch failed:', err);
      window.location.href = '/dashboard/settings?tab=abonnement';
    } finally {
      setPortalLoading(false);
    }
  };

  // Color palette — amber warning (grace) vs red block (failed)
  const palette = isHard
    ? {
        bg: 'bg-red-950/60',
        border: 'border-red-500/40',
        icon: 'text-red-400',
        text: 'text-red-100',
        button: 'bg-red-600 hover:bg-red-500',
      }
    : {
        bg: 'bg-amber-950/50',
        border: 'border-amber-500/40',
        icon: 'text-amber-400',
        text: 'text-amber-100',
        button: 'bg-amber-600 hover:bg-amber-500',
      };

  const headline = isHard
    ? da
      ? 'Adgang er blokeret — betaling mislykket'
      : 'Access blocked — payment failed'
    : da
      ? 'Betaling mislykkedes'
      : 'Payment failed';

  const body = isHard
    ? da
      ? 'Alle forsøg er brugt. Opdatér betalingsmetode for at genoptage dit abonnement.'
      : 'All retries exhausted. Please update your payment method to resume your subscription.'
    : da
      ? `Vi prøver igen${countdownLabel ? ` ${countdownLabel}` : ''}. Opdatér betalingsmetode for at undgå afbrydelse.`
      : `We will retry${countdownLabel ? ` ${countdownLabel}` : ''}. Please update your payment method to avoid interruption.`;

  return (
    <div
      role="alert"
      aria-live={isHard ? 'assertive' : 'polite'}
      className={`${palette.bg} ${palette.border} border-b px-4 sm:px-6 py-3`}
      data-testid="payment-warning-banner"
      data-status={status}
    >
      <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-start gap-3 flex-1">
          <AlertTriangle
            size={20}
            className={`${palette.icon} shrink-0 mt-0.5`}
            aria-hidden="true"
          />
          <div className={`${palette.text} text-sm`}>
            <p className="font-semibold">{headline}</p>
            <p className="opacity-90">{body}</p>
            {!isHard && !isAdmin && subscription.graceExpiresAt && (
              <p className="opacity-70 text-xs mt-1">
                {da ? 'Adgang bevares indtil: ' : 'Access retained until: '}
                {new Date(subscription.graceExpiresAt).toLocaleString(da ? 'da-DK' : 'en-GB', {
                  dateStyle: 'long',
                  timeStyle: 'short',
                })}
              </p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={handleUpdateClick}
          disabled={portalLoading}
          aria-label={da ? 'Opdatér betalingsmetode' : 'Update payment method'}
          className={`${palette.button} text-white px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 transition-colors disabled:opacity-60 disabled:cursor-wait shrink-0`}
        >
          {portalLoading
            ? da
              ? 'Åbner…'
              : 'Opening…'
            : da
              ? 'Opdatér betaling'
              : 'Update payment'}
          <ExternalLink size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
