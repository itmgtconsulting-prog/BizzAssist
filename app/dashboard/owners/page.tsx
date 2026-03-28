'use client';

/**
 * Owners list page — placeholder/coming-soon state.
 *
 * Mirrors the layout structure of the Ejendomme list page (search header + content area).
 * Denmark has no free public person API, so the search is disabled and a prominent
 * "coming soon" empty state explains the planned feature scope.
 *
 * When owner data becomes available the search input can be enabled and wired up
 * to a backend lookup (CVR person roles, tinglysning, etc.).
 */

import { Search, Users, Building2, Briefcase, Shield } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

/** Feature cards describing what will be possible when owner search launches. */
const FEATURES = [
  {
    icon: Building2,
    da: { title: 'Ejendomsejerskab', desc: 'Se hvilke ejendomme en ejer har eller har haft.' },
    en: { title: 'Property ownership', desc: 'See which properties an owner has or has had.' },
  },
  {
    icon: Briefcase,
    da: {
      title: 'Virksomhedsroller',
      desc: 'Find roller som direktør, ejer eller stifter i danske virksomheder.',
    },
    en: {
      title: 'Company roles',
      desc: 'Find roles as CEO, owner or founder in Danish companies.',
    },
  },
  {
    icon: Shield,
    da: {
      title: 'Bestyrelsesposter',
      desc: 'Overblik over bestyrelsesmedlemskaber på tværs af selskaber.',
    },
    en: { title: 'Board memberships', desc: 'Overview of board memberships across companies.' },
  },
] as const;

/**
 * Owners list page component.
 *
 * Renders a disabled search bar and a "coming soon" empty state with feature previews.
 * Fully bilingual (DA/EN) via useLanguage().
 */
export default function OwnersListPage() {
  const { lang } = useLanguage();
  const da = lang === 'da';

  return (
    <div className="flex-1 flex flex-col bg-[#0a1628]">
      {/* ─── Header ─── */}
      <div className="px-8 pt-8 pb-6 border-b border-slate-700/40">
        <h1 className="text-2xl font-bold text-purple-400 mb-1">{da ? 'Ejere' : 'Owners'}</h1>
        <p className="text-slate-400 text-sm">
          {da
            ? 'Søg efter ejere og se deres ejendomme, virksomheder og roller'
            : 'Search for owners and see their properties, companies and roles'}
        </p>

        {/* Search bar — disabled placeholder */}
        <div className="relative mt-5">
          <div className="relative">
            <Search
              size={18}
              className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
            />
            <input
              type="text"
              disabled
              placeholder={
                da ? 'Søg på ejernavn (kommer snart)…' : 'Search by owner name (coming soon)…'
              }
              className="w-full bg-slate-800/40 border border-slate-600/30 rounded-2xl pl-11 pr-12 py-4 text-white placeholder:text-slate-600 outline-none text-base shadow-lg cursor-not-allowed opacity-60"
            />
          </div>
        </div>
      </div>

      {/* ─── Content ─── */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {/* Coming soon empty state */}
        <div className="flex flex-col items-center justify-center py-16 text-center gap-4">
          <div className="p-5 bg-purple-600/10 rounded-2xl">
            <Users size={36} className="text-purple-400" />
          </div>
          <div>
            <p className="text-white text-lg font-semibold mb-1">
              {da ? 'Kommer snart' : 'Coming soon'}
            </p>
            <p className="text-slate-400 text-sm max-w-md leading-relaxed">
              {da
                ? 'Ejersøgning er under udvikling. Du vil snart kunne søge efter ejere og se deres ejendomme, virksomheder og roller.'
                : "Owner search is under development. Soon you'll be able to search for owners and see their properties, companies and roles."}
            </p>
          </div>
        </div>

        {/* Feature preview cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            const t = da ? f.da : f.en;
            return (
              <div
                key={t.title}
                className="bg-slate-800/40 border border-slate-700/40 rounded-2xl p-5 flex flex-col gap-3"
              >
                <div className="p-2 rounded-xl text-purple-400 bg-purple-400/10 w-fit">
                  <Icon size={18} />
                </div>
                <div>
                  <p className="text-white font-semibold text-sm">{t.title}</p>
                  <p className="text-slate-400 text-xs mt-1 leading-relaxed">{t.desc}</p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Info banner — matches ejendomme page style */}
        <div className="mt-8 flex items-start gap-3 bg-purple-600/8 border border-purple-500/20 rounded-2xl px-5 py-4">
          <Users size={18} className="text-purple-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-purple-300 text-sm font-medium">
              {da ? 'Ejerdata kræver særlig adgang' : 'Owner data requires special access'}
            </p>
            <p className="text-slate-400 text-xs mt-0.5 leading-relaxed">
              {da
                ? 'Opslag i ejerregistre og personroller kræver godkendelse fra relevante myndigheder. Vi arbejder på at etablere de nødvendige aftaler.'
                : 'Lookups in owner registries and person roles require approval from the relevant authorities. We are working on establishing the necessary agreements.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
