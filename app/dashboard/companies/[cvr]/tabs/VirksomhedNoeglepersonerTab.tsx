/**
 * VirksomhedNoeglepersonerTab — Nøglepersoner-fane (ejere, bestyrelse, direktion, revision).
 * BIZZ-658: Extraheret fra VirksomhedDetaljeClient.tsx.
 * @module app/dashboard/companies/[cvr]/tabs/VirksomhedNoeglepersonerTab
 */
'use client';

import { useRouter } from 'next/navigation';
import {
  Building2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Percent,
  Shield,
  Tag,
  Users,
} from 'lucide-react';
import { translations } from '@/app/lib/translations';
import type { PersonMedRolle } from './VirksomhedOverblikTab';

/** Formaterer ISO-dato til kort dansk format (d. mmm yyyy). */
function formatDatoKort(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' });
}

function EmptyState({ ikon, tekst }: { ikon: React.ReactNode; tekst: string }) {
  return (
    <div className="text-center py-12">
      <div className="mx-auto mb-3 flex justify-center">{ikon}</div>
      <p className="text-slate-400 text-sm">{tekst}</p>
    </div>
  );
}

interface Props {
  lang: 'da' | 'en';
  personerByKategori: Record<string, { aktive: PersonMedRolle[]; historiske: PersonMedRolle[] }>;
  sorteredeKategorier: string[];
  personerFilter: string | null;
  setPersonerFilter: React.Dispatch<React.SetStateAction<string | null>>;
  expandedHistPersoner: Set<string>;
  setExpandedHistPersoner: React.Dispatch<React.SetStateAction<Set<string>>>;
  visAlleHistPersoner: Set<string>;
  setVisAlleHistPersoner: React.Dispatch<React.SetStateAction<Set<string>>>;
}

