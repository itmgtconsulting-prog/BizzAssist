'use client';

/**
 * Plan-selection page for new OAuth users — app/login/select-plan/page.tsx
 *
 * Shown after a first-time OAuth login (Google, Microsoft, LinkedIn) when the
 * user has a Supabase account but no subscription in app_metadata.
 * The user chooses a plan here before accessing the dashboard.
 *
 * Flow:
 *   1. Verify the user is authenticated — redirect to /login if not
 *   2. Verify the user still has no plan — redirect to /dashboard if they do
 *   3. Render plan cards from /api/plans
 *   4. Paid plan  → POST /api/stripe/create-checkout → redirect to Stripe
 *   5. Free/demo  → call selectFreePlan() server action → redirect to
 *                   /login/verify-email (pending) or /dashboard (active)
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, CheckCircle2, Loader2, AlertCircle, Zap, Clock } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';
import { selectFreePlan } from '@/app/auth/actions';
import { logger } from '@/app/lib/logger';

/** Plan data shape returned by /api/plans */
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
  stripePriceId?: string | null;
}

/** Color tokens for each plan accent color */
const PLAN_COLORS: Record<
  string,
  { border: string; ring: string; badge: string; popular: boolean }
> = {
  amber: {
    border: 'border-amber-500/40',
    ring: 'ring-amber-500/40',
    badge: 'text-amber-400 bg-amber-500/10',
    popular: false,
  },
  slate: {
    border: 'border-slate-400/40',
    ring: 'ring-slate-400/40',
    badge: 'text-slate-400 bg-slate-500/10',
    popular: false,
  },
  blue: {
    border: 'border-blue-500/40',
    ring: 'ring-blue-500/40',
    badge: 'text-blue-400 bg-blue-500/10',
    popular: true,
  },
  purple: {
    border: 'border-purple-500/40',
    ring: 'ring-purple-500/40',
    badge: 'text-purple-400 bg-purple-500/10',
    popular: false,
  },
};

/**
 * SelectPlanClient — shown to new OAuth users who have no subscription yet.
 *
 * @returns Plan-selection UI or loading/redirect state
 */
