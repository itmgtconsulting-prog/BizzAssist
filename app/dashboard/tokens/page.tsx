'use client';

/**
 * Token-side — /dashboard/tokens
 *
 * Lets users view their current token balance (with visual meter) and
 * purchase additional token top-up packs via Stripe.
 *
 * Sections:
 *   1. Token Balance Overview — fetched from GET /api/subscription
 *   2. Buy More Tokens — packs from GET /api/token-packs
 *   3. Payment result banners (success / cancelled via searchParams)
 *
 * All text is bilingual (DA/EN) using a local `t` object.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Coins, Zap, ShoppingCart, ArrowLeft, CheckCircle, RefreshCw } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { formatTokens, resolvePlan, type PlanId } from '@/app/lib/subscriptions';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Shape returned by GET /api/subscription */
interface SubscriptionResponse {
  email: string;
  fullName: string;
  subscription: {
    planId: PlanId;
    status: string;
    tokensUsedThisMonth: number;
    accumulatedTokens?: number;
    topUpTokens?: number;
    bonusTokens?: number;
    periodStart: string;
  } | null;
  effectiveTokenLimit?: number;
}

/** Shape of a single token pack from GET /api/token-packs */
interface TokenPack {
  id: string;
  nameDa: string;
  nameEn: string;
  tokenAmount: number;
  priceDkk: number;
}

// ─── Translations ───────────────────────────────────────────────────────────

const translations = {
  da: {
    back: 'Tilbage',
    title: 'Tokens',
    subtitle: 'Se dit tokenforbrug og køb flere tokens',
    balanceTitle: 'Token-balance',
    planAllocation: 'Plan-allokering pr. måned',
    accumulated: 'Akkumulerede tokens',
    topUp: 'Købte tokens',
    bonus: 'Bonus-tokens',
    usedThisPeriod: 'Brugt denne periode',
    available: 'Tilgængelige',
    of: 'af',
    used: 'brugt',
    buyTitle: 'Køb flere tokens',
    buySubtitle: 'Vælg en pakke for at fylde op',
    buy: 'Køb',
    redirecting: 'Omdirigerer til betaling...',
    loading: 'Indlæser...',
    noSubscription: 'Intet aktivt abonnement fundet.',
    noPacks: 'Ingen token-pakker tilgængelige.',
    paymentSuccess: 'Betaling gennemført! Dine tokens er blevet tilføjet.',
    paymentCancelled: 'Betaling annulleret. Du er ikke blevet opkrævet.',
    unlimited: 'Ubegrænset',
    refresh: 'Opdater',
    perMonth: '/måned',
    dkk: 'DKK',
    tokens: 'tokens',
  },
  en: {
    back: 'Back',
    title: 'Tokens',
    subtitle: 'View your token usage and buy more tokens',
    balanceTitle: 'Token Balance',
    planAllocation: 'Plan allocation per month',
    accumulated: 'Accumulated tokens',
    topUp: 'Purchased tokens',
    bonus: 'Bonus tokens',
    usedThisPeriod: 'Used this period',
    available: 'Available',
    of: 'of',
    used: 'used',
    buyTitle: 'Buy More Tokens',
    buySubtitle: 'Choose a pack to top up',
    buy: 'Buy',
    redirecting: 'Redirecting to payment...',
    loading: 'Loading...',
    noSubscription: 'No active subscription found.',
    noPacks: 'No token packs available.',
    paymentSuccess: 'Payment successful! Your tokens have been added.',
    paymentCancelled: 'Payment cancelled. You have not been charged.',
    unlimited: 'Unlimited',
    refresh: 'Refresh',
    perMonth: '/month',
    dkk: 'DKK',
    tokens: 'tokens',
  },
} as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns a Tailwind color class based on available-token percentage.
 *
 * @param pct - Percentage of tokens remaining (0-100)
 * @returns Tailwind color class string
 */
function meterColor(pct: number): string {
  if (pct > 50) return 'bg-emerald-500';
  if (pct > 20) return 'bg-amber-500';
  return 'bg-red-500';
}

/**
 * Returns a Tailwind text color class based on available-token percentage.
 *
 * @param pct - Percentage of tokens remaining (0-100)
 * @returns Tailwind text color class string
 */
