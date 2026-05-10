/**
 * VirksomhedTinglysningTab — Tinglysning-fane på virksomhedsdetaljesiden.
 *
 * Viser: Personbog (hæftelser), Bilbog, Andelsbog, Fast ejendom (kreditor).
 * Inkl. PersonbogSection med farvekodede sektioner og dokument-download.
 *
 * BIZZ-1229: Extraheret fra VirksomhedDetaljeClient.tsx.
 *
 * @module app/dashboard/companies/[cvr]/tabs/VirksomhedTinglysningTab
 */

'use client';

import React from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Loader2,
  MapPin,
  Scale,
} from 'lucide-react';
import TabLoadingSpinner from '@/app/components/TabLoadingSpinner';
import PaategningTimeline from '@/app/components/tinglysning/PaategningTimeline';
import { translations } from '@/app/lib/translations';
import type { PersonbogHaeftelse, PersonbogDokument } from '@/app/api/tinglysning/personbog/route';
import type { VirksomhedEjendomsrolle } from '@/app/api/tinglysning/virksomhed/route';
import type { BilbogBil } from '@/app/api/tinglysning/bilbog/route';
import type { AndelsbogBolig } from '@/app/api/tinglysning/andelsbog/route';

// ─── Helper Functions ───────────────────────────────────────────────────────

/**
 * Formaterer ISO-dato til kort dansk format (d. mmm yyyy).
 *
 * @param iso - ISO-dato streng
 * @returns Formateret dato-streng
 */
