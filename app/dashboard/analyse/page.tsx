/**
 * Analyse & Tools landing page — /dashboard/analyse
 *
 * BIZZ-1260: To sektioner:
 *  1. Analyse — Pivot Analyse (manuel) + AI Query Builder
 *  2. Tools — branchespecifikke analyse-moduler
 *
 * @module app/dashboard/analyse
 */

import Link from 'next/link';
import {
  Sparkles,
  Shield,
  CreditCard,
  FileSearch,
  ShieldCheck,
  TrendingUp,
  BarChart3,
  Search,
  Building2,
  Wrench,
  Database,
  Landmark,
} from 'lucide-react';
import { Lock } from 'lucide-react';
import { getEnabledModules } from '@/app/lib/analyseModules';

/**
 * Force dynamic (per-request) rendering (BIZZ-1951).
 *
 * The CSP in proxy.ts uses a per-request `script-src 'nonce-…'`. Next.js can
 * only stamp that nonce onto inline framework scripts when the route is
 * rendered per-request. As a pure static server component this page was
 * prerendered at build time with unnonced scripts, so at runtime every inline
 * script was blocked by CSP and the page never hydrated (stuck on the
 * dashboard "Kontrollerer adgang…" access gate). Forcing dynamic rendering
 * makes Next inject the matching nonce, exactly like the other dashboard
 * routes which are already dynamic via auth/cookies.
 */
export const dynamic = 'force-dynamic';

/** Map fra ikon-streng til Lucide-komponent */
const iconMap: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  Sparkles,
  Shield,
  CreditCard,
  FileSearch,
  ShieldCheck,
  TrendingUp,
  BarChart3,
  Search,
  Building2,
  Landmark,
};

/**
 * Analyse & Tools landing page med 2 sektioner.
 *
 * BIZZ-1988: Når ServerModuleGate afviser et modul (manglende plan-adgang)
 * redirecter den hertil med `?locked=<moduleId>`. Vi viser da et upsell-banner
 * der forklarer hvorfor modulet ikke kunne åbnes.
 *
 * @param props - Next.js searchParams (Promise med valgfri `locked`-modul-id)
 * @returns Landing page JSX
 */
export default async function AnalyseLandingPage({
  searchParams,
}: {
  searchParams: Promise<{ locked?: string }>;
}) {
  const { locked } = await searchParams;
  const enabledModules = getEnabledModules();
  // Slå det afviste modul op for at vise et menneskeligt navn i banneret.
  const lockedModule = locked ? enabledModules.find((m) => m.id === locked) : null;

  return (
    <div className="flex-1 bg-[#0a1628] p-8 overflow-y-auto">
      <h1 className="text-2xl font-bold text-white mb-2">Analyse & Tools</h1>
      <p className="text-slate-400 text-sm mb-8">
        Udforsk data med pivot-tabeller og AI, eller brug specialiserede brancheværktøjer.
      </p>

      {/* BIZZ-1988: Upsell-banner når et modul blev afvist server-side. */}
      {lockedModule && (
        <div
          role="alert"
          className="mb-8 flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4"
        >
          <Lock size={18} className="mt-0.5 shrink-0 text-amber-400" />
          <div>
            <p className="text-sm font-semibold text-amber-300">
              {lockedModule.label} er ikke inkluderet i dit abonnement
            </p>
            <p className="mt-1 text-xs text-slate-300">
              Opgradér din plan eller tilføj modulet som tilkøb for at få adgang.{' '}
              <Link href="/dashboard/settings" className="underline hover:text-amber-300">
                Se abonnement
              </Link>
            </p>
          </div>
        </div>
      )}

      {/* ── Sektion 1: Analyse ── */}
      <div className="mb-10">
        <div className="flex items-center gap-2 mb-4">
          <BarChart3 size={16} className="text-emerald-400" />
          <h2 className="text-base font-semibold text-white">Analyse</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl">
          {/* BIZZ-1431: Data Intelligence (Smart SQL) */}
          <Link
            href="/dashboard/analyse/intelligence"
            className="group bg-slate-800/40 border border-slate-700/40 hover:border-emerald-500/40 rounded-2xl p-5 transition-all hover:bg-slate-800/60"
          >
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 group-hover:scale-105 transition-transform">
                <Database size={18} />
              </div>
              <h3 className="text-sm font-semibold text-white">Data Intelligence</h3>
              <span className="ml-auto text-[10px] font-medium uppercase tracking-wider text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded">
                Ny
              </span>
            </div>
            <p className="text-slate-400 text-xs leading-relaxed">
              Stil ethvert spørgsmål på dansk — AI genererer sikker PostgreSQL mod vores fulde
              datasæt (2,2M virksomheder, 7,6M ejerskaber). Auto-genereret visualisering + valideret
              output.
            </p>
          </Link>
        </div>
      </div>

      {/* ── Sektion 2: Tools ── */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Wrench size={16} className="text-blue-400" />
          <h2 className="text-base font-semibold text-white">Tools</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {enabledModules.map((modul) => {
            const Icon = iconMap[modul.icon] ?? Sparkles;
            const isPro = modul.requiredPlan === 'professionel';
            const isEnt = modul.requiredPlan === 'enterprise';
            const color = isEnt ? 'text-purple-400' : isPro ? 'text-blue-400' : 'text-emerald-400';
            const bg = isEnt ? 'bg-purple-500/10' : isPro ? 'bg-blue-500/10' : 'bg-emerald-500/10';
            const hoverBorder = isEnt
              ? 'hover:border-purple-500/40'
              : isPro
                ? 'hover:border-blue-500/40'
                : 'hover:border-emerald-500/40';

            return (
              <Link
                key={modul.id}
                href={modul.path}
                className={`group bg-slate-800/40 border border-slate-700/40 ${hoverBorder} rounded-2xl p-5 transition-all hover:bg-slate-800/60`}
              >
                <div className="flex items-center gap-3 mb-2">
                  <div
                    className={`p-2 rounded-xl ${bg} ${color} group-hover:scale-105 transition-transform`}
                  >
                    <Icon size={18} />
                  </div>
                  <h3 className="text-sm font-semibold text-white flex-1 truncate">
                    {modul.label}
                  </h3>
                  {modul.requiredPlan && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/5 text-slate-400 font-medium shrink-0">
                      {isEnt ? 'Enterprise' : 'Pro'}
                    </span>
                  )}
                </div>
                <p className="text-slate-400 text-xs leading-relaxed">{modul.description}</p>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