export default function VirksomhedNoeglepersonerTab({
  lang,
  personerByKategori,
  sorteredeKategorier,
  personerFilter,
  setPersonerFilter,
  expandedHistPersoner,
  setExpandedHistPersoner,
  visAlleHistPersoner,
  setVisAlleHistPersoner,
}: Props) {
  const c = translations[lang].company;
  const router = useRouter();
  const da = lang === 'da';

  const kategoriLabel = (kat: string): string => {
    const map: Record<string, string> = {
      EJER: da ? 'Ejere' : 'Owners',
      BESTYRELSE: da ? 'Bestyrelse' : 'Board',
      STIFTER: da ? 'Stiftere' : 'Founders',
      REVISION: da ? 'Revision' : 'Auditors',
      DIREKTION: da ? 'Direktion' : 'Management',
      ANDET: da ? 'Øvrige' : 'Other',
    };
    return map[kat] ?? kat;
  };

  const kategoriIkon = (kat: string): React.ReactNode => {
    const map: Record<string, React.ReactNode> = {
      EJER: <Shield size={16} className="text-emerald-400" />,
      BESTYRELSE: <Users size={16} className="text-blue-400" />,
      STIFTER: <Tag size={16} className="text-purple-400" />,
      REVISION: <ExternalLink size={16} className="text-amber-400" />,
      DIREKTION: <Building2 size={16} className="text-indigo-400" />,
    };
    return map[kat] ?? <Users size={16} className="text-slate-400" />;
  };

  return (
    <div className="space-y-4">
      {sorteredeKategorier.length > 0 ? (
        <>
          {/* Filter-chips */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setPersonerFilter(null)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-all border ${
                personerFilter === null
                  ? 'bg-blue-600/30 border-blue-500/50 text-blue-300'
                  : 'bg-slate-800/50 border-slate-700/40 text-slate-400 hover:text-slate-200 hover:border-slate-600'
              }`}
            >
              {lang === 'da' ? 'Alle' : 'All'}
            </button>
            {sorteredeKategorier.map((kat) => {
              const { aktive, historiske } = personerByKategori[kat];
              const isActive = personerFilter === kat;
              return (
                <button
                  key={kat}
                  onClick={() => setPersonerFilter(isActive ? null : kat)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all border ${
                    isActive
                      ? 'bg-blue-600/30 border-blue-500/50 text-blue-300'
                      : 'bg-slate-800/50 border-slate-700/40 text-slate-400 hover:text-slate-200 hover:border-slate-600'
                  }`}
                >
                  {kategoriIkon(kat)}
                  {kategoriLabel(kat)} ({aktive.length + historiske.length})
                </button>
              );
            })}
          </div>

          {sorteredeKategorier
            .filter((k) => personerFilter === null || personerFilter === k)
            .map((kat) => {
              const { aktive, historiske } = personerByKategori[kat];
              const erUdfoldet = expandedHistPersoner.has(kat);
              const totalAktive = aktive.length;
              const totalHistoriske = historiske.length;

              /** Renderer en person-række */
              const renderPerson = (entry: PersonMedRolle, idx: number, dimmed: boolean) => {
                const { deltager: person, rolle: r } = entry;
                const initialer = person.navn
                  .split(' ')
                  .map((n) => n[0])
                  .slice(0, 2)
                  .join('')
                  .toUpperCase();

                return (
                  <li
                    key={`${person.enhedsNummer ?? idx}-${r.rolle}-${r.fra}`}
                    className={`flex items-center justify-between gap-3 text-sm bg-slate-900/50 rounded-lg px-4 py-3 hover:bg-slate-800/60 transition-colors ${
                      person.enhedsNummer ? 'cursor-pointer' : ''
                    } group ${dimmed ? 'opacity-60' : ''}`}
                    onClick={() => {
                      if (person.enhedsNummer) {
                        if (person.erVirksomhed) {
                          router.push(`/dashboard/companies/${person.enhedsNummer}`);
                        } else {
                          router.push(`/dashboard/owners/${person.enhedsNummer}`);
                        }
                      }
                    }}
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      {/* Avatar — blå for virksomheder, slate for personer */}
                      <span
                        className={`w-7 h-7 rounded-full text-xs font-medium flex items-center justify-center flex-shrink-0 ${
                          person.erVirksomhed
                            ? 'bg-blue-600/30 text-blue-400'
                            : 'bg-slate-700/50 text-slate-300'
                        }`}
                      >
                        {person.erVirksomhed ? <Building2 size={13} /> : initialer}
                      </span>
                      {/* Navn + periode */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`truncate text-white transition-colors ${person.erVirksomhed ? 'group-hover:text-blue-300' : 'group-hover:text-purple-300'}`}
                          >
                            {person.navn}
                          </span>
                          {person.enhedsNummer && (
                            <ExternalLink
                              size={11}
                              className={`transition-colors flex-shrink-0 ${person.erVirksomhed ? 'text-slate-600 group-hover:text-blue-400' : 'text-slate-600 group-hover:text-purple-400'}`}
                            />
                          )}
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {r.fra ? formatDatoKort(r.fra) : '?'} —{' '}
                          {r.til ? formatDatoKort(r.til) : lang === 'da' ? 'nu' : 'present'}
                          {r.rolle && <span className="ml-2 text-slate-600">({r.rolle})</span>}
                        </p>
                      </div>
                    </div>
                    {/* Ejerandel + stemmeret badges */}
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {r.ejerandel != null && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/15 text-emerald-400">
                          <Percent size={10} />
                          {r.ejerandel} {lang === 'da' ? 'ejerandel' : 'ownership'}
                        </span>
                      )}
                      {r.stemmeandel != null && r.stemmeandel !== r.ejerandel && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-blue-500/15 text-blue-400">
                          {r.stemmeandel} {lang === 'da' ? 'stemmer' : 'votes'}
                        </span>
                      )}
                      {r.bemærkning && (
                        <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-700/50 text-slate-300">
                          {r.bemærkning}
                        </span>
                      )}
                    </div>
                  </li>
                );
              };

              return (
                <section
                  key={kat}
                  className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5"
                >
                  {/* Sektion-header */}
                  <h2 className="text-white font-semibold text-base mb-3 flex items-center gap-2">
                    {kategoriIkon(kat)}
                    {kategoriLabel(kat)}
                    <span className="text-slate-500 font-normal text-sm ml-1">
                      ({totalAktive}
                      {totalHistoriske > 0
                        ? ` + ${totalHistoriske} ${lang === 'da' ? 'historiske' : 'historical'}`
                        : ''}
                      )
                    </span>
                  </h2>

                  {/* Aktive deltagere */}
                  {totalAktive > 0 && (
                    <ul className="space-y-2">
                      {aktive.map((entry, i) => renderPerson(entry, i, false))}
                    </ul>
                  )}

                  {/* Historiske deltagere — collapsible med "vis flere" */}
                  {totalHistoriske > 0 &&
                    (() => {
                      const INITIAL_HIST = 5;
                      const visAlle = visAlleHistPersoner.has(kat);
                      const vistHistoriske = visAlle
                        ? historiske
                        : historiske.slice(0, INITIAL_HIST);
                      const skjulteAntal = totalHistoriske - INITIAL_HIST;
                      return (
                        <div className={totalAktive > 0 ? 'mt-3' : ''}>
                          <button
                            onClick={() =>
                              setExpandedHistPersoner((prev) => {
                                const next = new Set(prev);
                                if (next.has(kat)) next.delete(kat);
                                else next.add(kat);
                                return next;
                              })
                            }
                            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors mb-2"
                          >
                            {erUdfoldet ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            {lang === 'da'
                              ? `${totalHistoriske} historiske`
                              : `${totalHistoriske} historical`}
                          </button>
                          {erUdfoldet && (
                            <>
                              <ul className="space-y-2">
                                {vistHistoriske.map((entry, i) => renderPerson(entry, i, true))}
                              </ul>
                              {!visAlle && skjulteAntal > 0 && (
                                <button
                                  onClick={() =>
                                    setVisAlleHistPersoner((prev) => {
                                      const next = new Set(prev);
                                      next.add(kat);
                                      return next;
                                    })
                                  }
                                  className="mt-2 flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                                >
                                  <ChevronDown size={12} />
                                  {lang === 'da'
                                    ? `Vis ${skjulteAntal} flere historiske`
                                    : `Show ${skjulteAntal} more historical`}
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })()}

                  {/* Ingen aktive, men har historiske */}
                  {totalAktive === 0 && !erUdfoldet && (
                    <p className="text-slate-500 text-sm">
                      {lang === 'da' ? 'Ingen aktive' : 'No active members'}
                    </p>
                  )}
                </section>
              );
            })}
        </>
      ) : (
        <EmptyState ikon={<Users size={32} className="text-slate-600" />} tekst={c.noKeyPersons} />
      )}
    </div>
  );
}