function formatDatoKort(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Typekonfig for farvekodede personbog-sektioner */
const personbogSektioner: {
  key: string;
  color: string;
  bgClass: string;
  textClass: string;
  borderClass: string;
}[] = [
  {
    key: 'virksomhedspant',
    color: 'amber',
    bgClass: 'bg-amber-500/5',
    textClass: 'text-amber-400',
    borderClass: 'border-amber-500/20',
  },
  {
    key: 'loesoerepant',
    color: 'teal',
    bgClass: 'bg-teal-500/5',
    textClass: 'text-teal-400',
    borderClass: 'border-teal-500/20',
  },
  {
    key: 'fordringspant',
    color: 'cyan',
    bgClass: 'bg-cyan-500/5',
    textClass: 'text-cyan-400',
    borderClass: 'border-cyan-500/20',
  },
  {
    key: 'ejendomsforbehold',
    color: 'purple',
    bgClass: 'bg-purple-500/5',
    textClass: 'text-purple-400',
    borderClass: 'border-purple-500/20',
  },
];

/** Oversætter personbog-typenøgler til UI-labels */
function personbogTypeLabel(key: string, c: (typeof translations)['da']['company']): string {
  const map: Record<string, string> = {
    virksomhedspant: c.personbogVirksomhedspant,
    loesoerepant: c.personbogLoesoerepant,
    fordringspant: c.personbogFordringspant,
    ejendomsforbehold: c.personbogEjendomsforbehold,
  };
  return map[key] ?? key;
}

/** Oversætter pantomfang-nøgler til UI-labels */
function pantOmfangLabel(key: string, c: (typeof translations)['da']['company']): string {
  const lower = key.toLowerCase();
  if (lower.includes('varelager')) return c.personbogVarelager;
  if (lower.includes('driftsinventar') || lower.includes('driftsmateriel'))
    return c.personbogDriftsinventar;
  if (lower.includes('fordring')) return c.personbogFordringer;
  if (lower.includes('immateriel')) return c.personbogImmaterielleRettigheder;
  return key;
}

// ─── PersonbogSection ───────────────────────────────────────────────────────

/** Props for PersonbogSection sub-component */
interface PersonbogSectionProps {
  /** Hæftelse-data fra Personbogen */
  haeftelser: PersonbogHaeftelse[];
  /** Om data stadig indlæses */
  loading: boolean;
  /** Fejlbesked, null hvis ingen fejl */
  fejl: string | null;
  /** Oversættelser */
  c: (typeof translations)['da']['company'];
  /** Om sproget er dansk */
  da: boolean;
  /** Sæt af ekspanderede pant-indekser */
  expandedPant: Set<number>;
  /** Setter for expandedPant */
  setExpandedPant: React.Dispatch<React.SetStateAction<Set<number>>>;
  /** Sæt af valgte dokument-IDs til download */
  selectedPantDocs: Set<string>;
  /** Setter for selectedPantDocs */
  setSelectedPantDocs: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** BIZZ-533: Tinglyste dokumenter (vedtægter/fusioner/ejerpantebreve) */
  dokumenter?: {
    vedtaegter: PersonbogDokument[];
    fusioner: PersonbogDokument[];
    ejerpantebreve: PersonbogDokument[];
  };
}

/**
 * PersonbogSection — Viser personbogshæftelser for en virksomhed.
 * Farvekodede sektioner grupperet efter type: Virksomhedspant, Løsørepant,
 * Fordringspant, Ejendomsforbehold. Matcher tinglysning-tab-designet fra ejendomssiden.
 *
 * @param props - Se PersonbogSectionProps
 */
function PersonbogSection({
  haeftelser,
  loading,
  fejl,
  c,
  da,
  expandedPant,
  setExpandedPant,
  selectedPantDocs,
  setSelectedPantDocs,
  dokumenter,
}: PersonbogSectionProps) {
  /** Loading state — inline compact (vises inde i den ekspanderede personbog-række) */
  if (loading) {
    return (
      <div className="flex items-center gap-2 px-4 py-3">
        <Loader2 size={14} className="text-blue-400 animate-spin flex-shrink-0" />
        <p className="text-slate-400 text-xs">{c.loadingPersonbog}</p>
      </div>
    );
  }

  /** Error state — inline compact */
  if (fejl) {
    return (
      <div className="flex items-center gap-2 px-4 py-3">
        <AlertTriangle size={14} className="text-amber-400 flex-shrink-0" />
        <p className="text-slate-400 text-xs">{fejl}</p>
      </div>
    );
  }

  /** Empty state — compact single line */
  if (haeftelser.length === 0) {
    return <p className="text-slate-500 text-xs px-4 py-3 italic">{c.personbogEmpty}</p>;
  }

  /** Gruppér hæftelser efter type */
  const grouped: Record<string, PersonbogHaeftelse[]> = {};
  for (const h of haeftelser) {
    const key = h.type;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(h);
  }

  /** Selectérbare dokumenter */
  const allDocs = haeftelser.filter((h) => h.dokumentId).map((h) => h.dokumentId!);

  const toggleExpand = (idx: number) => {
    setExpandedPant((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const toggleDoc = (id: string) => {
    setSelectedPantDocs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const _toggleAllDocs = () => {
    if (selectedPantDocs.size === allDocs.length) {
      setSelectedPantDocs(new Set());
    } else {
      setSelectedPantDocs(new Set(allDocs));
    }
  };

  /** Globalt indeks over hæftelser — bruges til expand-toggle */
  let globalIdx = 0;

  return (
    <>
      {/* Kolonneoverskrifter */}
      <div className="grid grid-cols-[24px_36px_90px_1fr_100px_100px_50px_28px] gap-x-2 px-4 py-1.5 border-b border-slate-700/20">
        <span />
        <span className="text-[10px] font-medium text-slate-500 uppercase">Pri.</span>
        <span className="text-[10px] font-medium text-slate-500 uppercase">
          {da ? 'Dato' : 'Date'}
        </span>
        <span className="text-[10px] font-medium text-slate-500 uppercase">
          {da ? 'Dokument' : 'Document'}
        </span>
        <span className="text-[10px] font-medium text-slate-500 uppercase">
          {da ? 'Beløb' : 'Amount'}
        </span>
        <span className="text-[10px] font-medium text-slate-500 uppercase">Type</span>
        <span className="text-[10px] font-medium text-slate-500 uppercase">
          {da ? 'Dok.' : 'Doc.'}
        </span>
        <span />
      </div>

      {/* Farvekodede sektioner */}
      {personbogSektioner.map(({ key, bgClass, textClass, borderClass }) => {
        const items = grouped[key];
        if (!items || items.length === 0) return null;

        return (
          <div key={key}>
            {/* Sektionsheader — matcher ejendomssiden */}
            <div className={`${bgClass} px-4 py-1.5 border-b border-slate-700/20`}>
              <span className={`text-[10px] font-semibold ${textClass} uppercase tracking-wider`}>
                {personbogTypeLabel(key, c)} ({items.length})
              </span>
            </div>

            {/* Rækker */}
            {items.map((h) => {
              const idx = globalIdx++;
              const isExpanded = expandedPant.has(idx);
              return (
                <div key={idx}>
                  {/* Kollapset række — matcher ejendomssiden */}
                  <div
                    className="grid grid-cols-[24px_36px_90px_1fr_100px_100px_50px_28px] gap-x-2 px-4 py-2 hover:bg-slate-700/10 transition-colors items-center cursor-pointer border-b border-slate-700/15"
                    onClick={() => toggleExpand(idx)}
                  >
                    {isExpanded ? (
                      <ChevronDown size={12} className="text-slate-500" />
                    ) : (
                      <ChevronRight size={12} className="text-slate-500" />
                    )}
                    <span className="text-xs text-slate-400 tabular-nums">
                      {String(h.prioritet ?? '')}
                    </span>
                    <span className="text-xs text-slate-400 tabular-nums whitespace-nowrap">
                      {h.tinglysningsdato ? formatDatoKort(h.tinglysningsdato) : ''}
                    </span>
                    <div className="min-w-0">
                      <span className="text-sm text-slate-200 truncate block">
                        {personbogTypeLabel(h.type, c)}
                      </span>
                      {h.debitorer.length > 0 && (
                        <span className="text-[10px] text-slate-500 truncate block">
                          {h.debitorer.join(', ')}
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-slate-300 tabular-nums text-right">
                      {h.hovedstol != null && h.hovedstol > 0
                        ? `${h.hovedstol.toLocaleString('da-DK')} ${h.valuta}`
                        : ''}
                    </span>
                    <span className="text-xs text-slate-400 truncate">
                      {String(h.kreditor ?? '')}
                    </span>
                    <div
                      className="flex items-center gap-1.5"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      {h.dokumentId && (
                        <a
                          href={`/api/tinglysning/dokument?uuid=${h.dokumentId}`}
                          download
                          className="inline-flex items-center gap-0.5 text-xs text-blue-400 hover:text-blue-300"
                        >
                          <FileText size={11} />
                          PDF
                        </a>
                      )}
                    </div>
                    {h.dokumentId ? (
                      <label
                        className="flex items-center cursor-pointer flex-shrink-0"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={selectedPantDocs.has(h.dokumentId)}
                          onChange={() => toggleDoc(h.dokumentId!)}
                        />
                        <span
                          className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${selectedPantDocs.has(h.dokumentId) ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                        >
                          {selectedPantDocs.has(h.dokumentId) && (
                            <svg
                              viewBox="0 0 10 10"
                              className="w-2 h-2 text-white"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                            >
                              <path d="M1.5 5.5l2.5 2.5 4.5-4.5" />
                            </svg>
                          )}
                        </span>
                      </label>
                    ) : (
                      <span />
                    )}
                  </div>

                  {/* Expanderet detalje-panel — matcher ejendomssiden */}
                  {isExpanded && (
                    <div className={`px-4 pb-3 ml-10 border-l-2 ${borderClass}`}>
                      {/* Omfang-badges (virksomhedspant) */}
                      {h.pantTyper.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-3">
                          {h.pantTyper.map((p, pi) => (
                            <span
                              key={pi}
                              className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${bgClass} ${textClass}`}
                            >
                              {pantOmfangLabel(p, c)}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Detalje-grid */}
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 text-xs mt-1">
                        {/* Kreditor */}
                        {h.kreditor && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogKreditor}
                            </p>
                            <p className="text-white">
                              {h.kreditorCvr ? (
                                <Link
                                  href={`/dashboard/companies/${h.kreditorCvr}`}
                                  className="text-blue-400 hover:underline"
                                >
                                  {h.kreditor}
                                </Link>
                              ) : (
                                h.kreditor
                              )}
                            </p>
                          </div>
                        )}

                        {/* Debitor(er) */}
                        {h.debitorer.length > 0 && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogDebitor}
                            </p>
                            {h.debitorer.map((d, di) => (
                              <p key={di} className="text-white">
                                {h.debitorCvr[di] ? (
                                  <Link
                                    href={`/dashboard/companies/${h.debitorCvr[di]}`}
                                    className="text-blue-400 hover:underline"
                                  >
                                    {d}
                                  </Link>
                                ) : (
                                  d
                                )}
                              </p>
                            ))}
                          </div>
                        )}

                        {/* Hovedstol */}
                        {h.hovedstol != null && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogHovedstol}
                            </p>
                            <p className="text-white">
                              {h.hovedstol.toLocaleString('da-DK')} {h.valuta}
                            </p>
                          </div>
                        )}

                        {/* Rente */}
                        {h.rente != null && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogRente}
                            </p>
                            <p className="text-white">
                              {h.rente}% {h.renteType ? `(${h.renteType})` : ''}
                            </p>
                          </div>
                        )}

                        {/* BIZZ-532: Referencerente + tillaeg */}
                        {h.referenceRenteNavn && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {da ? 'Referencerente' : 'Reference rate'}
                            </p>
                            <p className="text-white">
                              {h.referenceRenteNavn}
                              {h.referenceRenteSats != null && ` (${h.referenceRenteSats}%)`}
                              {h.renteTillaeg != null && ` + ${h.renteTillaeg}%`}
                            </p>
                          </div>
                        )}

                        {/* BIZZ-532: Kreditorbetegnelse */}
                        {h.kreditorbetegnelse && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {da ? 'Kreditorbetegnelse' : 'Creditor designation'}
                            </p>
                            <p className="text-white">{h.kreditorbetegnelse}</p>
                          </div>
                        )}

                        {/* BIZZ-532: Laantype + pantebrevformular */}
                        {(h.laantype || h.pantebrevFormular) && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {da ? 'Låntype' : 'Loan type'}
                            </p>
                            <p className="text-white">
                              {[h.laantype, h.pantebrevFormular].filter(Boolean).join(' · ')}
                            </p>
                          </div>
                        )}

                        {/* Tinglysningsdato */}
                        {h.tinglysningsdato && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogTinglysningsdato}
                            </p>
                            <p className="text-white">{formatDatoKort(h.tinglysningsdato)}</p>
                          </div>
                        )}

                        {/* Registreringsdato */}
                        {h.registreringsdato && h.registreringsdato !== h.tinglysningsdato && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogRegistreringsdato}
                            </p>
                            <p className="text-white">{formatDatoKort(h.registreringsdato)}</p>
                          </div>
                        )}

                        {/* Tinglysningsafgift */}
                        {h.tinglysningsafgift != null && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogTinglysningsafgift}
                            </p>
                            <p className="text-white">
                              {h.tinglysningsafgift.toLocaleString('da-DK')} DKK
                            </p>
                          </div>
                        )}

                        {/* Loebetid */}
                        {h.loebetid && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogLoebetid}
                            </p>
                            <p className="text-white">{h.loebetid}</p>
                          </div>
                        )}

                        {/* Dokumentalias */}
                        {h.dokumentAlias && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {da ? 'Dokument' : 'Document'}
                            </p>
                            <p className="text-white text-[11px]">{h.dokumentAlias}</p>
                          </div>
                        )}
                      </div>

                      {/* Vilkaar */}
                      {h.vilkaar && (
                        <div className="mt-2 pt-2 border-t border-slate-700/20">
                          <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                            {c.personbogVilkaar}
                          </p>
                          <p className="text-slate-300 text-xs mt-0.5 whitespace-pre-line">
                            {h.vilkaar}
                          </p>
                        </div>
                      )}

                      {/* Anmelder */}
                      {h.anmelderNavn && (
                        <div className="mt-2 pt-2 border-t border-slate-700/20">
                          <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                            {c.personbogAnmelder}
                          </p>
                          <p className="text-white text-xs">
                            {h.anmelderCvr ? (
                              <Link
                                href={`/dashboard/companies/${h.anmelderCvr}`}
                                className="text-blue-400 hover:underline"
                              >
                                {h.anmelderNavn}
                              </Link>
                            ) : (
                              h.anmelderNavn
                            )}
                          </p>
                        </div>
                      )}

                      {/* BIZZ-522: revisionshistorik (paategninger) pr. dokument */}
                      {h.dokumentId && (
                        <div className="mt-2 pt-2 border-t border-slate-700/20">
                          <PaategningTimeline dokumentId={h.dokumentId} lang={da ? 'da' : 'en'} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {/* Oevrige haeftelser (ukendte typer) */}
      {(() => {
        const knownKeys = personbogSektioner.map((s) => s.key);
        const oevrige = Object.entries(grouped).filter(([key]) => !knownKeys.includes(key));
        if (oevrige.length === 0) return null;

        return oevrige.map(([key, items]) => (
          <div key={key}>
            <div className="bg-slate-500/5 px-4 py-1.5 border-b border-slate-700/20">
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                {c.personbogOevrige}: {key} ({items.length})
              </span>
            </div>
            {items.map((h) => {
              const idx = globalIdx++;
              const isExpanded = expandedPant.has(idx);
              const docId = String(h.dokumentId ?? '');
              return (
                <div key={idx} className="border-b border-slate-700/15">
                  <div
                    className="grid grid-cols-[24px_36px_90px_1fr_100px_100px_50px_28px] gap-x-2 px-4 py-2 hover:bg-slate-700/10 transition-colors items-center cursor-pointer"
                    onClick={() => toggleExpand(idx)}
                  >
                    {isExpanded ? (
                      <ChevronDown size={12} className="text-slate-500" />
                    ) : (
                      <ChevronRight size={12} className="text-slate-500" />
                    )}
                    <span className="text-xs text-slate-400 tabular-nums">
                      {String(h.prioritet ?? '')}
                    </span>
                    <span className="text-xs text-slate-400 tabular-nums whitespace-nowrap">
                      {h.tinglysningsdato ? formatDatoKort(h.tinglysningsdato) : ''}
                    </span>
                    <span className="text-sm text-slate-200 truncate">{key}</span>
                    <span className="text-xs text-slate-300 tabular-nums text-right">
                      {h.hovedstol != null && h.hovedstol > 0
                        ? `${h.hovedstol.toLocaleString('da-DK')} ${h.valuta}`
                        : ''}
                    </span>
                    <span className="text-xs text-slate-400 truncate">
                      {String(h.kreditor ?? '')}
                    </span>
                    <div
                      className="flex items-center gap-1.5"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      {docId && (
                        <a
                          href={`/api/tinglysning/dokument?uuid=${docId}`}
                          download
                          className="inline-flex items-center gap-0.5 text-xs text-blue-400 hover:text-blue-300"
                        >
                          <FileText size={11} /> PDF
                        </a>
                      )}
                    </div>
                    {docId ? (
                      <label
                        className="flex items-center cursor-pointer flex-shrink-0"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={selectedPantDocs.has(docId)}
                          onChange={() => toggleDoc(docId)}
                        />
                        <span
                          className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${selectedPantDocs.has(docId) ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                        >
                          {selectedPantDocs.has(docId) && (
                            <svg
                              viewBox="0 0 10 10"
                              className="w-2 h-2 text-white"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                            >
                              <path d="M1.5 5.5l2.5 2.5 4.5-4.5" />
                            </svg>
                          )}
                        </span>
                      </label>
                    ) : (
                      <span />
                    )}
                  </div>
                  {isExpanded && (
                    <div className="px-4 pb-3 ml-10 border-l-2 border-slate-500/20">
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 text-xs mt-1">
                        {h.kreditor && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogKreditor}
                            </p>
                            <p className="text-white">{h.kreditor}</p>
                          </div>
                        )}
                        {h.hovedstol != null && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogHovedstol}
                            </p>
                            <p className="text-white">
                              {h.hovedstol.toLocaleString('da-DK')} {h.valuta}
                            </p>
                          </div>
                        )}
                        {h.tinglysningsdato && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {c.personbogTinglysningsdato}
                            </p>
                            <p className="text-white">{formatDatoKort(h.tinglysningsdato)}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ));
      })()}

      {/* BIZZ-533: Tinglyste dokumenter (vedtaegter, fusioner, ejerpantebreve) */}
      {dokumenter &&
        (dokumenter.vedtaegter.length > 0 ||
          dokumenter.fusioner.length > 0 ||
          dokumenter.ejerpantebreve.length > 0) && (
          <div className="px-4 py-3 border-t border-slate-700/20 space-y-2">
            <p className="text-slate-500 text-[10px] uppercase tracking-wider font-semibold">
              {da ? 'Øvrige tinglyste dokumenter' : 'Other registered documents'}
            </p>
            {dokumenter.vedtaegter.length > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-400">
                  {da ? 'Vedtægter' : 'Articles of association'}:
                </span>
                <span className="text-white font-medium">{dokumenter.vedtaegter.length}</span>
                <span className="text-slate-500">
                  {dokumenter.vedtaegter
                    .map((d) => d.tinglysningsdato)
                    .filter(Boolean)
                    .slice(0, 3)
                    .join(', ')}
                </span>
              </div>
            )}
            {dokumenter.fusioner.length > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-400">
                  {da ? 'Fusioner/spaltninger' : 'Mergers/demergers'}:
                </span>
                <span className="text-white font-medium">{dokumenter.fusioner.length}</span>
                <span className="text-slate-500">
                  {dokumenter.fusioner
                    .map((d) => d.tinglysningsdato)
                    .filter(Boolean)
                    .slice(0, 3)
                    .join(', ')}
                </span>
              </div>
            )}
            {dokumenter.ejerpantebreve.length > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-400">
                  {da ? 'Ejerpantebreve i løsøre' : 'Owner mortgage in chattels'}:
                </span>
                <span className="text-white font-medium">{dokumenter.ejerpantebreve.length}</span>
                <span className="text-slate-500">
                  {dokumenter.ejerpantebreve
                    .map((d) => d.tinglysningsdato)
                    .filter(Boolean)
                    .slice(0, 3)
                    .join(', ')}
                </span>
              </div>
            )}
          </div>
        )}
    </>
  );
}

// ─── VirksomhedTinglysningTab ───────────────────────────────────────────────

/** Props for VirksomhedTinglysningTab */
interface VirksomhedTinglysningTabProps {
  /** Sprog — da eller en */
  lang: 'da' | 'en';

  // ── Personbog ──
  /** Personbog-haeftelser */
  personbogData: PersonbogHaeftelse[];
  /** Om personbogsdata indlaeses */
  personbogLoading: boolean;
  /** Fejlbesked fra personbog-fetch */
  personbogFejl: string | null;
  /** BIZZ-533: Tinglyste dokumenter fra Personbog */
  personbogDokumenter: {
    vedtaegter: PersonbogDokument[];
    fusioner: PersonbogDokument[];
    ejerpantebreve: PersonbogDokument[];
  };
  /** Om Personbogen-raekken er udfoldet */
  personbogRowOpen: boolean;
  /** Setter for personbogRowOpen */
  setPersonbogRowOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /** Saet af ekspanderede pant-indekser */
  expandedPant: Set<number>;
  /** Setter for expandedPant */
  setExpandedPant: React.Dispatch<React.SetStateAction<Set<number>>>;
  /** Saet af valgte dokument-IDs til download */
  selectedPantDocs: Set<string>;
  /** Setter for selectedPantDocs */
  setSelectedPantDocs: React.Dispatch<React.SetStateAction<Set<string>>>;

  // ── Bilbog (BIZZ-529) ──
  /** Bilbog-data */
  bilbogData: BilbogBil[];
  /** Om bilbogsdata indlaeses */
  bilbogLoading: boolean;
  /** Fejlbesked fra bilbog-fetch */
  bilbogFejl: string | null;
  /** Om Bilbogen-raekken er udfoldet */
  bilbogOpen: boolean;
  /** Setter for bilbogOpen */
  setBilbogOpen: React.Dispatch<React.SetStateAction<boolean>>;

  // ── Andelsbog (BIZZ-530) ──
  /** Andelsbog-data */
  andelsbogData: AndelsbogBolig[];
  /** Om andelsbogsdata indlaeses */
  andelsbogLoading: boolean;
  /** Fejlbesked fra andelsbog-fetch */
  andelsbogFejl: string | null;
  /** Om Andelsbogen-raekken er udfoldet */
  andelsbogOpen: boolean;
  /** Setter for andelsbogOpen */
  setAndelsbogOpen: React.Dispatch<React.SetStateAction<boolean>>;

  // ── Fast ejendom (BIZZ-521) ──
  /** Kreditor-ejendomme fra e-TL */
  fastEjendomKreditor: VirksomhedEjendomsrolle[];
  /** Om fast ejendom-data indlaeses */
  fastEjendomLoading: boolean;
  /** Fejlbesked fra fast ejendom-fetch */
  fastEjendomFejl: string | null;
  /** Hvilke af Fast ejendom-underraekkerne der er udfoldet */
  fastEjendomOpen: Set<'ejer' | 'kreditor'>;
  /** Setter for fastEjendomOpen */
  setFastEjendomOpen: React.Dispatch<React.SetStateAction<Set<'ejer' | 'kreditor'>>>;
}

/**
 * VirksomhedTinglysningTab — Tinglysning-fane med Personbog, Bilbog,
 * Andelsbog og Fast ejendom (kreditor) sektioner.
 *
 * @param props - Se VirksomhedTinglysningTabProps
 */
export default function VirksomhedTinglysningTab({
  lang,
  personbogData,
  personbogLoading,
  personbogFejl,
  personbogDokumenter,
  personbogRowOpen,
  setPersonbogRowOpen,
  expandedPant,
  setExpandedPant,
  selectedPantDocs,
  setSelectedPantDocs,
  bilbogData,
  bilbogLoading,
  bilbogFejl,
  bilbogOpen,
  setBilbogOpen,
  andelsbogData,
  andelsbogLoading,
  andelsbogFejl,
  andelsbogOpen,
  setAndelsbogOpen,
  fastEjendomKreditor,
  fastEjendomLoading,
  fastEjendomFejl,
  fastEjendomOpen,
  setFastEjendomOpen,
}: VirksomhedTinglysningTabProps) {
  const c = translations[lang].company;
  const da = lang === 'da';

  return (
    <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden">
      {/* BIZZ-617: Brug eksisterende loadingPersonbog-key (Personbogen) */}
      {personbogLoading && <TabLoadingSpinner label={c.loadingPersonbog} />}
      <div className="px-4 py-2.5 border-b border-slate-700/30 flex items-center gap-2">
        <Scale size={15} className="text-slate-400" />
        <span className="text-sm font-semibold text-slate-200">{c.registeredDocuments}</span>
      </div>
      <div className="divide-y divide-slate-700/20">
        {/* ── Personbogen — expandabel med rigtige data ── */}
        <div>
          <div className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-800/30 transition-colors">
            <button
              onClick={() => setPersonbogRowOpen((prev) => !prev)}
              className="flex items-center gap-3 flex-1 text-left min-w-0"
            >
              {/* Chevron — altid yderst til venstre */}
              <span className="flex-shrink-0 w-4">
                {personbogLoading ? (
                  <Loader2 size={12} className="animate-spin text-slate-500" />
                ) : personbogRowOpen ? (
                  <ChevronDown size={13} className="text-slate-500" />
                ) : (
                  <ChevronRight size={13} className="text-slate-500" />
                )}
              </span>
              <FileText size={15} className="text-slate-500 flex-shrink-0" />
              <span className="text-slate-200 text-sm">
                {c.personBook}
                <span className="text-slate-500 text-xs ml-1">
                  ({personbogLoading ? '…' : (personbogData?.length ?? 0)})
                </span>
              </span>
            </button>
            {/* Download valgte — kun synlig naar der er data */}
            {!personbogLoading && (personbogData?.length ?? 0) > 0 && (
              <button
                onClick={async () => {
                  for (const docId of selectedPantDocs) {
                    const url = `/api/tinglysning/dokument?uuid=${docId}`;
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `tinglysning-${docId.slice(0, 14)}.pdf`;
                    a.click();
                    await new Promise((r) => setTimeout(r, 500));
                  }
                }}
                disabled={selectedPantDocs.size === 0}
                className="ml-2 flex-shrink-0 flex items-center gap-1.5 px-3 py-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed border border-slate-600 rounded-lg text-slate-300 text-xs font-medium transition-all"
              >
                <Download size={12} />
                {c.personbogDownloadValgte} ({selectedPantDocs.size})
              </button>
            )}
          </div>
          {/* Expandabelt indhold — personbogsdata */}
          {personbogRowOpen && (
            <div className="border-t border-slate-700/20" style={{ contain: 'layout' }}>
              <PersonbogSection
                haeftelser={personbogData}
                loading={personbogLoading}
                fejl={personbogFejl}
                c={c}
                da={da}
                expandedPant={expandedPant}
                setExpandedPant={setExpandedPant}
                selectedPantDocs={selectedPantDocs}
                setSelectedPantDocs={setSelectedPantDocs}
                dokumenter={personbogDokumenter}
              />
            </div>
          )}
        </div>

        {/* ── Bilbogen (BIZZ-529) — expandabel med rigtige data ── */}
        <div>
          <div className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-800/30 transition-colors">
            <button
              onClick={() => setBilbogOpen((prev) => !prev)}
              className="flex items-center gap-3 flex-1 text-left min-w-0"
              disabled={bilbogData.length === 0 && !bilbogLoading}
            >
              <span className="flex-shrink-0 w-4">
                {bilbogLoading ? (
                  <Loader2 size={12} className="animate-spin text-slate-500" />
                ) : bilbogData.length === 0 ? (
                  <span />
                ) : bilbogOpen ? (
                  <ChevronDown size={13} className="text-slate-500" />
                ) : (
                  <ChevronRight size={13} className="text-slate-500" />
                )}
              </span>
              <FileText
                size={15}
                className={bilbogData.length > 0 ? 'text-slate-500' : 'text-slate-600'}
              />
              <span
                className={
                  bilbogData.length > 0 ? 'text-slate-200 text-sm' : 'text-slate-400 text-sm'
                }
              >
                {c.carBook}
                <span className="text-slate-500 text-xs ml-1">
                  ({bilbogLoading ? '…' : bilbogData.length})
                </span>
              </span>
            </button>
          </div>
          {bilbogOpen && bilbogData.length > 0 && (
            <div className="border-t border-slate-700/20 bg-slate-900/30 px-4 py-3 space-y-3">
              {bilbogFejl && <div className="text-xs text-red-400">{bilbogFejl}</div>}
              {bilbogData.map((bil) => (
                <div
                  key={bil.uuid}
                  className="bg-slate-800/40 border border-slate-700/40 rounded-lg p-3"
                >
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
                    <span className="text-slate-100 font-medium">{bil.fabrikat ?? '—'}</span>
                    {bil.aargang && (
                      <span className="text-slate-400">
                        {c.bilbogAargang}: {bil.aargang}
                      </span>
                    )}
                    {bil.registreringsnummer && (
                      <span className="text-slate-400">
                        {c.bilbogRegnr}: {bil.registreringsnummer}
                      </span>
                    )}
                    {bil.stelnummer && (
                      <span className="text-slate-500 font-mono">
                        {c.bilbogStelnummer}: {bil.stelnummer}
                      </span>
                    )}
                  </div>
                  {bil.haeftelser.length === 0 ? (
                    <div className="mt-2 text-xs text-slate-500">{c.bilbogIngenHaeftelser}</div>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {bil.haeftelser.map((h, i) => (
                        <li
                          key={`${bil.uuid}-${h.dokumentId ?? i}`}
                          className="text-xs text-slate-400"
                        >
                          <div className="flex flex-wrap items-baseline gap-x-3">
                            <span className="text-slate-300">{h.type}</span>
                            {h.hovedstol != null && (
                              <span>
                                {h.hovedstol.toLocaleString('da-DK')} {h.valuta}
                              </span>
                            )}
                            {h.kreditor && (
                              <span className="text-slate-500">
                                {c.personbogKreditor}: {h.kreditor}
                              </span>
                            )}
                            {h.tinglysningsdato && (
                              <span className="text-slate-600">{h.tinglysningsdato}</span>
                            )}
                            {h.dokumentId && (
                              <a
                                href={`/api/tinglysning/dokument?uuid=${h.dokumentId}`}
                                download
                                className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                              >
                                <Download size={10} />
                                PDF
                              </a>
                            )}
                          </div>
                          {/* BIZZ-522: revisionshistorik pr. dokument */}
                          {h.dokumentId && (
                            <div className="mt-1">
                              <PaategningTimeline dokumentId={h.dokumentId} lang={lang} />
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Andelsbogen (BIZZ-530) — expandabel med rigtige data ── */}
        <div>
          <div className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-800/30 transition-colors">
            <button
              onClick={() => setAndelsbogOpen((prev) => !prev)}
              className="flex items-center gap-3 flex-1 text-left min-w-0"
              disabled={andelsbogData.length === 0 && !andelsbogLoading}
            >
              <span className="flex-shrink-0 w-4">
                {andelsbogLoading ? (
                  <Loader2 size={12} className="animate-spin text-slate-500" />
                ) : andelsbogData.length === 0 ? (
                  <span />
                ) : andelsbogOpen ? (
                  <ChevronDown size={13} className="text-slate-500" />
                ) : (
                  <ChevronRight size={13} className="text-slate-500" />
                )}
              </span>
              <FileText
                size={15}
                className={andelsbogData.length > 0 ? 'text-slate-500' : 'text-slate-600'}
              />
              <span
                className={
                  andelsbogData.length > 0 ? 'text-slate-200 text-sm' : 'text-slate-400 text-sm'
                }
              >
                {c.cooperativeBook}
                <span className="text-slate-500 text-xs ml-1">
                  ({andelsbogLoading ? '…' : andelsbogData.length})
                </span>
              </span>
            </button>
          </div>
          {andelsbogOpen && andelsbogData.length > 0 && (
            <div className="border-t border-slate-700/20 bg-slate-900/30 px-4 py-3 space-y-3">
              {andelsbogFejl && <div className="text-xs text-red-400">{andelsbogFejl}</div>}
              {andelsbogData.map((andel) => (
                <div
                  key={andel.uuid}
                  className="bg-slate-800/40 border border-slate-700/40 rounded-lg p-3"
                >
                  <div className="text-sm text-slate-100 font-medium">{andel.adresse ?? '—'}</div>
                  {(andel.postnr || andel.by) && (
                    <div className="text-xs text-slate-400 mt-0.5">
                      {[andel.postnr, andel.by].filter(Boolean).join(' ')}
                    </div>
                  )}
                  {andel.haeftelser.length === 0 ? (
                    <div className="mt-2 text-xs text-slate-500">{c.andelsbogIngenHaeftelser}</div>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {andel.haeftelser.map((h, i) => (
                        <li
                          key={`${andel.uuid}-${h.dokumentId ?? i}`}
                          className="text-xs text-slate-400"
                        >
                          <div className="flex flex-wrap items-baseline gap-x-3">
                            <span className="text-slate-300">{h.type}</span>
                            {h.hovedstol != null && (
                              <span>
                                {h.hovedstol.toLocaleString('da-DK')} {h.valuta}
                              </span>
                            )}
                            {h.kreditor && (
                              <span className="text-slate-500">
                                {c.personbogKreditor}: {h.kreditor}
                              </span>
                            )}
                            {h.tinglysningsdato && (
                              <span className="text-slate-600">{h.tinglysningsdato}</span>
                            )}
                            {h.dokumentId && (
                              <a
                                href={`/api/tinglysning/dokument?uuid=${h.dokumentId}`}
                                download
                                className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                              >
                                <Download size={10} />
                                PDF
                              </a>
                            )}
                          </div>
                          {/* BIZZ-522: revisionshistorik pr. dokument */}
                          {h.dokumentId && (
                            <div className="mt-1">
                              <PaategningTimeline dokumentId={h.dokumentId} lang={lang} />
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/*
          Fast ejendom (BIZZ-521) — kun kreditor-sektionen vises her.
          "Ejer" er duplikeret med Ejendomme-fanen der bruger EJF som
          sandhedskilde for nuvaerende ejerskab; tinglysningens
          ejer-liste er historisk og forvirrer. Kreditor er
          tinglysnings-specifik (pantebreve) og hoerer til her.
        */}
        {[
          { rolle: 'kreditor' as const, rows: fastEjendomKreditor, label: c.fastEjendomKreditor },
        ].map(({ rolle, rows, label }) => {
          const open = fastEjendomOpen.has(rolle);
          return (
            <div key={rolle}>
              <div className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-800/30 transition-colors">
                <button
                  onClick={() =>
                    setFastEjendomOpen((prev) => {
                      const next = new Set(prev);
                      if (next.has(rolle)) next.delete(rolle);
                      else next.add(rolle);
                      return next;
                    })
                  }
                  className="flex items-center gap-3 flex-1 text-left min-w-0"
                  disabled={rows.length === 0 && !fastEjendomLoading}
                >
                  <span className="flex-shrink-0 w-4">
                    {fastEjendomLoading ? (
                      <Loader2 size={12} className="animate-spin text-slate-500" />
                    ) : rows.length === 0 ? (
                      <span />
                    ) : open ? (
                      <ChevronDown size={13} className="text-slate-500" />
                    ) : (
                      <ChevronRight size={13} className="text-slate-500" />
                    )}
                  </span>
                  <FileText
                    size={15}
                    className={rows.length > 0 ? 'text-slate-500' : 'text-slate-600'}
                  />
                  <span
                    className={
                      rows.length > 0 ? 'text-slate-200 text-sm' : 'text-slate-400 text-sm'
                    }
                  >
                    {label}
                    <span className="text-slate-500 text-xs ml-1">
                      ({fastEjendomLoading ? '…' : rows.length})
                    </span>
                  </span>
                </button>
              </div>
              {open && rows.length > 0 && (
                <div className="border-t border-slate-700/20 bg-slate-900/30 px-4 py-3">
                  {fastEjendomFejl && (
                    <div className="text-xs text-red-400 mb-2">{fastEjendomFejl}</div>
                  )}
                  {/*
                    BIZZ-521 follow-up: Brug tinglysnings-specifik kort-variant.
                    PropertyOwnerCard's auto-enrichment (current ejer, vurdering)
                    er misvisende i tinglysnings-kontekst fordi vi viser
                    historiske adkomster — ikke den aktuelle ejer.
                  */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                    {(() => {
                      // De-dupliker paa BFE: samler alle dokumenter for samme
                      // ejendom i et kort, saa en ejendom = et kort (med evt.
                      // flere adkomst-typer listet).
                      const groups = new Map<
                        number,
                        { first: VirksomhedEjendomsrolle; all: VirksomhedEjendomsrolle[] }
                      >();
                      for (const r of rows) {
                        const g = groups.get(r.bfe);
                        if (g) g.all.push(r);
                        else groups.set(r.bfe, { first: r, all: [r] });
                      }
                      return Array.from(groups.values()).map(({ first, all }) => {
                        const heading =
                          first.adresse ??
                          first.matrikel ??
                          `BFE ${first.bfe.toLocaleString('da-DK')}`;
                        const subLine =
                          first.postnr && first.by
                            ? `${first.postnr} ${first.by}`
                            : first.adresse
                              ? first.matrikel
                              : first.kommune;
                        const detailHref = first.dawaId
                          ? `/dashboard/ejendomme/${first.dawaId}`
                          : null;
                        const adkomster = Array.from(
                          new Set(all.map((r) => r.adkomstType).filter((x): x is string => !!x))
                        );
                        const CardBody = (
                          <div
                            className={`group relative flex flex-col bg-slate-800/60 border rounded-xl overflow-hidden transition-all ${
                              detailHref
                                ? 'border-slate-700/50 hover:border-emerald-500/40 hover:bg-slate-800/80'
                                : 'border-slate-700/40'
                            }`}
                          >
                            <div className="h-1 flex-shrink-0 bg-gradient-to-r from-emerald-600/60 to-emerald-500/20" />
                            <div className="p-4 flex flex-col gap-2">
                              <div className="flex items-start gap-2">
                                <MapPin
                                  size={14}
                                  className="mt-0.5 flex-shrink-0 text-emerald-500"
                                />
                                <div className="min-w-0">
                                  <p className="text-white font-medium text-sm leading-snug truncate">
                                    {heading}
                                  </p>
                                  {subLine && (
                                    <p className="text-slate-400 text-xs mt-0.5 truncate">
                                      {subLine}
                                    </p>
                                  )}
                                </div>
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] text-slate-400 bg-slate-900/60 font-mono">
                                  BFE {first.bfe.toLocaleString('da-DK')}
                                </span>
                                {first.ejendomstype && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] text-slate-300 bg-slate-900/60">
                                    {first.ejendomstype}
                                  </span>
                                )}
                                {adkomster.map((a) => (
                                  <span
                                    key={a}
                                    className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] text-emerald-300 bg-emerald-900/30"
                                  >
                                    {c.fastEjendomAdkomst}: {a}
                                  </span>
                                ))}
                              </div>
                              {/* BIZZ-570: Vis haeftelse-beloeb oeverst paa kreditor-kort.
                                Sum hvis flere haeftelser paa samme BFE. */}
                              {(() => {
                                if (rolle !== 'kreditor') return null;
                                const haeftelser = all.filter(
                                  (r) => r.haeftelseBeloeb != null && r.haeftelseBeloeb > 0
                                );
                                if (haeftelser.length === 0) return null;
                                const sumBeloeb = haeftelser.reduce(
                                  (s, r) => s + (r.haeftelseBeloeb ?? 0),
                                  0
                                );
                                const types = Array.from(
                                  new Set(
                                    haeftelser
                                      .map((r) => r.haeftelseType)
                                      .filter((t): t is string => !!t)
                                  )
                                );
                                return (
                                  <div className="pt-1.5 border-t border-slate-700/30">
                                    <div className="flex items-baseline gap-2">
                                      <span className="text-amber-400 text-sm font-semibold">
                                        {sumBeloeb.toLocaleString('da-DK')} DKK
                                      </span>
                                      <span className="text-[10px] text-slate-500 uppercase tracking-wide">
                                        {lang === 'da' ? 'Hæftelse' : 'Lien'}
                                        {haeftelser.length > 1 ? ` × ${haeftelser.length}` : ''}
                                      </span>
                                    </div>
                                    {types.length > 0 && (
                                      <p className="text-[10px] text-slate-400 mt-0.5">
                                        {types.join(' · ')}
                                      </p>
                                    )}
                                  </div>
                                );
                              })()}
                              {all.some((r) => r.dokumentAlias) && (
                                <div className="text-[10px] text-slate-500 font-mono pt-1 border-t border-slate-700/30">
                                  {all
                                    .map((r) => r.dokumentAlias)
                                    .filter((a): a is string => !!a)
                                    .slice(0, 3)
                                    .join(' · ')}
                                  {all.filter((r) => r.dokumentAlias).length > 3 && ' …'}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                        return detailHref ? (
                          <Link key={`${rolle}-${first.bfe}`} href={detailHref} className="block">
                            {CardBody}
                          </Link>
                        ) : (
                          <div key={`${rolle}-${first.bfe}`}>{CardBody}</div>
                        );
                      });
                    })()}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
