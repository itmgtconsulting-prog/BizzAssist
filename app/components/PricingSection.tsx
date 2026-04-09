'use client';

/**
 * PricingSection — marketing homepage pricing grid.
 *
 * Fetches active plans from /api/plans on mount so each environment
 * (production vs. test) shows its own plan configuration from the DB.
 * Description text is split by newline — each line becomes a green-check bullet.
 * Falls back to an empty grid with a spinner while loading.
 *
 * @returns A responsive pricing card grid with DA/EN language support.
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';
import { formatTokens } from '@/app/lib/subscriptions';

/** Plan data returned by /api/plans */
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
  isActive: boolean;
}

/** Tailwind classes per plan colour */
const COLOR_MAP: Record<
  string,
  { border: string; badge: string; badgeText: string; ring: string; highlight: boolean }
> = {
  amber: {
    border: 'border-amber-500/40',
    badge: 'bg-amber-500/20',
    badgeText: 'text-amber-300',
    ring: 'ring-amber-500/30',
    highlight: false,
  },
  slate: {
    border: 'border-slate-500/30',
    badge: 'bg-slate-500/20',
    badgeText: 'text-slate-300',
    ring: 'ring-slate-500/20',
    highlight: false,
  },
  blue: {
    border: 'border-blue-500/50',
    badge: 'bg-blue-600/20',
    badgeText: 'text-blue-300',
    ring: 'ring-blue-500/40',
    highlight: false,
  },
  purple: {
    border: 'border-purple-500/40',
    badge: 'bg-purple-500/20',
    badgeText: 'text-purple-300',
    ring: 'ring-purple-500/30',
    highlight: false,
  },
};

/**
 * Splits a description string into bullet lines.
 * Each non-empty line becomes one bullet point with a green checkmark.
 */
function parseFeatures(desc: string): string[] {
  const lines = desc
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : [desc];
}

export default function PricingSection() {
  const { lang } = useLanguage();
  const t = translations[lang].pricing;
  const da = lang === 'da';

  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [loading, setLoading] = useState(true);

  /** Fetch active plans for this environment on mount */
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/plans');
        if (res.ok) {
          const data: PlanOption[] = await res.json();
          setPlans(data.filter((p) => p.isActive));
        }
      } catch {
        /* leave plans empty — no crash */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <section id="pricing" className="py-24 bg-[#0a1020]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Heading */}
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold text-white mb-4">{t.title}</h2>
          <p className="text-slate-400 text-xl max-w-2xl mx-auto">{t.subtitle}</p>
        </div>

        {/* Loading skeleton */}
        {loading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="rounded-2xl border border-slate-700/50 bg-[#0f172a] p-6 animate-pulse"
              >
                <div className="h-5 bg-slate-700 rounded w-24 mb-3" />
                <div className="h-8 bg-slate-700 rounded w-32 mb-4" />
                {[0, 1, 2, 3, 4].map((j) => (
                  <div key={j} className="h-3 bg-slate-700/40 rounded w-full mb-3" />
                ))}
              </div>
            ))}
          </div>
        )}

        {/* Plan cards */}
        {!loading && plans.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {plans.map((plan) => {
              const colors = COLOR_MAP[plan.color] ?? COLOR_MAP.slate;
              const desc = da ? plan.descDa : plan.descEn;
              const features = parseFeatures(desc);
              const isHighlighted = colors.highlight;
              const isFree = plan.priceDkk === 0;
              const name = da ? plan.nameDa : plan.nameEn;

              return (
                <div
                  key={plan.id}
                  className={[
                    'relative flex flex-col rounded-2xl border bg-[#0f172a] p-6 transition-transform hover:-translate-y-1',
                    colors.border,
                    isHighlighted ? 'ring-2 ' + colors.ring : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {/* Plan name badge */}
                  <div className="mb-4">
                    <span
                      className={[
                        'inline-block text-xs font-semibold px-2.5 py-1 rounded-full',
                        colors.badge,
                        colors.badgeText,
                      ].join(' ')}
                    >
                      {name}
                    </span>
                  </div>

                  {/* Price */}
                  <div className="mb-6">
                    {isFree ? (
                      <span className="text-4xl font-extrabold text-white">{t.free}</span>
                    ) : (
                      <div className="flex items-baseline gap-1">
                        <span className="text-4xl font-extrabold text-white">
                          {plan.priceDkk.toLocaleString('da-DK')}
                        </span>
                        <span className="text-slate-400 text-sm font-medium"> kr.{t.monthly}</span>
                      </div>
                    )}
                  </div>

                  {/* AI tokens badge */}
                  {plan.aiEnabled && plan.aiTokensPerMonth !== 0 && (
                    <div className="mb-5 flex items-center gap-2 text-xs text-blue-300 bg-blue-600/10 border border-blue-500/20 rounded-lg px-3 py-2">
                      <span className="font-semibold">
                        {plan.aiTokensPerMonth === -1
                          ? da
                            ? 'Ubegrænsede AI-tokens'
                            : 'Unlimited AI tokens'
                          : `${formatTokens(plan.aiTokensPerMonth)} ${da ? 'tokens/md.' : 'tokens/mo.'}`}
                      </span>
                    </div>
                  )}

                  {/* Feature list — parsed from description, one bullet per line */}
                  <ul className="space-y-2.5 mb-8 flex-1">
                    {features.map((feat, idx) => (
                      <li key={idx} className="flex items-start gap-2.5 text-sm text-slate-300">
                        <Check
                          size={15}
                          className="mt-0.5 flex-shrink-0 text-emerald-400"
                          aria-hidden="true"
                        />
                        {feat}
                      </li>
                    ))}
                  </ul>

                  {/* CTA */}
                  <div className="mt-auto space-y-2">
                    <Link
                      href="/login/signup"
                      className={[
                        'w-full block text-center rounded-xl py-3 px-4 font-semibold text-sm transition-colors',
                        isHighlighted
                          ? 'bg-blue-600 hover:bg-blue-500 text-white'
                          : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700',
                      ].join(' ')}
                    >
                      {t.cta}
                    </Link>
                    {plan.requiresApproval && (
                      <p className="text-center text-[11px] text-slate-500">{t.requiresApproval}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Empty state */}
        {!loading && plans.length === 0 && (
          <p className="text-center text-slate-500">
            {da ? 'Ingen aktive abonnementer fundet.' : 'No active plans found.'}
          </p>
        )}

        {/* Fine print */}
        <p className="text-center text-slate-600 text-sm mt-10">
          {da
            ? 'Alle priser er ekskl. moms. Ingen bindingsperiode — opsig når som helst.'
            : 'All prices exclude VAT. No lock-in — cancel anytime.'}
        </p>
      </div>
    </section>
  );
}
