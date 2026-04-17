'use client';

/**
 * SubscriptionGate — blocks access to features when user has no valid paid plan.
 *
 * Reads subscription state from SubscriptionContext (server-authoritative,
 * no localStorage). Shows an upgrade prompt if access is denied.
 *
 * Admin users always have access regardless of subscription status.
 *
 * @param children - Content to gate
 * @param requiredFeature - Optional feature requirement ('ai' | 'search' | 'detail')
 */

import { Lock, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useLanguage } from '@/app/context/LanguageContext';
import { useSubscription } from '@/app/context/SubscriptionContext';
import { resolvePlan, isWithinPaymentGrace, type UserSubscription } from '@/app/lib/subscriptions';

interface Props {
  /** Content to render if access is granted */
  children: React.ReactNode;
  /** Specific feature to check */
  requiredFeature?: 'ai' | 'search' | 'detail';
  /** Whether the subscription is functional (paid/trial/free) — passed from layout */
  isFunctional?: boolean;
}

/**
 * Check if a subscription grants access to a given feature.
 *
 * @param sub - User's subscription
 * @param feature - Feature to check
 * @returns true if access is granted
 */
function hasAccess(sub: UserSubscription | null, feature?: string): boolean {
  if (!sub) return false;
  // BIZZ-541: Resolve plan first so grace logic can use plan.paymentGraceHours.
  // past_due + grace-hours > 0 + within window = allowed.
  // Default plans have paymentGraceHours=0 → past_due blocks immediately,
  // matching the "failed payment = unpaid" design.
  const plan = resolvePlan(sub.planId);
  const activeOrGrace = sub.status === 'active' || isWithinPaymentGrace(sub, plan);
  if (!activeOrGrace) return false;

  // All active plans have access to search and detail views
  if (!feature) return true;

  switch (feature) {
    case 'ai':
      return plan.aiEnabled;
    case 'search':
    case 'detail':
      return true; // All active plans
    default:
      return true;
  }
}

export default function SubscriptionGate({
  children,
  requiredFeature,
  isFunctional: isFunctionalProp,
}: Props) {
  const { lang } = useLanguage();
  const { subscription: sub, checked, isAdmin, isFunctional: ctxFunctional } = useSubscription();

  // Use prop override if provided, otherwise context value
  const functional = isFunctionalProp ?? ctxFunctional;

  // Still loading — show nothing until subscription check completes
  if (!checked) return null;

  // Admin users always have access
  if (isAdmin) return <>{children}</>;

  // Block if subscription is not functional (unpaid, no trial, etc.)
  const unpaid = functional === false;

  // Access granted — must be functional AND have feature access
  if (!unpaid && hasAccess(sub, requiredFeature)) {
    return <>{children}</>;
  }

  // Determine message
  const da = lang === 'da';
  let title: string;
  let description: string;

  if (unpaid && sub?.status === 'active') {
    title = da ? 'Betaling påkrævet' : 'Payment required';
    description = da
      ? 'Dit abonnement er aktivt, men der mangler betaling. Gå til indstillinger for at gennemføre betalingen og få adgang til alle funktioner.'
      : 'Your subscription is active but payment is pending. Go to settings to complete payment and unlock all features.';
  } else if (!sub || sub.status !== 'active') {
    title = da ? 'Aktivt abonnement påkrævet' : 'Active subscription required';
    description = da
      ? 'Du skal have et aktivt og betalt abonnement for at bruge denne funktion. Gå til indstillinger for at administrere dit abonnement.'
      : 'You need an active, paid subscription to use this feature. Go to settings to manage your subscription.';
  } else if (requiredFeature === 'ai') {
    title = da ? 'AI er ikke inkluderet i dit abonnement' : 'AI is not included in your plan';
    description = da
      ? 'Opgrader til Professionel eller Enterprise for at bruge AI-assistenten.'
      : 'Upgrade to Professional or Enterprise to use the AI assistant.';
  } else {
    title = da ? 'Funktion ikke tilgængelig' : 'Feature not available';
    description = da
      ? 'Opgrader dit abonnement for at få adgang til denne funktion.'
      : 'Upgrade your subscription to access this feature.';
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center max-w-sm">
        <div className="w-14 h-14 bg-amber-500/10 rounded-2xl flex items-center justify-center mx-auto mb-5">
          <Lock size={26} className="text-amber-400" />
        </div>
        <h2 className="text-lg font-bold text-white mb-2">{title}</h2>
        <p className="text-slate-400 text-sm mb-6 leading-relaxed">{description}</p>
        <Link
          href="/dashboard/settings?tab=abonnement"
          className={`inline-flex items-center gap-2 font-medium text-sm px-5 py-2.5 rounded-xl transition-colors ${
            unpaid
              ? 'bg-amber-500 hover:bg-amber-400 text-black'
              : 'bg-blue-600 hover:bg-blue-500 text-white'
          }`}
        >
          {unpaid
            ? da
              ? 'Gennemfør betaling'
              : 'Complete payment'
            : da
              ? 'Administrer abonnement'
              : 'Manage subscription'}
          <ArrowRight size={16} />
        </Link>
      </div>
    </div>
  );
}

/**
 * Hook to check subscription access from any component.
 * Uses SubscriptionContext instead of localStorage.
 *
 * @param feature - Feature to check
 * @returns Object with access boolean and subscription data
 */
export function useSubscriptionAccess(feature?: 'ai' | 'search' | 'detail') {
  const { subscription: sub, checked, isAdmin } = useSubscription();

  return {
    loading: !checked,
    hasAccess: isAdmin || hasAccess(sub, feature),
    subscription: sub,
    isActive: isAdmin || sub?.status === 'active',
    planId: sub?.planId ?? null,
  };
}