function textColor(pct: number): string {
  if (pct > 50) return 'text-emerald-400';
  if (pct > 20) return 'text-amber-400';
  return 'text-red-400';
}

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * TokensPage — displays the user's token balance with a visual meter,
 * breakdown cards, and a grid of purchasable token packs.
 *
 * Reads `?payment=success|cancelled` from searchParams for result banners.
 *
 * @returns The tokens dashboard page
 */
export default function TokensPage() {
  const { lang } = useLanguage();
  const t = translations[lang];
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── State ──
  const [subData, setSubData] = useState<SubscriptionResponse | null>(null);
  const [packs, setPacks] = useState<TokenPack[]>([]);
  const [loading, setLoading] = useState(true);
  const [buyingPackId, setBuyingPackId] = useState<string | null>(null);

  /** Payment result from Stripe redirect */
  const paymentResult = searchParams.get('payment');

  // ── Fetch subscription + packs ──

  /** Fetches subscription data and token packs from the API. */
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [subRes, packsRes] = await Promise.all([
        fetch('/api/subscription'),
        fetch('/api/token-packs'),
      ]);

      if (subRes.ok) {
        const data: SubscriptionResponse = await subRes.json();
        setSubData(data);
      }

      if (packsRes.ok) {
        const data: TokenPack[] = await packsRes.json();
        setPacks(data);
      }
    } catch {
      // Silently fail — user sees "no subscription" or empty packs
    } finally {
      setLoading(false);
    }
  }, []);

  /** Fetch data on mount */
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Derived values ──

  const sub = subData?.subscription ?? null;
  const plan = sub ? resolvePlan(sub.planId) : null;
  const isUnlimited = plan ? plan.aiTokensPerMonth === -1 : false;

  const planMonthly = plan?.aiTokensPerMonth ?? 0;
  const accumulated = sub?.accumulatedTokens ?? 0;
  const topUp = sub?.topUpTokens ?? 0;
  const bonus = sub?.bonusTokens ?? 0;
  const used = sub?.tokensUsedThisMonth ?? 0;
  const totalAvailable = subData?.effectiveTokenLimit ?? planMonthly + accumulated + topUp + bonus;
  const remaining = Math.max(0, totalAvailable - used);
  const usagePct = totalAvailable > 0 ? Math.round((remaining / totalAvailable) * 100) : 0;

  // ── Buy handler ──

  /**
   * Initiates a Stripe checkout session for the given token pack.
   *
   * @param packId - ID of the token pack to purchase
   */
  async function handleBuy(packId: string) {
    setBuyingPackId(packId);
    try {
      const res = await fetch('/api/stripe/create-topup-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId }),
      });

      if (res.ok) {
        const { url } = await res.json();
        if (url) {
          window.location.href = url;
          return; // Keep loading state while redirecting
        }
      }
    } catch {
      // Silently fail
    }
    setBuyingPackId(null);
  }

  // ── Render ──

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <RefreshCw className="w-6 h-6 text-blue-400 animate-spin" />
        <span className="ml-3 text-white/60">{t.loading}</span>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
      {/* ── Back button ── */}
      <button
        onClick={() => router.push('/dashboard')}
        className="flex items-center gap-2 text-white/50 hover:text-white transition-colors text-sm"
      >
        <ArrowLeft className="w-4 h-4" />
        {t.back}
      </button>

      {/* ── Page header ── */}
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-3">
          <Coins className="w-7 h-7 text-amber-400" />
          {t.title}
        </h1>
        <p className="text-white/50 mt-1">{t.subtitle}</p>
      </div>

      {/* ── Payment result banners ── */}
      {paymentResult === 'success' && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
          <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0" />
          <span className="text-emerald-300 text-sm">{t.paymentSuccess}</span>
        </div>
      )}
      {paymentResult === 'cancelled' && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <ShoppingCart className="w-5 h-5 text-amber-400 shrink-0" />
          <span className="text-amber-300 text-sm">{t.paymentCancelled}</span>
        </div>
      )}

      {/* ── Section 1: Token Balance Overview ── */}
      {!sub ? (
        <div className="rounded-xl bg-slate-800/50 border border-white/5 p-8 text-center text-white/40">
          {t.noSubscription}
        </div>
      ) : (
        <div className="rounded-xl bg-slate-800/50 border border-white/5 p-6 space-y-6">
          {/* Header row */}
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <Zap className="w-5 h-5 text-blue-400" />
              {t.balanceTitle}
            </h2>
            <button
              onClick={fetchData}
              className="flex items-center gap-1.5 text-white/40 hover:text-white/70 transition-colors text-xs"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              {t.refresh}
            </button>
          </div>

          {/* Visual meter */}
          {isUnlimited ? (
            <div className="text-center py-4">
              <span className="text-3xl font-bold text-emerald-400">{t.unlimited}</span>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <span className={`text-3xl font-bold ${textColor(usagePct)}`}>
                  {formatTokens(remaining)}
                </span>
                <span className="text-white/40 text-sm">
                  {t.of} {formatTokens(totalAvailable)} — {formatTokens(used)} {t.used}
                </span>
              </div>

              {/* Progress bar */}
              <div className="w-full h-3 rounded-full bg-white/5 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${meterColor(usagePct)}`}
                  style={{ width: `${Math.min(100, usagePct)}%` }}
                />
              </div>
            </div>
          )}

          {/* Breakdown cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <BreakdownCard
              label={t.planAllocation}
              value={isUnlimited ? t.unlimited : formatTokens(planMonthly)}
              sub={plan ? (lang === 'da' ? plan.nameDa : plan.nameEn) + t.perMonth : ''}
              color="text-blue-400"
            />
            <BreakdownCard
              label={t.accumulated}
              value={formatTokens(accumulated)}
              color="text-purple-400"
            />
            <BreakdownCard label={t.topUp} value={formatTokens(topUp)} color="text-amber-400" />
            <BreakdownCard label={t.bonus} value={formatTokens(bonus)} color="text-emerald-400" />
            <BreakdownCard
              label={t.usedThisPeriod}
              value={formatTokens(used)}
              color="text-red-400"
            />
            <BreakdownCard
              label={t.available}
              value={isUnlimited ? t.unlimited : formatTokens(remaining)}
              color={isUnlimited ? 'text-emerald-400' : textColor(usagePct)}
              highlight
            />
          </div>
        </div>
      )}

      {/* ── Section 2: Buy More Tokens ── */}
      <div className="rounded-xl bg-slate-800/50 border border-white/5 p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-amber-400" />
            {t.buyTitle}
          </h2>
          <p className="text-white/40 text-sm mt-1">{t.buySubtitle}</p>
        </div>

        {packs.length === 0 ? (
          <div className="text-center py-8 text-white/30 text-sm">{t.noPacks}</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {packs.map((pack) => {
              const isBuying = buyingPackId === pack.id;
              return (
                <div
                  key={pack.id}
                  className="rounded-lg bg-white/[0.03] border border-white/5 p-5 flex flex-col items-center gap-3 hover:border-blue-500/30 transition-colors"
                >
                  <Coins className="w-8 h-8 text-amber-400" />
                  <span className="text-2xl font-bold text-white">
                    {formatTokens(pack.tokenAmount)}
                  </span>
                  <span className="text-white/40 text-xs">{t.tokens}</span>
                  <span className="text-white/70 text-sm font-medium">
                    {pack.priceDkk.toLocaleString('da-DK')} {t.dkk}
                  </span>
                  <button
                    onClick={() => handleBuy(pack.id)}
                    disabled={isBuying || buyingPackId !== null}
                    className="w-full mt-1 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors flex items-center justify-center gap-2"
                  >
                    {isBuying ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        {t.redirecting}
                      </>
                    ) : (
                      <>
                        <ShoppingCart className="w-4 h-4" />
                        {t.buy}
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

/**
 * Small card showing a single token breakdown metric.
 *
 * @param label - Description text
 * @param value - Formatted token value
 * @param sub - Optional subtitle text
 * @param color - Tailwind text color class for the value
 * @param highlight - Whether to apply a subtle highlight border
 */
function BreakdownCard({
  label,
  value,
  sub,
  color,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  color: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg bg-white/[0.03] p-3.5 ${
        highlight ? 'border border-white/10' : 'border border-transparent'
      }`}
    >
      <p className="text-white/40 text-xs mb-1">{label}</p>
      <p className={`text-lg font-bold ${color}`}>{value}</p>
      {sub && <p className="text-white/30 text-[11px] mt-0.5">{sub}</p>}
    </div>
  );
}