export default function SelectPlanClient() {
  const { lang, setLang } = useLanguage();
  const da = lang === 'da';
  const router = useRouter();

  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Checked on mount — if user already has a plan or is not authed, redirect */
  const [authChecked, setAuthChecked] = useState(false);

  /** On mount: verify auth + subscription status, fetch plans */
  useEffect(() => {
    (async () => {
      // Check auth + existing subscription via server-side API
      const res = await fetch('/api/subscription');
      if (!res.ok) {
        // Not authenticated — send to login
        router.replace('/login');
        return;
      }
      const json = await res.json();
      if (json.subscription?.planId) {
        // User already has a plan — send to dashboard
        router.replace('/dashboard');
        return;
      }
      setAuthChecked(true);

      // Fetch available plans
      try {
        const planRes = await fetch('/api/plans');
        if (planRes.ok) {
          const data: PlanOption[] = await planRes.json();
          setPlans(data);
          if (data.length > 0) setSelectedPlan(data[0].id);
        }
      } finally {
        setPlansLoading(false);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Handles plan selection submission.
   * Paid plans → Stripe checkout.
   * Free/demo plans → selectFreePlan server action.
   */
  const handleSelectPlan = async () => {
    if (!selectedPlan) return;
    setError(null);
    setSubmitting(true);

    const plan = plans.find((p) => p.id === selectedPlan);

    try {
      if (plan && plan.priceDkk > 0) {
        // Warn early if Stripe price ID is missing
        if (!plan.stripePriceId) {
          setError('stripe_not_configured');
          setSubmitting(false);
          return;
        }
        // Paid plan — create Stripe checkout session
        const res = await fetch('/api/stripe/create-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId: selectedPlan }),
        });
        const json = await res.json();
        if (!res.ok || !json.url) {
          logger.error('[select-plan] Stripe checkout failed:', res.status, json.error);
          setError(json.error ?? 'unexpected_error');
          setSubmitting(false);
          return;
        }
        // Redirect to Stripe hosted checkout
        window.location.href = json.url;
      } else {
        // Free or demo plan — set via server action
        const result = await selectFreePlan(selectedPlan);
        if (result?.error) {
          setError(result.error);
          setSubmitting(false);
          return;
        }
        // Beta period: demo plan is auto-approved — go directly to dashboard
        router.replace('/dashboard');
      }
    } catch {
      setError('unexpected_error');
      setSubmitting(false);
    }
  };

  const errorMessages: Record<string, { da: string; en: string }> = {
    unexpected_error: {
      da: 'Noget gik galt. Prøv igen.',
      en: 'Something went wrong. Please try again.',
    },
    not_authenticated: {
      da: 'Du er ikke logget ind.',
      en: 'You are not logged in.',
    },
    stripe_not_configured: {
      da: 'Betaling er ikke konfigureret for denne plan. Kontakt administrator.',
      en: 'Payment is not configured for this plan. Contact administrator.',
    },
  };
  const errorMsg = error
    ? (errorMessages[error]?.[lang] ?? errorMessages.unexpected_error[lang])
    : null;

  // Show nothing until auth check completes (avoids flash)
  if (!authChecked) {
    return (
      <div className="min-h-screen bg-[#0f172a] flex items-center justify-center">
        <Loader2 size={24} className="text-blue-400 animate-spin" />
      </div>
    );
  }

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
              className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                lang === l ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-lg">
          <div className="bg-[#1e293b] border border-white/10 rounded-2xl p-8 shadow-2xl">
            {/* Header */}
            <div className="text-center mb-8">
              <h1 className="text-2xl font-bold text-white mb-2">
                {da ? 'Vælg en plan' : 'Choose a plan'}
              </h1>
              <p className="text-slate-400 text-sm">
                {da
                  ? 'Vælg det abonnement, der passer til dine behov, for at komme i gang.'
                  : 'Select the subscription that fits your needs to get started.'}
              </p>
            </div>

            {/* Error banner */}
            {errorMsg && (
              <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-6">
                <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
                <p className="text-red-300 text-sm">{errorMsg}</p>
              </div>
            )}

            {/* Plan cards */}
            {plansLoading ? (
              <div className="flex items-center justify-center gap-2 text-slate-500 py-8">
                <Loader2 size={14} className="animate-spin" />
                <span className="text-xs">{da ? 'Henter planer…' : 'Loading plans…'}</span>
              </div>
            ) : (
              <div className="space-y-2.5 mb-6">
                {plans.map((plan) => {
                  const isSelected = selectedPlan === plan.id;
                  const colors = PLAN_COLORS[plan.color] ?? PLAN_COLORS.slate;
                  const featuresMap = translations[lang].pricing.features as Record<
                    string,
                    string[]
                  >;
                  const features: string[] = featuresMap[plan.id] ?? [];

                  return (
                    <button
                      key={plan.id}
                      type="button"
                      onClick={() => setSelectedPlan(plan.id)}
                      disabled={submitting}
                      className={`relative w-full text-left rounded-xl p-4 border-2 transition-all disabled:opacity-50 ${
                        isSelected
                          ? `${colors.border} bg-white/5 ring-2 ${colors.ring}`
                          : 'border-white/10 hover:border-white/20 bg-white/[0.02]'
                      }`}
                    >
                      {/* "Mest populær" badge */}
                      {colors.popular && (
                        <span className="absolute -top-2.5 left-4 bg-blue-600 text-white text-[9px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wide">
                          {da ? 'Mest populær' : 'Most popular'}
                        </span>
                      )}

                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          {/* Name + price */}
                          <div className="flex items-baseline gap-2 flex-wrap mb-0.5">
                            <span className="text-white text-sm font-bold">
                              {da ? plan.nameDa : plan.nameEn}
                            </span>
                            <span className="text-white text-sm font-bold">
                              {plan.priceDkk === 0
                                ? da
                                  ? 'Gratis'
                                  : 'Free'
                                : `${plan.priceDkk} kr`}
                              {plan.priceDkk > 0 && (
                                <span className="text-slate-500 text-xs font-normal">/md</span>
                              )}
                            </span>
                          </div>

                          {/* Description */}
                          <p className="text-xs text-slate-500 mb-2">
                            {da ? plan.descDa : plan.descEn}
                          </p>

                          {/* Feature list */}
                          {features.length > 0 && (
                            <ul className="space-y-1">
                              {features.map((feat) => (
                                <li
                                  key={feat}
                                  className="flex items-center gap-1.5 text-xs text-slate-400"
                                >
                                  <Check size={10} className="text-blue-400 shrink-0" />
                                  {feat}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>

                        <div className="flex flex-col items-end gap-2 shrink-0 pt-0.5">
                          {isSelected && <CheckCircle2 size={16} className="text-blue-400" />}
                          {plan.aiEnabled && plan.aiTokensPerMonth !== 0 && (
                            <div
                              className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full ${colors.badge}`}
                            >
                              <Zap size={9} />
                              {plan.aiTokensPerMonth < 0
                                ? da
                                  ? 'Ubegrænset AI'
                                  : 'Unlimited AI'
                                : `${Math.round(plan.aiTokensPerMonth / 1000)}K AI`}
                            </div>
                          )}
                          {plan.requiresApproval && (
                            <div className="inline-flex items-center gap-1 text-[10px] text-slate-500">
                              <Clock size={9} />
                              {da ? 'Godkendelse' : 'Approval'}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {/* CTA button */}
            {!plansLoading && plans.length > 0 && (
              <button
                type="button"
                onClick={handleSelectPlan}
                disabled={submitting || !selectedPlan}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 px-4 rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                {submitting ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    {da ? 'Behandler…' : 'Processing…'}
                  </>
                ) : (
                  (() => {
                    const plan = plans.find((p) => p.id === selectedPlan);
                    if (!plan) return da ? 'Vælg plan' : 'Select plan';
                    if (plan.priceDkk > 0) {
                      return da
                        ? `Gå til betaling — ${plan.priceDkk} kr/md`
                        : `Proceed to payment — ${plan.priceDkk} kr/mo`;
                    }
                    return da ? 'Kom i gang gratis' : 'Get started for free';
                  })()
                )}
              </button>
            )}

            <p className="text-center text-slate-600 text-xs mt-4">
              {da
                ? 'Du kan opgradere eller annullere dit abonnement til enhver tid.'
                : 'You can upgrade or cancel your subscription at any time.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
