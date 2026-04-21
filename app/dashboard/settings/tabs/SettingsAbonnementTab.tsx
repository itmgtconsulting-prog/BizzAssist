/**
 * SettingsAbonnementTab — Abonnement-fane på indstillingssiden.
 * Viser nuværende abonnement, planer, fakturering, opsigelse.
 * BIZZ-661: Extraheret fra SettingsPageClient.tsx.
 * @module app/dashboard/settings/tabs/SettingsAbonnementTab
 */
'use client';

import { useRouter } from 'next/navigation';
import {
  CheckCircle,
  AlertTriangle,
  Shield,
  Clock,
  Loader2,
  CreditCard,
  Crown,
  Zap,
  ExternalLink,
} from 'lucide-react';
import {
  formatTokens,
  resolvePlan,
  type PlanDef,
  type UserSubscription,
} from '@/app/lib/subscriptions';

interface BillingInfo {
  nextPaymentDate: string | null;
  cardLast4: string | null;
  cardBrand: string | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
  stripeStatus: string | null;
}

interface Props {
  lang: 'da' | 'en';
  subscription: UserSubscription | null;
  billing: BillingInfo | null;
  isAdmin: boolean;
  paymentResult: 'success' | 'cancelled' | null;
  availablePlans: PlanDef[];
  checkoutLoading: string | null;
  portalLoading: boolean;
  stripeError: string | null;
  cancelConfirmOpen: boolean;
  setCancelConfirmOpen: React.Dispatch<React.SetStateAction<boolean>>;
  cancelLoading: boolean;
  cancelSuccess: string | null;
  handleCheckout: (planId: string) => void;
  handlePortal: () => void;
  handleCancelSubscription: () => void;
}

