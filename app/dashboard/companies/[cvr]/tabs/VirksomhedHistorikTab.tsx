/**
 * VirksomhedHistorikTab — Historik-fane (virksomhedsændringer over tid).
 * BIZZ-658: Extraheret fra VirksomhedDetaljeClient.tsx.
 * @module app/dashboard/companies/[cvr]/tabs/VirksomhedHistorikTab
 */
'use client';

import Link from 'next/link';
import {
  ArrowRightLeft,
  Briefcase,
  CheckCircle,
  Coins,
  FileSearch,
  Clock,
  ExternalLink,
  Factory,
  MapPin,
  Shield,
  Tag,
} from 'lucide-react';
import { translations } from '@/app/lib/translations';
import type { CVRPublicData } from '@/app/api/cvr-public/route';

function EmptyState({ ikon, tekst }: { ikon: React.ReactNode; tekst: string }) {
  return (
    <div className="text-center py-12">
      <div className="mx-auto mb-3 flex justify-center">{ikon}</div>
      <p className="text-slate-400 text-sm">{tekst}</p>
    </div>
  );
}

/** Historik-type ikoner og farver */
const historikTypeConfig: Record<string, { icon: React.ReactNode; color: string }> = {
  navn: { icon: <Tag size={14} />, color: 'text-blue-400' },
  adresse: { icon: <MapPin size={14} />, color: 'text-emerald-400' },
  form: { icon: <Briefcase size={14} />, color: 'text-purple-400' },
  status: { icon: <CheckCircle size={14} />, color: 'text-amber-400' },
  branche: { icon: <Factory size={14} />, color: 'text-cyan-400' },
  ejerskab: { icon: <Shield size={14} />, color: 'text-orange-400' },
  fusion: { icon: <ArrowRightLeft size={14} />, color: 'text-rose-400' },
  spaltning: { icon: <ArrowRightLeft size={14} />, color: 'text-pink-400' },
  kapital: { icon: <Coins size={14} />, color: 'text-yellow-400' },
  revisor: { icon: <FileSearch size={14} />, color: 'text-teal-400' },
};

interface Props {
  lang: 'da' | 'en';
  data: CVRPublicData;
  historikFilter: string | null;
  setHistorikFilter: React.Dispatch<React.SetStateAction<string | null>>;
}

export default function VirksomhedHistorikTab({
  lang,
  data,
  historikFilter,
  setHistorikFilter,
}: Props) {
  const c = translations[lang].company;

  /** Sorteret historik — nyeste først */
  const sortedHistorik = [...(data.historik ?? [])].sort(
    (a, b) => new Date(b.fra ?? '').getTime() - new Date(a.fra ?? '').getTime()
  );

  /** Gruppér efter type */
  const historikByType = sortedHistorik.reduce<Record<string, typeof sortedHistorik>>(
    (acc, entry) => {
      const type = entry.type ?? 'andet';
      if (!acc[type]) acc[type] = [];
      acc[type].push(entry);
      return acc;
    },
    {}
  );

  return (
    <div className="space-y-4">
      {sortedHistorik.length > 0 ? (
        <>
          {/* Filter-chips */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setHistorikFilter(null)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-all border ${
                historikFilter === null
                  ? 'bg-blue-600/30 border-blue-500/50 text-blue-300'
                  : 'bg-slate-800/50 border-slate-700/40 text-slate-400 hover:text-slate-200 hover:border-slate-600'
              }`}
            >
              {lang === 'da' ? 'Alle' : 'All'} ({sortedHistorik.length})
            </button>
            {Object.entries(historikByType).map(([type, entries]) => {
              const config = historikTypeConfig[type] ?? {
                icon: <Clock size={11} />,
                color: 'text-slate-400',
              };
              const isActive = historikFilter === type;
              return (
                <button
                  key={type}
                  onClick={() => setHistorikFilter(isActive ? null : type)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all border ${
                    isActive
                      ? 'bg-blue-600/30 border-blue-500/50 text-blue-300'
                      : 'bg-slate-800/50 border-slate-700/40 text-slate-400 hover:text-slate-200 hover:border-slate-600'
                  }`}
                >
                  <span className={config.color}>{config.icon}</span>
                  {type.charAt(0).toUpperCase() + type.slice(1)} ({entries.length})
                </button>
              );
            })}
          </div>

          {/* Filtrerede sektioner */}
          {Object.entries(historikByType)
            .filter(([type]) => historikFilter === null || historikFilter === type)
            .map(([type, entries]) => {
              const config = historikTypeConfig[type] ?? {
                icon: <Clock size={14} />,
                color: 'text-slate-400',
              };
              return (
                <section
                  key={type}
                  className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6"
                >
                  <h2 className="text-white font-semibold text-base mb-4 flex items-center gap-2">
                    <span className={config.color}>{config.icon}</span>
                    {type.charAt(0).toUpperCase() + type.slice(1)} ({entries.length})
                  </h2>
                  <div className="relative">
                    {/* Timeline line */}
                    <div className="absolute left-3 top-0 bottom-0 w-px bg-slate-700/40" />
                    <ul className="space-y-3">
                      {entries.map((entry, i) => (
                        <li key={i} className="relative pl-8">
                          {/* Timeline dot */}
                          <div
                            className={`absolute left-1.5 top-2.5 w-3 h-3 rounded-full border-2 border-slate-700 ${
                              entry.til === null ? 'bg-blue-500' : 'bg-slate-600'
                            }`}
                          />
                          <div className="bg-slate-900/50 rounded-lg p-3 border border-slate-700/30">
                            <p className="text-white text-sm font-medium">{entry.vaerdi}</p>
                            <p className="text-slate-500 text-xs mt-1">
                              {c.period}: {entry.fra}
                              {entry.til
                                ? ` — ${entry.til}`
                                : ` — ${lang === 'da' ? 'nu' : 'present'}`}
                            </p>
                            {/* BIZZ-516: Modpart-link for fusion/spaltning — link til owners-siden
                              hvor enhedsNummer kan slås op (fælles namespace for virksomheder og
                              personer i CVR). Giver brugeren en direkte genvej til modparten. */}
                            {(entry.type === 'fusion' || entry.type === 'spaltning') &&
                              entry.modpartEnhedsNummer && (
                                <Link
                                  href={`/dashboard/owners/${entry.modpartEnhedsNummer}`}
                                  className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 mt-2 transition-colors"
                                >
                                  <ExternalLink size={10} />
                                  {lang === 'da' ? 'Se modpart' : 'View counterparty'}{' '}
                                  <span className="font-mono text-slate-500">
                                    (#{entry.modpartEnhedsNummer})
                                  </span>
                                </Link>
                              )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                </section>
              );
            })}
        </>
      ) : (
        <EmptyState ikon={<Clock size={32} className="text-slate-600" />} tekst={c.noHistory} />
      )}
    </div>
  );
}
