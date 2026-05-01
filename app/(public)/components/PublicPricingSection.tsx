'use client';

/**
 * PublicPricingSection — klient-side pricing grid til offentlige SEO-sider.
 *
 * Fetcher aktive planer fra /api/plans ved mount, så hver side altid viser
 * de aktuelle planer fra databasen — ikke en ISR-baget kopi. Det sikrer at
 * ændringer i admin-panelet slår igennem øjeblikkeligt på alle offentlige sider.
 *
 * Vises under login-CTA på ejendoms- og virksomhedssider.
 *
 * @returns Pricing grid med aktive planer, loading-skeleton, eller null.
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';

/** Plan data returned by /api/plans */
interface PlanOption {
  id: string;
  nameDa: string;
  descDa: string;
  priceDkk: number;
  aiTokensPerMonth: number;
  aiEnabled: boolean;
  requiresApproval: boolean;
  color: string;
  isActive: boolean;
  sortOrder: number;
}

const COLOR_MAP: Record<
  string,
  { border: string; badge: string; badgeText: string; highlight: boolean }
> = {
  amber: {
    border: 'border-amber-500/40',
    badge: 'bg-amber-500/20',
    badgeText: 'text-amber-300',
    highlight: false,
  },
  slate: {
    border: 'border-slate-500/30',
    badge: 'bg-slate-500/20',
    badgeText: 'text-slate-300',
    highlight: false,
  },
  blue: {
    border: 'border-blue-500/50',
    badge: 'bg-blue-600/20',
    badgeText: 'text-blue-300',
    highlight: false,
  },
  purple: {
    border: 'border-purple-500/40',
    badge: 'bg-purple-500/20',
    badgeText: 'text-purple-300',
    highlight: false,
  },
};

/** Splits description by newline into bullet list */
function parseFeatures(desc: string): string[] {
  return desc
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export default function PublicPricingSection() {
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [loading, setLoading] = useState(true);

  // Fetch plans dynamically on mount so each page load reflects the current
  // plan configuration from the database — not a build-time ISR snapshot.
  useEffect(() => {
    fetch('/api/plans')
      .then((res) => (res.ok ? res.json() : []))
      .then((data: PlanOption[]) => {
        setPlans(data.filter((p) => p.isActive));
      })
      .catch(() => {
        /* silently hide section on fetch error */
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    // Skeleton placeholder — prevents layout shift while plans load
    return (
      <section className="mt-16 pt-12 border-t border-white/10">
        <div className="text-center mb-8">
          <div className="h-7 w-72 bg-slate-800 rounded-lg mx-auto mb-2 animate-pulse" />
          <div className="h-4 w-96 bg-slate-800 rounded-lg mx-auto animate-pulse" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="rounded-xl border border-slate-700/50 bg-slate-900/60 p-5 h-64 animate-pulse"
            />
          ))}
        </div>
      </section>
    );
  }

  if (plans.length === 0) return null;

  return (
    <section className="mt-16 pt-12 border-t border-white/10">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold text-white mb-2">
          Få adgang til alle data med BizzAssist
        </h2>
        <p className="text-slate-400 text-sm max-w-xl mx-auto">
          Vælg det abonnement der passer til dit behov — ingen bindingsperiode.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {plans.map((plan) => {
          const colors = COLOR_MAP[plan.color] ?? COLOR_MAP.slate;
          const features = parseFeatures(plan.descDa);
          const isFree = plan.priceDkk === 0;

          return (
            <div
              key={plan.id}
              className={[
                'relative flex flex-col rounded-xl border bg-slate-900/60 p-5',
                colors.border,
                colors.highlight ? 'ring-1 ring-blue-500/40' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {/* Plan name */}
              <div className="mb-3">
                <span
                  className={[
                    'inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full',
                    colors.badge,
                    colors.badgeText,
                  ].join(' ')}
                >
                  {plan.nameDa}
                </span>
              </div>

              {/* Price */}
              <div className="mb-4">
                {isFree ? (
                  <span className="text-2xl font-extrabold text-white">Gratis</span>
                ) : (
                  <div className="flex items-baseline gap-1">
                    <span className="text-2xl font-extrabold text-white">
                      {plan.priceDkk.toLocaleString('da-DK')}
                    </span>
                    <span className="text-slate-400 text-xs"> kr./md.</span>
                  </div>
                )}
              </div>

              {/* AI tokens */}
              {plan.aiEnabled && plan.aiTokensPerMonth !== 0 && (
                <div className="mb-3 text-[11px] text-blue-300 bg-blue-600/10 border border-blue-500/20 rounded-lg px-2.5 py-1.5 font-medium">
                  {plan.aiTokensPerMonth === -1
                    ? 'Ubegrænsede AI-tokens'
                    : `${plan.aiTokensPerMonth.toLocaleString('da-DK')} tokens/md.`}
                </div>
              )}

              {/* Features */}
              <ul className="space-y-1.5 mb-5 flex-1">
                {features.map((feat, idx) => (
                  <li key={idx} className="flex items-start gap-2 text-xs text-slate-300">
                    <Check
                      size={12}
                      className="mt-0.5 flex-shrink-0 text-emerald-400"
                      aria-hidden="true"
                    />
                    {feat}
                  </li>
                ))}
              </ul>

              {/* CTA */}
              <div className="space-y-1.5">
                <Link
                  href="/login/signup"
                  className={[
                    'w-full block text-center rounded-lg py-2 px-3 font-semibold text-xs transition-colors',
                    colors.highlight
                      ? 'bg-blue-600 hover:bg-blue-500 text-white'
                      : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700',
                  ].join(' ')}
                >
                  Kom i gang
                </Link>
                {plan.requiresApproval && (
                  <p className="text-center text-[10px] text-slate-600">
                    Kræver godkendelse af administrator
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-center text-slate-600 text-xs mt-6">
        Alle priser er inkl. moms. Ingen bindingsperiode — opsig når som helst.
      </p>
    </section>
  );
}