export default function SettingsAbonnementTab({
  lang,
  subscription,
  billing,
  isAdmin,
  paymentResult,
  availablePlans,
  checkoutLoading,
  portalLoading,
  stripeError,
  cancelConfirmOpen,
  setCancelConfirmOpen,
  cancelLoading,
  cancelSuccess,
  handleCheckout,
  handlePortal,
  handleCancelSubscription,
}: Props) {
  const da = lang === 'da';
  const router = useRouter();
  const t = {
    manageUsers: da ? 'Administrer brugere' : 'Manage users',
    yourSub: da ? 'Dit abonnement' : 'Your subscription',
    statusActive: da ? 'Aktiv' : 'Active',
    statusPending: da ? 'Afventer godkendelse' : 'Pending approval',
    statusCancelled: da ? 'Annulleret' : 'Cancelled',
    free: da ? 'Gratis' : 'Free',
    notIncluded: da ? 'Ikke inkluderet' : 'Not included',
    aiUsage: da ? 'AI-forbrug denne måned' : 'AI usage this month',
    pendingWarning: da
      ? 'Dit abonnement afventer godkendelse af en administrator. Du har begrænset adgang indtil det er godkendt.'
      : 'Your subscription is pending administrator approval. You have limited access until approved.',
    memberSince: da ? 'Medlem siden' : 'Member since',
    noSub: da ? 'Intet abonnement' : 'No subscription',
    noSubHint: da
      ? 'Du har endnu ikke valgt et abonnement. Kontakt en administrator for adgang.'
      : 'You have not selected a subscription yet. Contact an administrator for access.',
    availablePlans: da ? 'Tilgængelige planer' : 'Available plans',
    current: da ? 'Nuværende' : 'Current',
    unlimitedSearches: da ? 'Ubegrænsede søgninger' : 'Unlimited searches',
    noAI: da ? 'Ingen AI' : 'No AI',
    requiresApproval: da ? 'Kræver admin-godkendelse' : 'Requires admin approval',
    contactChange: da
      ? 'Demo-planen er gratis og kræver ingen betaling.'
      : 'The demo plan is free and requires no payment.',
    upgrade: da ? 'Opgrader' : 'Upgrade',
    downgrade: da ? 'Skift til denne' : 'Switch to this',
    soldOut: da ? 'Udsolgt' : 'Sold out',
    spotsLeft: da ? 'pladser tilbage' : 'spots left',
    manageBilling: da ? 'Administrer betaling' : 'Manage billing',
    paymentSuccess: da
      ? 'Betaling gennemført! Dit abonnement er nu aktivt.'
      : 'Payment successful! Your subscription is now active.',
    paymentCancelled: da
      ? 'Betalingen blev annulleret. Du kan prøve igen.'
      : 'Payment was cancelled. You can try again.',
    paymentFailed: da
      ? 'Der er et problem med din betaling. Opdater din betalingsmetode.'
      : 'There is a problem with your payment. Please update your payment method.',
    cancelSubscription: da ? 'Opsig abonnement' : 'Cancel subscription',
    cancelConfirmTitle: da ? 'Opsig dit abonnement?' : 'Cancel your subscription?',
    cancelConfirmBody: da
      ? 'Dit abonnement vil forblive aktivt indtil slutningen af den nuvaerende faktureringsperiode. Herefter mister du adgang til betalte funktioner.'
      : 'Your subscription will remain active until the end of the current billing period. After that, you will lose access to paid features.',
    cancelConfirmButton: da ? 'Ja, opsig abonnement' : 'Yes, cancel subscription',
    cancelKeep: da ? 'Behold abonnement' : 'Keep subscription',
    cancelledAt: da
      ? 'Dit abonnement er opsagt. Du har adgang indtil'
      : 'Your subscription has been cancelled. You have access until',
    nextPayment: da ? 'Næste betaling' : 'Next payment',
    paymentMethod: da ? 'Betalingsmetode' : 'Payment method',
    subscriptionDetails: da ? 'Abonnementsdetaljer' : 'Subscription details',
    price: da ? 'Pris' : 'Price',
    status: da ? 'Status' : 'Status',
    approvedOn: da ? 'Godkendt' : 'Approved',
    cancelPending: da ? 'Opsigelse afventer — adgang til' : 'Cancellation pending — access until',
  };

  return (
    <div className="space-y-6">
      {/* Payment result banner */}
      {paymentResult === 'success' && (
        <div className="flex items-center gap-3 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
          <CheckCircle size={18} className="text-emerald-400 shrink-0" />
          <p className="text-emerald-300 text-sm">{t.paymentSuccess}</p>
        </div>
      )}
      {paymentResult === 'cancelled' && (
        <div className="flex items-center gap-3 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
          <AlertTriangle size={18} className="text-amber-400 shrink-0" />
          <p className="text-amber-300 text-sm">{t.paymentCancelled}</p>
        </div>
      )}

      {/* Admin link (only for admin user) */}
      {isAdmin && (
        <button
          onClick={() => router.push('/dashboard/admin/users')}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 rounded-xl text-blue-400 text-sm font-medium transition-colors"
        >
          <Shield size={16} />
          {t.manageUsers}
        </button>
      )}

      {/* Current subscription */}
      {subscription ? (
        <div className="bg-white/5 border border-white/8 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-white font-semibold text-sm">{t.yourSub}</h3>
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${
                subscription.status === 'active'
                  ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                  : subscription.status === 'pending'
                    ? 'bg-amber-500/20 text-amber-400 border-amber-500/30'
                    : 'bg-red-500/20 text-red-400 border-red-500/30'
              }`}
            >
              {subscription.status === 'active' && <CheckCircle size={12} />}
              {subscription.status === 'pending' && <Clock size={12} />}
              {subscription.status === 'active'
                ? t.statusActive
                : subscription.status === 'pending'
                  ? t.statusPending
                  : t.statusCancelled}
            </span>
          </div>

          {(() => {
            const plan = resolvePlan(subscription.planId);
            const needsPayment = plan.priceDkk > 0 && !subscription.isPaid;
            return (
              <div className="space-y-4">
                {/* Payment required banner — shown when plan costs money but user hasn't paid */}
                {needsPayment && (
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 space-y-3">
                    <div className="flex items-start gap-3">
                      <AlertTriangle size={20} className="text-amber-400 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-amber-300 font-semibold text-sm">
                          {da ? 'Betaling påkrævet' : 'Payment required'}
                        </p>
                        <p className="text-amber-300/70 text-xs mt-1">
                          {da
                            ? 'Dit abonnement er aktivt, men der mangler betaling. Gennemfør betalingen for at få fuld adgang til søgning, AI og alle funktioner.'
                            : 'Your subscription is active but payment is pending. Complete payment to unlock search, AI, and all features.'}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleCheckout(subscription.planId)}
                      disabled={checkoutLoading === subscription.planId}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black text-sm font-bold rounded-xl transition-colors"
                    >
                      {checkoutLoading === subscription.planId ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <CreditCard size={16} />
                      )}
                      {da
                        ? `Betal nu — ${plan.priceDkk} kr/md`
                        : `Pay now — ${plan.priceDkk} kr/month`}
                    </button>
                  </div>
                )}

                {/* Stripe error banner */}
                {stripeError && (
                  <div className="flex items-center gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-xl">
                    <AlertTriangle size={18} className="text-red-400 shrink-0" />
                    <p className="text-red-300 text-sm">{stripeError}</p>
                  </div>
                )}

                <div className="flex items-center gap-3">
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                      plan.id === 'enterprise'
                        ? 'bg-purple-500/10 text-purple-400'
                        : plan.id === 'professionel'
                          ? 'bg-blue-500/10 text-blue-400'
                          : plan.id === 'basis'
                            ? 'bg-slate-500/10 text-slate-400'
                            : 'bg-amber-500/10 text-amber-400'
                    }`}
                  >
                    {plan.id === 'enterprise' ? (
                      <Crown size={18} />
                    ) : plan.id === 'professionel' ? (
                      <Zap size={18} />
                    ) : plan.id === 'basis' ? (
                      <Shield size={18} />
                    ) : (
                      <Clock size={18} />
                    )}
                  </div>
                  <div>
                    <p className="text-white font-semibold">{da ? plan.nameDa : plan.nameEn}</p>
                    <p className="text-slate-400 text-xs">
                      {plan.priceDkk === 0 ? t.free : `${plan.priceDkk} kr/md`}
                    </p>
                  </div>
                </div>

                {/* ─── Subscription details grid ─── */}
                <div className="bg-slate-800/40 rounded-xl p-4 space-y-3">
                  <p className="text-slate-500 text-[10px] uppercase tracking-wider font-semibold">
                    {t.subscriptionDetails}
                  </p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                    {/* Price */}
                    <div>
                      <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                        {t.price}
                      </p>
                      <p className="text-white text-sm font-medium">
                        {plan.priceDkk === 0 ? t.free : `${plan.priceDkk} kr/md`}
                      </p>
                    </div>

                    {/* Status */}
                    <div>
                      <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                        {t.status}
                      </p>
                      <p
                        className={`text-sm font-medium ${
                          subscription.status === 'active'
                            ? 'text-emerald-400'
                            : subscription.status === 'pending'
                              ? 'text-amber-400'
                              : 'text-red-400'
                        }`}
                      >
                        {subscription.status === 'active'
                          ? t.statusActive
                          : subscription.status === 'pending'
                            ? t.statusPending
                            : t.statusCancelled}
                      </p>
                    </div>

                    {/* Next payment date */}
                    {billing?.nextPaymentDate && !billing.cancelAtPeriodEnd && (
                      <div>
                        <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                          {t.nextPayment}
                        </p>
                        <p className="text-white text-sm font-medium">
                          {new Date(billing.nextPaymentDate).toLocaleDateString(
                            da ? 'da-DK' : 'en-GB',
                            { day: 'numeric', month: 'long', year: 'numeric' }
                          )}
                        </p>
                      </div>
                    )}

                    {/* Payment method */}
                    {billing?.cardLast4 && (
                      <div>
                        <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                          {t.paymentMethod}
                        </p>
                        <p className="text-white text-sm font-medium flex items-center gap-1.5">
                          <CreditCard size={14} className="text-slate-400" />
                          {(billing.cardBrand ?? 'card').charAt(0).toUpperCase() +
                            (billing.cardBrand ?? 'card').slice(1)}{' '}
                          •••• {billing.cardLast4}
                        </p>
                      </div>
                    )}

                    {/* Approved date */}
                    {subscription.approvedAt && (
                      <div>
                        <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                          {t.approvedOn}
                        </p>
                        <p className="text-white text-sm font-medium">
                          {new Date(subscription.approvedAt).toLocaleDateString(
                            da ? 'da-DK' : 'en-GB',
                            { day: 'numeric', month: 'long', year: 'numeric' }
                          )}
                        </p>
                      </div>
                    )}

                    {/* AI */}
                    <div>
                      <p className="text-slate-500 text-[10px] uppercase tracking-wider">AI</p>
                      <p className="text-white text-sm font-medium">
                        {plan.aiEnabled
                          ? plan.aiTokensPerMonth === -1
                            ? da
                              ? 'Ubegrænset'
                              : 'Unlimited'
                            : `${formatTokens(plan.aiTokensPerMonth)} tokens/md`
                          : t.notIncluded}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Cancellation pending banner */}
                {(billing?.cancelAtPeriodEnd || subscription.cancelAtPeriodEnd) && (
                  <div className="flex items-center gap-3 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
                    <AlertTriangle size={18} className="text-amber-400 shrink-0" />
                    <p className="text-amber-300 text-sm">
                      {t.cancelPending}{' '}
                      {new Date(
                        billing?.nextPaymentDate ?? subscription.cancelAt ?? ''
                      ).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric',
                      })}
                    </p>
                  </div>
                )}

                {/* AI token usage (if AI enabled) */}
                {plan.aiEnabled && plan.aiTokensPerMonth > 0 && (
                  <div className="bg-slate-800/40 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-slate-400 text-xs font-medium">{t.aiUsage}</p>
                      <p className="text-white text-xs font-semibold">
                        {formatTokens(subscription.tokensUsedThisMonth)} /{' '}
                        {formatTokens(plan.aiTokensPerMonth)}
                      </p>
                    </div>
                    <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          subscription.tokensUsedThisMonth / plan.aiTokensPerMonth > 0.9
                            ? 'bg-red-500'
                            : subscription.tokensUsedThisMonth / plan.aiTokensPerMonth > 0.7
                              ? 'bg-amber-500'
                              : 'bg-blue-500'
                        }`}
                        style={{
                          width: `${Math.min(100, (subscription.tokensUsedThisMonth / plan.aiTokensPerMonth) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Pending warning */}
                {subscription.status === 'pending' && (
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3">
                    <p className="text-amber-300 text-sm">{t.pendingWarning}</p>
                  </div>
                )}

                {/* Payment failed warning */}
                {subscription.status === ('payment_failed' as string) && (
                  <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
                    <p className="text-red-300 text-sm">{t.paymentFailed}</p>
                  </div>
                )}

                {/* Manage billing button — only for users who have already paid via Stripe */}
                {subscription.planId !== 'demo' &&
                  subscription.status === 'active' &&
                  subscription.isPaid && (
                    <button
                      onClick={handlePortal}
                      disabled={portalLoading}
                      className="flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-slate-700/60 hover:bg-slate-700 disabled:opacity-50 text-white text-sm font-medium rounded-xl border border-slate-600/40 transition-colors"
                    >
                      {portalLoading ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <ExternalLink size={14} />
                      )}
                      {t.manageBilling}
                    </button>
                  )}

                {/* Cancel subscription success banner */}
                {cancelSuccess && (
                  <div className="flex items-center gap-3 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
                    <AlertTriangle size={18} className="text-amber-400 shrink-0" />
                    <p className="text-amber-300 text-sm">
                      {t.cancelledAt} {cancelSuccess}.
                    </p>
                  </div>
                )}

                {/* Cancel subscription — only for paid active subscriptions */}
                {subscription.planId !== 'demo' &&
                  subscription.status === 'active' &&
                  subscription.isPaid && (
                    <>
                      {!cancelConfirmOpen ? (
                        <button
                          onClick={() => setCancelConfirmOpen(true)}
                          className="text-red-400/60 hover:text-red-400 text-xs font-medium transition-colors mt-1"
                        >
                          {t.cancelSubscription}
                        </button>
                      ) : (
                        <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4 space-y-3">
                          <p className="text-white text-sm font-semibold">{t.cancelConfirmTitle}</p>
                          <p className="text-slate-400 text-xs">{t.cancelConfirmBody}</p>
                          <div className="flex items-center gap-3">
                            <button
                              onClick={handleCancelSubscription}
                              disabled={cancelLoading}
                              className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
                            >
                              {cancelLoading && <Loader2 size={12} className="animate-spin" />}
                              {t.cancelConfirmButton}
                            </button>
                            <button
                              onClick={() => setCancelConfirmOpen(false)}
                              className="px-4 py-2 bg-slate-700/60 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-lg transition-colors"
                            >
                              {t.cancelKeep}
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}

                {/* Member since */}
                <p className="text-slate-600 text-xs">
                  {t.memberSince}{' '}
                  {new Date(subscription.createdAt).toLocaleDateString(
                    lang === 'da' ? 'da-DK' : 'en-GB',
                    {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    }
                  )}
                </p>
              </div>
            );
          })()}
        </div>
      ) : (
        <div className="text-center py-16">
          <CreditCard size={32} className="mx-auto mb-3 text-slate-600" />
          <p className="text-slate-400 text-sm mb-1">{t.noSub}</p>
          <p className="text-slate-500 text-xs max-w-sm mx-auto">{t.noSubHint}</p>
        </div>
      )}

      {/* Available plans */}
      <div>
        <h3 className="text-slate-400 text-sm font-semibold uppercase tracking-wider mb-3">
          {t.availablePlans}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {availablePlans.map((plan) => {
            const isActive = subscription?.planId === plan.id && subscription?.status === 'active';
            const isSoldOut = plan.maxSales != null && (plan.salesCount ?? 0) >= plan.maxSales;
            const remaining = plan.maxSales != null ? plan.maxSales - (plan.salesCount ?? 0) : null;
            const showRemaining = remaining != null && remaining > 0 && remaining <= 10;
            return (
              <div
                key={plan.id}
                className={`bg-white/5 border rounded-2xl p-5 transition-all ${
                  isActive
                    ? 'border-blue-500/40 bg-blue-500/5'
                    : isSoldOut
                      ? 'border-white/5 opacity-60'
                      : 'border-white/8 hover:border-slate-600'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <p className="text-white font-semibold text-sm">
                    {da ? plan.nameDa : plan.nameEn}
                  </p>
                  <div className="flex items-center gap-2">
                    {isSoldOut && !isActive && (
                      <span className="bg-red-500/20 text-red-400 border border-red-500/30 px-2 py-0.5 rounded-full text-[10px] font-bold">
                        {t.soldOut}
                      </span>
                    )}
                    {showRemaining && !isActive && !isSoldOut && (
                      <span className="bg-amber-500/20 text-amber-400 border border-amber-500/30 px-2 py-0.5 rounded-full text-[10px] font-bold">
                        {remaining} {t.spotsLeft}
                      </span>
                    )}
                    {isActive && (
                      <span className="bg-blue-500/20 text-blue-400 border border-blue-500/30 px-2 py-0.5 rounded-full text-[10px] font-bold">
                        {t.current}
                      </span>
                    )}
                  </div>
                </div>
                <p className="text-slate-400 text-xs mb-3">{da ? plan.descDa : plan.descEn}</p>
                <p className="text-white text-lg font-bold">
                  {plan.priceDkk === 0 ? t.free : `${plan.priceDkk} kr`}
                  {plan.priceDkk > 0 && (
                    <span className="text-slate-500 text-xs font-normal">/md</span>
                  )}
                </p>
                <ul className="mt-3 space-y-1.5">
                  <li className="flex items-center gap-2 text-xs text-slate-400">
                    <CheckCircle size={12} className="text-emerald-400 shrink-0" />
                    {t.unlimitedSearches}
                  </li>
                  <li
                    className={`flex items-center gap-2 text-xs ${plan.aiEnabled ? 'text-slate-400' : 'text-slate-600'}`}
                  >
                    {plan.aiEnabled ? (
                      <CheckCircle size={12} className="text-emerald-400 shrink-0" />
                    ) : (
                      <span className="w-3 h-3 rounded-full border border-slate-600 shrink-0" />
                    )}
                    {plan.aiEnabled
                      ? `AI — ${formatTokens(plan.aiTokensPerMonth)} tokens/md`
                      : t.noAI}
                  </li>
                  {plan.requiresApproval && (
                    <li className="flex items-center gap-2 text-xs text-amber-400">
                      <Clock size={12} className="shrink-0" />
                      {t.requiresApproval}
                    </li>
                  )}
                </ul>

                {/* Switch plan button — show for non-current paid plans, or free plans without approval */}
                {!isActive &&
                  !isSoldOut &&
                  (plan.priceDkk > 0 || !plan.requiresApproval) &&
                  (() => {
                    const currentPlanPrice =
                      availablePlans.find((p) => p.id === subscription?.planId)?.priceDkk ?? 0;
                    const isUpgrade = plan.priceDkk > currentPlanPrice;
                    return (
                      <button
                        onClick={() => handleCheckout(plan.id)}
                        disabled={checkoutLoading === plan.id}
                        className={`mt-4 flex items-center justify-center gap-2 w-full px-4 py-2.5 disabled:opacity-50 text-white text-sm font-medium rounded-xl transition-colors ${
                          isUpgrade
                            ? 'bg-blue-600 hover:bg-blue-500'
                            : 'bg-slate-700 hover:bg-slate-600'
                        }`}
                      >
                        {checkoutLoading === plan.id ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Zap size={14} />
                        )}
                        {isUpgrade ? t.upgrade : t.downgrade}
                      </button>
                    );
                  })()}
                {/* Sold out button (disabled) */}
                {!isActive && isSoldOut && (plan.priceDkk > 0 || !plan.requiresApproval) && (
                  <button
                    disabled
                    className="mt-4 flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-slate-800 text-slate-500 text-sm font-medium rounded-xl cursor-not-allowed"
                  >
                    {t.soldOut}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-slate-600 text-xs mt-4 text-center">{t.contactChange}</p>
      </div>
    </div>
  );
}
