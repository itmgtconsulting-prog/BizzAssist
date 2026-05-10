/**
 * Analyse landing page — /dashboard/analyse
 *
 * Viser AI Analyse + Data Analyse kort sammen med alle enabled
 * branchespecifikke analyse-moduler i ét samlet grid.
 *
 * @module app/dashboard/analyse
 */

import Link from 'next/link';
import {
  Sparkles,
  Table2,
  Shield,
  CreditCard,
  FileSearch,
  ShieldCheck,
  TrendingUp,
  BarChart3,
  Search,
  Building2,
} from 'lucide-react';
import { getEnabledModules } from '@/app/lib/analyseModules';

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
};

/**
 * Analyse landing page med AI Analyse, Data Analyse og branchemoduler.
 */
export default function AnalyseLandingPage() {
  const enabledModules = getEnabledModules();

  return (
    <div className="flex-1 bg-[#0a1628] p-8 overflow-y-auto">
      <h1 className="text-2xl font-bold text-white mb-2">Analyse</h1>
      <p className="text-slate-400 text-sm mb-8">
        Analysér ejendomme, virksomheder og markedsdata med AI eller pivot-tabeller.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-5xl">
        {/* AI Analyse */}
        <Link
          href="/dashboard/analyse/ai"
          className="group bg-slate-800/40 border border-slate-700/40 hover:border-blue-500/40 rounded-2xl p-5 transition-all hover:bg-slate-800/60"
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-xl bg-blue-500/10 text-blue-400 group-hover:scale-105 transition-transform">
              <Sparkles size={18} />
            </div>
            <h2 className="text-sm font-semibold text-white">AI Analyse</h2>
          </div>
          <p className="text-slate-400 text-xs leading-relaxed line-clamp-2">
            Stil spørgsmål om ejendomme, virksomheder og markedsdata.
          </p>
        </Link>

        {/* Data Analyse */}
        <Link
          href="/dashboard/analyse/data"
          className="group bg-slate-800/40 border border-slate-700/40 hover:border-emerald-500/40 rounded-2xl p-5 transition-all hover:bg-slate-800/60"
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 group-hover:scale-105 transition-transform">
              <Table2 size={18} />
            </div>
            <h2 className="text-sm font-semibold text-white">Data Analyse</h2>
          </div>
          <p className="text-slate-400 text-xs leading-relaxed line-clamp-2">
            Udforsk datasæt med pivot-tabeller, grafer og filtre.
          </p>
        </Link>

        {/* Branchespecifikke analyse-moduler */}
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
                <h2 className="text-sm font-semibold text-white flex-1 truncate">{modul.label}</h2>
                {modul.requiredPlan && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/5 text-slate-500 font-medium shrink-0">
                    {isEnt ? 'Enterprise' : 'Pro'}
                  </span>
                )}
              </div>
              <p className="text-slate-400 text-xs leading-relaxed line-clamp-2">
                {modul.description}
              </p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
