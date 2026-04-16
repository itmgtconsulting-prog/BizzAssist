'use client';

/**
 * Persondetaljeside — viser fuld information om en person og deres roller i virksomheder.
 *
 * Henter data fra CVR ES via /api/cvr-public/person.
 * Viser personinfo fordelt på 6 tabs: Oversigt, Relationsdiagram, Ejendomme, Gruppe, Kronologi, Tinglysning.
 *
 * @param params.enhedsNummer - Personens enhedsNummer fra URL
 */

import { useState, useEffect, use, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Briefcase,
  Users,
  Loader2,
  AlertTriangle,
  ExternalLink,
  LayoutDashboard,
  Home,
  Clock,
  Scale,
  ChevronDown,
  ChevronRight,
  User,
  Newspaper,
  Globe,
  Sparkles,
  Zap,
  X,
  Lock,
  FileText,
  Download,
} from 'lucide-react';
import Link from 'next/link';
import { useLanguage } from '@/app/context/LanguageContext';
import { useSetAIPageContext } from '@/app/context/AIPageContext';
import { translations } from '@/app/lib/translations';
import type { PersonPublicData, PersonCompanyRole } from '@/app/api/cvr-public/person/route';
import type { PersonbogHaeftelse } from '@/app/api/tinglysning/personbog/route';
import type { RelateretVirksomhed } from '@/app/api/cvr-public/related/route';
import type { EjendomSummary } from '@/app/api/ejendomme-by-owner/route';
import PropertyOwnerCard from '@/app/components/ejendomme/PropertyOwnerCard';
import { saveRecentPerson } from '@/app/lib/recentPersons';
import { recordRecentVisit } from '@/app/lib/recordRecentVisit';
import { buildPersonDiagramGraph } from '@/app/components/diagrams/DiagramData';
import type { DiagramPropertySummary } from '@/app/components/diagrams/DiagramData';
import dynamic from 'next/dynamic';
import VerifiedLinks from '@/app/components/VerifiedLinks';
import { useSubscription } from '@/app/context/SubscriptionContext';
import { useSubscriptionAccess } from '@/app/components/SubscriptionGate';
import { resolvePlan, formatTokens, isSubscriptionFunctional } from '@/app/lib/subscriptions';
import SektionLoader from '@/app/components/SektionLoader';

const DiagramForce = dynamic(() => import('@/app/components/diagrams/DiagramForce'), {
  ssr: false,
  loading: () => <div className="w-full h-96 bg-slate-800/50 rounded-xl animate-pulse" />,
});

// ─── Tab Types ──────────────────────────────────────────────────────────────

type TabId = 'overview' | 'relations' | 'properties' | 'group' | 'chronology' | 'liens';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Formaterer dato kort (DD. MMM. YYYY).
 */
function formatDatoKort(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return iso;
  }
}

/**
 * Filtrerer dummy-datoer (f.eks. 1903-01-01 fra CVR ES EJERREGISTER).
 */
function filterDummyDato(iso: string | null): string | null {
  if (!iso) return null;
  if (iso.startsWith('1903-')) return null;
  const year = parseInt(iso.slice(0, 4), 10);
  if (!isNaN(year) && year < 1900) return null;
  return iso;
}

/**
 * Mapper rollenavn til kategori.
 */
function rolleKategori(rolle: string): string {
  const r = rolle.toUpperCase();
  if (r.includes('EJER') || r === 'EJERREGISTER') return 'EJER';
  if (r.includes('BESTYRELSE') || r.includes('TILSYNSRÅD')) return 'BESTYRELSE';
  if (r.includes('STIFTER') || r.includes('FOND')) return 'STIFTER';
  if (r.includes('REVISION')) return 'REVISION';
  if (r.includes('DIREKTION') || r.includes('DIREKTØR')) return 'DIREKTION';
  if (r.includes('REEL') || r.includes('LEGALE')) return 'EJER';
  return 'ANDET';
}

/**
 * Returnerer true hvis rollen er en ejer-rolle.
 */
function erEjerRolle(rolle: string): boolean {
  const r = rolle.toUpperCase();
  return r.includes('EJER') || r.includes('LEGALE') || r.includes('REEL');
}

/**
 * Returnerer true hvis rollen er EJERREGISTER (skal filtreres fra kronologi).
 */
function erEjerregister(rolle: string): boolean {
  return rolle.toUpperCase() === 'EJERREGISTER';
}

// ─── Small UI components ────────────────────────────────────────────────────

function EmptyState({ ikon, tekst }: { ikon: React.ReactNode; tekst: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {ikon}
      <p className="mt-3 text-sm text-slate-500">{tekst}</p>
    </div>
  );
}

// ─── Personbog Tinglysning (via virksomheders CVR) ──────────────────────────

/** Typekonfig for farvekodede personbog-sektioner — matcher virksomhedssiden */
const personbogSektioner: {
  key: string;
  bgClass: string;
  textClass: string;
  borderClass: string;
}[] = [
  {
    key: 'virksomhedspant',
    bgClass: 'bg-amber-500/5',
    textClass: 'text-amber-400',
    borderClass: 'border-amber-500/20',
  },
  {
    key: 'loesoerepant',
    bgClass: 'bg-teal-500/5',
    textClass: 'text-teal-400',
    borderClass: 'border-teal-500/20',
  },
  {
    key: 'fordringspant',
    bgClass: 'bg-cyan-500/5',
    textClass: 'text-cyan-400',
    borderClass: 'border-cyan-500/20',
  },
  {
    key: 'ejendomsforbehold',
    bgClass: 'bg-purple-500/5',
    textClass: 'text-purple-400',
    borderClass: 'border-purple-500/20',
  },
];

/** Oversætter personbog-typenøgler til UI-labels */
function pbTypeLabel(key: string, da: boolean): string {
  const map: Record<string, string> = da
    ? {
        virksomhedspant: 'Virksomhedspant',
        loesoerepant: 'Løsørepant',
        fordringspant: 'Fordringspant',
        ejendomsforbehold: 'Ejendomsforbehold',
      }
    : {
        virksomhedspant: 'Floating Charge',
        loesoerepant: 'Chattel Mortgage',
        fordringspant: 'Receivables Lien',
        ejendomsforbehold: 'Retention of Title',
      };
  return map[key] ?? key;
}

/** Oversætter pantomfang-nøgler til UI-labels */
function pbOmfangLabel(key: string, da: boolean): string {
  const lower = key.toLowerCase();
  if (lower.includes('varelager')) return da ? 'Varelager' : 'Inventory';
  if (lower.includes('driftsinventar') || lower.includes('driftsmateriel'))
    return da ? 'Driftsinventar og driftsmateriel' : 'Equipment and operating assets';
  if (lower.includes('fordring')) return da ? 'Fordringer' : 'Trade receivables';
  if (lower.includes('immateriel'))
    return da ? 'Immaterielle rettigheder' : 'Intellectual property rights';
  return key;
}

interface PersonTinglysningTabProps {
  personbogMap: Record<string, { navn: string; haeftelser: PersonbogHaeftelse[] }>;
  loading: boolean;
  fejl: string | null;
  /**
   * BIZZ-339: True når personen har ingen tilknyttede virksomheder.
   * Tinglysningsrettens API understøtter kun CVR-baseret søgning i Personbogen —
   * der er ingen direkte søgning på fysiske personers CPR/enhedsNummer.
   * Vises som en informationsboks i stedet for en tom liste.
   */
  ingenVirksomheder: boolean;
  c: (typeof translations)['da']['person'];
  da: boolean;
  expandedPant: Set<string>;
  setExpandedPant: React.Dispatch<React.SetStateAction<Set<string>>>;
  selectedPantDocs: Set<string>;
  setSelectedPantDocs: React.Dispatch<React.SetStateAction<Set<string>>>;
}

/**
 * PersonTinglysningTab — Viser personbogshæftelser for alle virksomheder personen er tilknyttet.
 *
 * Tinglysningsrettens API (e-TL) understøtter kun søgning i Personbogen via CVR-nummer
 * (endpoint: /soegpersonbogcvr). Der er ingen tilsvarende endpoint til at søge direkte
 * på en fysisk persons enhedsNummer eller CPR — se http_api_beskrivelse v1.12, afsnit 4.4.
 * Derfor vises kun virksomhedspant for de CVR-numre personen er registreret på.
 *
 * Grupperet per virksomhed, med farvekodede sektioner per hæftelsestype.
 * Matcher designet fra virksomhedssiden og ejendomssiden.
 *
 * @param personbogMap - Map fra CVR til virksomhedsnavn + hæftelser
 * @param loading - True mens data hentes
 * @param fejl - Fejlbesked fra API
 * @param ingenVirksomheder - True hvis personen har ingen tilknyttede virksomheder
 * @param c - Oversættelser
 * @param da - True for dansk, false for engelsk
 */
function PersonTinglysningTab({
  personbogMap,
  loading,
  fejl,
  ingenVirksomheder,
  c,
  da,
  expandedPant,
  setExpandedPant,
  selectedPantDocs,
  setSelectedPantDocs,
}: PersonTinglysningTabProps) {
  const cvrEntries = Object.entries(personbogMap);
  const allHaeftelser = cvrEntries.flatMap(([, v]) => v.haeftelser);

  const toggleExpand = (key: string) => {
    setExpandedPant((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
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

  return (
    <div className="space-y-2">
      {/* ── Loading / fejl / tom tilstand — kompakt inline ── */}
      {loading && (
        <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl flex items-center gap-2 px-4 py-3">
          <Loader2 size={14} className="text-blue-400 animate-spin flex-shrink-0" />
          <p className="text-slate-400 text-xs">{c.loadingTinglysning}</p>
        </div>
      )}
      {!loading && fejl && (
        <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl flex items-center gap-2 px-4 py-3">
          <AlertTriangle size={14} className="text-amber-400 flex-shrink-0" />
          <p className="text-slate-400 text-xs">{fejl}</p>
        </div>
      )}
      {/* BIZZ-339: Personen har ingen tilknyttede virksomheder — søgning ikke mulig via e-TL API */}
      {!loading && !fejl && ingenVirksomheder && (
        <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl flex items-start gap-3 px-4 py-3">
          <AlertTriangle size={14} className="text-slate-500 flex-shrink-0 mt-0.5" />
          <p className="text-slate-500 text-xs">{c.tinglysningIngenVirksomheder}</p>
        </div>
      )}
      {!loading && !fejl && !ingenVirksomheder && allHaeftelser.length === 0 && (
        <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl px-4 py-3">
          <p className="text-slate-500 text-xs italic">{c.tinglysningEmpty}</p>
        </div>
      )}

      {/* ── Per virksomhed — én kort per CVR med hæftelsestabel ── */}
      {!loading &&
        !fejl &&
        cvrEntries.map(([cvr, { navn, haeftelser }]) => {
          const grouped: Record<string, PersonbogHaeftelse[]> = {};
          for (const h of haeftelser) {
            if (!grouped[h.type]) grouped[h.type] = [];
            grouped[h.type].push(h);
          }

          return (
            <div
              key={cvr}
              className="bg-slate-800/20 border border-slate-700/30 rounded-2xl"
              style={{ contain: 'layout' }}
            >
              {/* Header — virksomhedsnavn + download */}
              <div className="px-4 py-2.5 border-b border-slate-700/30 flex items-center gap-2">
                <Scale size={15} className="text-slate-400" />
                <Link
                  href={`/dashboard/companies/${cvr}`}
                  className="text-sm font-semibold text-blue-400 hover:underline"
                >
                  {navn}
                </Link>
                <span className="text-slate-600 text-xs">CVR {cvr}</span>
                <span className="text-slate-600 text-xs">({haeftelser.length})</span>
                <button
                  onClick={async () => {
                    const docs = haeftelser.filter(
                      (h) => h.dokumentId && selectedPantDocs.has(h.dokumentId)
                    );
                    for (const h of docs) {
                      const a = document.createElement('a');
                      a.href = `/api/tinglysning/dokument?uuid=${h.dokumentId}`;
                      a.download = `tinglysning-${h.dokumentId!.slice(0, 14)}.pdf`;
                      a.click();
                      await new Promise((r) => setTimeout(r, 500));
                    }
                  }}
                  disabled={selectedPantDocs.size === 0}
                  className="ml-auto flex items-center gap-1.5 px-3 py-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed border border-slate-600 rounded-lg text-slate-300 text-xs font-medium transition-all"
                >
                  <Download size={12} />
                  {da ? 'Download valgte' : 'Download selected'} ({selectedPantDocs.size})
                </button>
              </div>

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
                    <div className={`${bgClass} px-4 py-1.5 border-b border-slate-700/20`}>
                      <span
                        className={`text-[10px] font-semibold ${textClass} uppercase tracking-wider`}
                      >
                        {pbTypeLabel(key, da)} ({items.length})
                      </span>
                    </div>
                    {items.map((h, i) => {
                      const rowKey = `${cvr}-${key}-${i}`;
                      const isExpanded = expandedPant.has(rowKey);
                      const docId = String(h.dokumentId ?? '');
                      return (
                        <div key={rowKey} className="border-b border-slate-700/15">
                          <div
                            className="grid grid-cols-[24px_36px_90px_1fr_100px_100px_50px_28px] gap-x-2 px-4 py-2 hover:bg-slate-700/10 transition-colors items-center cursor-pointer"
                            onClick={() => toggleExpand(rowKey)}
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
                                {pbTypeLabel(h.type, da)}
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
                            <div className={`px-4 pb-3 ml-10 border-l-2 ${borderClass}`}>
                              {h.pantTyper.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mb-3 mt-1">
                                  {h.pantTyper.map((p, pi) => (
                                    <span
                                      key={pi}
                                      className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${bgClass} ${textClass}`}
                                    >
                                      {pbOmfangLabel(p, da)}
                                    </span>
                                  ))}
                                </div>
                              )}
                              <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 text-xs mt-1">
                                {h.kreditor && (
                                  <div>
                                    <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                                      {da ? 'Kreditor' : 'Creditor'}
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
                                {h.debitorer.length > 0 && (
                                  <div>
                                    <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                                      {da ? 'Debitor' : 'Debtor'}
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
                                {h.hovedstol != null && (
                                  <div>
                                    <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                                      {da ? 'Hovedstol' : 'Principal'}
                                    </p>
                                    <p className="text-white">
                                      {h.hovedstol.toLocaleString('da-DK')} {h.valuta}
                                    </p>
                                  </div>
                                )}
                                {h.rente != null && (
                                  <div>
                                    <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                                      {da ? 'Rente' : 'Interest rate'}
                                    </p>
                                    <p className="text-white">
                                      {h.rente}% {h.renteType ? `(${h.renteType})` : ''}
                                    </p>
                                  </div>
                                )}
                                {h.tinglysningsdato && (
                                  <div>
                                    <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                                      {da ? 'Tinglysningsdato' : 'Registration date'}
                                    </p>
                                    <p className="text-white">
                                      {formatDatoKort(h.tinglysningsdato)}
                                    </p>
                                  </div>
                                )}
                                {h.tinglysningsafgift != null && (
                                  <div>
                                    <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                                      {da ? 'Tinglysningsafgift' : 'Registration fee'}
                                    </p>
                                    <p className="text-white">
                                      {h.tinglysningsafgift.toLocaleString('da-DK')} DKK
                                    </p>
                                  </div>
                                )}
                                {h.dokumentAlias && (
                                  <div>
                                    <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                                      {da ? 'Dokument' : 'Document'}
                                    </p>
                                    <p className="text-white text-[11px]">{h.dokumentAlias}</p>
                                  </div>
                                )}
                              </div>
                              {h.vilkaar && (
                                <div className="mt-2 pt-2 border-t border-slate-700/20">
                                  <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                                    {da ? 'Vilkår' : 'Terms'}
                                  </p>
                                  <p className="text-slate-300 text-xs whitespace-pre-line">
                                    {h.vilkaar}
                                  </p>
                                </div>
                              )}
                              {h.anmelderNavn && (
                                <div className="mt-2 pt-2 border-t border-slate-700/20">
                                  <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                                    {da ? 'Anmelder' : 'Notifier'}
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
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}

              {/* Øvrige hæftelser */}
              {(() => {
                const knownKeys = personbogSektioner.map((s) => s.key);
                const oevrige = Object.entries(grouped).filter(([key]) => !knownKeys.includes(key));
                if (oevrige.length === 0) return null;
                return oevrige.map(([key, items]) => (
                  <div key={key}>
                    <div className="bg-slate-500/5 px-4 py-1.5 border-b border-slate-700/20">
                      <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                        {da ? 'Øvrige' : 'Other'}: {key} ({items.length})
                      </span>
                    </div>
                    {items.map((h, i) => {
                      const rowKey = `${cvr}-other-${i}`;
                      const isExpanded = expandedPant.has(rowKey);
                      return (
                        <div key={rowKey} className="border-b border-slate-700/15">
                          <div
                            className="grid grid-cols-[24px_36px_90px_1fr_100px_100px_50px_28px] gap-x-2 px-4 py-2 hover:bg-slate-700/10 transition-colors items-center cursor-pointer"
                            onClick={() => toggleExpand(rowKey)}
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
                            <span />
                            <span />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ));
              })()}
            </div>
          );
        })}
    </div>
  );
}

// ─── PlaceholderTab (removed — all tabs now have real implementations) ───

function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
  className,
  count,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
  count?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-slate-400 hover:text-slate-200 text-xs font-medium transition-colors w-full text-left py-1.5"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {title}
        {count != null && <span className="text-slate-600">({count})</span>}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

/** Kompakt klikbar virksomhedsrække med rolle-tags og status */
function CompanyRowCompact({
  v,
  lang,
  rollerOverride,
}: {
  v: PersonCompanyRole;
  lang: 'da' | 'en';
  rollerOverride?: string[];
}) {
  const router = useRouter();
  const vRoller = rollerOverride ?? v.roller.filter((r) => !r.til).map((r) => r.rolle);
  const ejerRolle = v.roller.find((r) => !r.til && r.ejerandel);

  return (
    <button
      onClick={() => router.push(`/dashboard/companies/${v.cvr}`)}
      className="group w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-slate-900/40 hover:bg-slate-800/60 transition text-left"
    >
      <Building2 size={12} className="text-slate-500 group-hover:text-blue-400 flex-shrink-0" />
      <span className="text-white text-xs font-medium truncate group-hover:text-blue-300 transition-colors">
        {v.navn}
      </span>
      {/* Rolle-tags */}
      {vRoller.slice(0, 2).map((rolle, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[8px] font-medium bg-slate-800/80 text-slate-400 border border-slate-700/40 flex-shrink-0"
        >
          {rolle}
        </span>
      ))}
      {ejerRolle?.ejerandel && (
        <span className="text-[8px] text-emerald-400 flex-shrink-0">{ejerRolle.ejerandel}</span>
      )}
      {/* Status */}
      <span
        className={`px-1.5 py-0.5 rounded text-[8px] font-medium flex-shrink-0 ${v.aktiv ? 'bg-emerald-600/20 text-emerald-400' : 'bg-red-600/20 text-red-400'}`}
      >
        {v.aktiv ? (lang === 'da' ? 'Aktiv' : 'Active') : lang === 'da' ? 'Ophørt' : 'Ceased'}
      </span>
      <ExternalLink
        size={9}
        className="text-slate-600 group-hover:text-blue-400 flex-shrink-0 ml-auto"
      />
    </button>
  );
}

// ─── Page Component ─────────────────────────────────────────────────────────

export default function PersonDetailPageClient({
  params,
}: {
  params: Promise<{ enhedsNummer: string }>;
}) {
  const { enhedsNummer: enhedsStr } = use(params);
  const enhedsNummer = parseInt(enhedsStr, 10);

  const router = useRouter();
  const { lang } = useLanguage();
  const c = translations[lang].person;
  /** Sæt AI-kontekst med enhedsNummer og navn så AI'en kan bruge dem direkte */
  const setAICtx = useSetAIPageContext();

  const [data, setData] = useState<PersonPublicData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aktivTab, setAktivTab] = useState<TabId>('overview');

  const [relatedCompanies, setRelatedCompanies] = useState<Map<number, RelateretVirksomhed[]>>(
    new Map()
  );
  const [relatedLoading, setRelatedLoading] = useState(false);
  const relatedFetchedRef = useRef(false);

  /** Ejendomme portefølje — progressivt lazy-loaded when properties tab is activated */
  const [ejendommeData, setEjendommeData] = useState<EjendomSummary[]>([]);
  const [ejendommeLoading, setEjendommeLoading] = useState(false);
  const [ejendommeLoadingMore, setEjendommeLoadingMore] = useState(false);
  const [ejendommeFetchComplete, setEjendommeFetchComplete] = useState(false);
  const [ejendommeManglerNoegle, setEjendommeManglerNoegle] = useState(false);
  const [ejendommeManglerAdgang, setEjendommeManglerAdgang] = useState(false);
  const [ejendommeTotalBfe, setEjendommeTotalBfe] = useState(0);
  /** Kommasepereret CVR-nøgle der sidst blev hentet — forhindrer duplicate-fetches */
  const ejendomFetchKeyRef = useRef('');
  /** AbortController for igangværende progressiv ejendomshentning */
  const ejendomAbortRef = useRef<AbortController | null>(null);

  /** Detekterer desktop vs. mobil — nyheder-panel vises som sidebar på desktop, overlay på mobil */
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 900px)');
    setIsDesktop(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  /** Styrer om nyheder/sociale medier-panelet er synligt på desktop. */
  const [nyhedsPanelÅben, setNyhedsPanelÅben] = useState(true);

  /** Styrer om mobil nyheder-overlay er åbent. */
  const [mobilNyhederAaben, setMobilNyhederAaben] = useState(false);

  /** AI-fundne sociale medier-URLs med confidence — udfyldes efter artikel-søgning */
  const [aiSocials, setAiSocials] = useState<
    Record<string, { url: string; confidence: number; reason?: string }>
  >({});

  /** AI-fundne kontaktoplysninger — udfyldes efter artikel-søgning */
  const [aiContacts, setAiContacts] = useState<ContactResult[]>([]);

  /** AI-fundne alternative links per platform med confidence — udfyldes efter artikel-søgning */
  const [aiAlternatives, setAiAlternatives] = useState<
    Record<string, Array<{ url: string; confidence: number; reason?: string }>>
  >({});

  /** Confidence-tærskel fra ai_settings — default 70 */
  const [confidenceThreshold, setConfidenceThreshold] = useState(70);

  /** Personbog (tinglysning) — lazy-loaded when liens tab is activated */
  const [personbogMap, setPersonbogMap] = useState<
    Record<string, { navn: string; haeftelser: PersonbogHaeftelse[] }>
  >({});
  const [personbogLoading, setPersonbogLoading] = useState(false);
  const [personbogFejl, setPersonbogFejl] = useState<string | null>(null);
  const [expandedPant, setExpandedPant] = useState<Set<string>>(new Set());
  const [selectedPantDocs, setSelectedPantDocs] = useState<Set<string>>(new Set());
  const personbogFetchedRef = useRef(false);

  /** Side panel state */
  const [_panelBredde, setPanelBredde] = useState(360);
  const panelTraekRef = useRef<{ x: number; bredde: number } | null>(null);
  const [panelTraekAktiv, setPanelTraekAktiv] = useState(false);

  useEffect(() => {
    if (!panelTraekAktiv) return;
    const handleMove = (e: MouseEvent) => {
      if (!panelTraekRef.current) return;
      const diff = panelTraekRef.current.x - e.clientX;
      const newW = Math.max(250, Math.min(600, panelTraekRef.current.bredde + diff));
      setPanelBredde(newW);
    };
    const handleUp = () => {
      panelTraekRef.current = null;
      setPanelTraekAktiv(false);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [panelTraekAktiv]);

  /** Nøglepersoner (bestyrelse+direktion) per CVR for ejervirksomheder — delt mellem diagram og Gruppe-tab */
  const [noeglePersonerMap, setNoeglePersonerMap] = useState<
    Map<
      number,
      {
        bestyrelse: { navn: string; enhedsNummer: number }[];
        direktion: { navn: string; enhedsNummer: number }[];
      }
    >
  >(new Map());
  const noeglePersonerFetchedRef = useRef(false);

  // ─── Fetch person data ──────────────────────────────────────────────────────
  useEffect(() => {
    if (isNaN(enhedsNummer)) {
      setError(c.notFound);
      setLoading(false);
      return;
    }

    fetch(`/api/cvr-public/person?enhedsNummer=${enhedsNummer}`)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (json.error) {
          setError(json.error);
          return;
        }
        const person = json as PersonPublicData;
        setData(person);
        saveRecentPerson({
          enhedsNummer: person.enhedsNummer,
          name: person.navn,
          erVirksomhed: person.erVirksomhed,
          antalVirksomheder: person.virksomheder.length,
        });
        // Opdater recent tag-bar (virker også ved direkte URL-navigation)
        recordRecentVisit(
          'person',
          String(person.enhedsNummer),
          person.navn,
          `/dashboard/owners/${person.enhedsNummer}`
        );
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [enhedsNummer, c.notFound]);

  /**
   * Sæt AI-kontekst med enhedsNummer (straks fra URL) og virksomhedsdata
   * (når fetch er færdig). AI'en kan dermed svare på formue-spørgsmål direkte
   * fra den allerede loadede data — uden at lave et nyt CVR ES-opslag.
   */
  useEffect(() => {
    // Byg virksomhedsliste fra allerede loadede data (aktive med ejerandel øverst)
    const personVirksomheder = data?.virksomheder.map((v) => ({
      cvr: v.cvr,
      navn: v.navn,
      branche: v.branche,
      aktiv: v.aktiv,
      ejerandel: v.roller.find((r) => r.ejerandel && !r.til)?.ejerandel ?? null,
      roller: v.roller.filter((r) => !r.til).map((r) => r.rolle),
    }));

    setAICtx({
      enhedsNummer: enhedsStr,
      personNavn: data?.navn ?? undefined,
      personVirksomheder: personVirksomheder ?? undefined,
    });
  }, [enhedsStr, data, setAICtx]);

  // ─── Fetch related companies ────────────────────────────────────────────────
  const fetchRelated = useCallback(async () => {
    if (!data || relatedFetchedRef.current) return;
    relatedFetchedRef.current = true;

    /** Kun virksomheder med faktisk ejerandel — matcher ejerVirksomheder i derived */
    const owned = data.virksomheder.filter(
      (v) => v.aktiv && v.roller.some((r) => erEjerRolle(r.rolle) && !r.til && r.ejerandel)
    );
    if (owned.length === 0) return;

    setRelatedLoading(true);
    const results = new Map<number, RelateretVirksomhed[]>();
    await Promise.all(
      owned.map(async (company) => {
        try {
          const res = await fetch(
            `/api/cvr-public/related?cvr=${String(company.cvr).padStart(8, '0')}`
          );
          if (res.ok) {
            const json = await res.json();
            if (json.virksomheder) results.set(company.cvr, json.virksomheder);
          }
        } catch {
          /* skip */
        }
      })
    );
    setRelatedCompanies(results);
    setRelatedLoading(false);
  }, [data]);

  useEffect(() => {
    if (data && !relatedFetchedRef.current) fetchRelated();
  }, [data, fetchRelated]);

  // ─── Derived data ──────────────────────────────────────────────────────────
  const derived = useMemo(() => {
    if (!data) return null;

    const aktiveRoller = data.virksomheder.flatMap((v) =>
      v.roller.filter((r) => !r.til).map((r) => ({ ...r, virksomhed: v }))
    );
    const historiskeRoller = data.virksomheder.flatMap((v) =>
      v.roller.filter((r) => r.til != null).map((r) => ({ ...r, virksomhed: v }))
    );
    const aktiveVirksomheder = data.virksomheder.filter(
      (v) => v.aktiv && v.roller.some((r) => !r.til)
    );
    const ophørteVirksomheder = data.virksomheder.filter(
      (v) => !v.aktiv || !v.roller.some((r) => !r.til)
    );

    /** Ejer-virksomheder = virksomheder hvor personen har en aktiv ejerrolle MED ejerandel */
    const ejerVirksomheder = data.virksomheder.filter(
      (v) => v.aktiv && v.roller.some((r) => erEjerRolle(r.rolle) && !r.til && r.ejerandel)
    );
    const ejerCvrs = new Set(ejerVirksomheder.map((v) => v.cvr));
    /** Andre virksomheder = aktive virksomheder der IKKE er i ejerskabsdiagrammet */
    const andreVirksomheder = data.virksomheder.filter(
      (v) => v.aktiv && !ejerCvrs.has(v.cvr) && v.roller.some((r) => !r.til)
    );

    /** Kategoriserede roller for info-boksen */
    const rollerPerKategori = {
      ejerandel: [] as { v: PersonCompanyRole; roller: string[]; andel: string | null }[],
      bestyrelse: [] as { v: PersonCompanyRole; roller: string[] }[],
      direktion: [] as { v: PersonCompanyRole; roller: string[] }[],
      andre: [] as { v: PersonCompanyRole; roller: string[] }[],
    };

    for (const v of data.virksomheder) {
      if (!v.aktiv) continue;
      const aktive = v.roller.filter((r) => !r.til);
      if (aktive.length === 0) continue;

      const ejerR = aktive.filter((r) => erEjerRolle(r.rolle));
      const bestR = aktive.filter((r) => {
        const u = r.rolle.toUpperCase();
        return u.includes('BESTYRELSE') || u.includes('TILSYNSRÅD');
      });
      const dirR = aktive.filter((r) => {
        const u = r.rolle.toUpperCase();
        return u.includes('DIREKTION') || u.includes('DIREKTØR');
      });
      const andR = aktive.filter((r) => {
        const u = r.rolle.toUpperCase();
        return (
          !erEjerRolle(r.rolle) &&
          !u.includes('BESTYRELSE') &&
          !u.includes('TILSYNSRÅD') &&
          !u.includes('DIREKTION') &&
          !u.includes('DIREKTØR') &&
          u !== 'EJERREGISTER'
        );
      });

      if (ejerR.length > 0 && ejerR.some((r) => r.ejerandel)) {
        const andel = ejerR.find((r) => r.ejerandel)?.ejerandel ?? null;
        rollerPerKategori.ejerandel.push({ v, roller: ejerR.map((r) => r.rolle), andel });
      }
      if (bestR.length > 0)
        rollerPerKategori.bestyrelse.push({ v, roller: bestR.map((r) => r.rolle) });
      if (dirR.length > 0)
        rollerPerKategori.direktion.push({ v, roller: dirR.map((r) => r.rolle) });
      if (andR.length > 0) rollerPerKategori.andre.push({ v, roller: andR.map((r) => r.rolle) });
    }

    /** Kategoriserede roller for ophørte virksomheder */
    const rollerPerKategoriHistorisk = {
      ejerandel: [] as { v: PersonCompanyRole; roller: string[]; andel: string | null }[],
      bestyrelse: [] as { v: PersonCompanyRole; roller: string[] }[],
      direktion: [] as { v: PersonCompanyRole; roller: string[] }[],
      andre: [] as { v: PersonCompanyRole; roller: string[] }[],
    };

    for (const v of ophørteVirksomheder) {
      const alleRoller = v.roller;
      if (alleRoller.length === 0) continue;

      const ejerR = alleRoller.filter((r) => erEjerRolle(r.rolle));
      const bestR = alleRoller.filter((r) => {
        const u = r.rolle.toUpperCase();
        return u.includes('BESTYRELSE') || u.includes('TILSYNSRÅD');
      });
      const dirR = alleRoller.filter((r) => {
        const u = r.rolle.toUpperCase();
        return u.includes('DIREKTION') || u.includes('DIREKTØR');
      });
      const andR = alleRoller.filter((r) => {
        const u = r.rolle.toUpperCase();
        return (
          !erEjerRolle(r.rolle) &&
          !u.includes('BESTYRELSE') &&
          !u.includes('TILSYNSRÅD') &&
          !u.includes('DIREKTION') &&
          !u.includes('DIREKTØR') &&
          u !== 'EJERREGISTER'
        );
      });

      if (ejerR.length > 0 && ejerR.some((r) => r.ejerandel)) {
        const andel = ejerR.find((r) => r.ejerandel)?.ejerandel ?? null;
        rollerPerKategoriHistorisk.ejerandel.push({ v, roller: ejerR.map((r) => r.rolle), andel });
      }
      if (bestR.length > 0)
        rollerPerKategoriHistorisk.bestyrelse.push({ v, roller: bestR.map((r) => r.rolle) });
      if (dirR.length > 0)
        rollerPerKategoriHistorisk.direktion.push({ v, roller: dirR.map((r) => r.rolle) });
      if (andR.length > 0)
        rollerPerKategoriHistorisk.andre.push({ v, roller: andR.map((r) => r.rolle) });
    }

    return {
      aktiveRoller,
      historiskeRoller,
      aktiveVirksomheder,
      ophørteVirksomheder,
      ejerVirksomheder,
      andreVirksomheder,
      rollerPerKategori,
      rollerPerKategoriHistorisk,
    };
  }, [data]);

  const _alleRelated = useMemo(() => {
    const result: RelateretVirksomhed[] = [];
    const seen = new Set<number>();
    for (const [, related] of relatedCompanies) {
      for (const r of related) {
        if (!seen.has(r.cvr) && r.aktiv) {
          seen.add(r.cvr);
          result.push(r);
        }
      }
    }
    return result;
  }, [relatedCompanies]);

  /**
   * Top-level ejervirksomheder: fjern virksomheder der optræder som datterselskab
   * af en anden ejervirksomhed (dvs. indirekte ejerskab via holdingstruktur).
   * Bruges til oversigt-infoboks og relationsdiagram top-niveau.
   */
  const topLevelEjer = useMemo(() => {
    if (!derived) return [];
    const { ejerVirksomheder } = derived;
    // Saml alle CVR'er der er datterselskab af en ejervirksomhed
    const subsidiCvrs = new Set<number>();
    for (const v of ejerVirksomheder) {
      for (const rel of relatedCompanies.get(v.cvr) ?? []) {
        subsidiCvrs.add(rel.cvr);
      }
    }
    // Behold kun ejervirksomheder der IKKE er datterselskab af en anden
    return ejerVirksomheder.filter((v) => !subsidiCvrs.has(v.cvr));
  }, [derived, relatedCompanies]);

  /** Hent nøglepersoner (bestyrelse+direktion) for alle virksomheder (ejede + andre roller) */
  useEffect(() => {
    if (noeglePersonerFetchedRef.current) return;
    const alleVirksomheder = [...topLevelEjer, ...(derived?.andreVirksomheder ?? [])];
    if (alleVirksomheder.length === 0) return;
    noeglePersonerFetchedRef.current = true;

    Promise.all(
      alleVirksomheder.map(async (v) => {
        try {
          const res = await fetch(`/api/cvr-public?vat=${v.cvr}`, {
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) return null;
          const json = await res.json();
          if (json.error) return null;
          const deltagere = json.deltagere ?? [];
          const bestyrelse: { navn: string; enhedsNummer: number }[] = [];
          const direktion: { navn: string; enhedsNummer: number }[] = [];
          for (const d of deltagere) {
            if (!d.enhedsNummer) continue;
            for (const r of d.roller ?? []) {
              if (r.til) continue;
              const role = (r.rolle ?? '').toUpperCase();
              if (role.includes('BESTYRELSE') || role.includes('TILSYNSRÅD')) {
                if (!bestyrelse.some((b) => b.enhedsNummer === d.enhedsNummer)) {
                  bestyrelse.push({ navn: d.navn, enhedsNummer: d.enhedsNummer });
                }
              }
              if (role.includes('DIREKTION') || role.includes('DIREKTØR')) {
                if (!direktion.some((b) => b.enhedsNummer === d.enhedsNummer)) {
                  direktion.push({ navn: d.navn, enhedsNummer: d.enhedsNummer });
                }
              }
            }
          }
          return { cvr: v.cvr, bestyrelse, direktion };
        } catch {
          return null;
        }
      })
    ).then((results) => {
      const map = new Map<
        number,
        {
          bestyrelse: { navn: string; enhedsNummer: number }[];
          direktion: { navn: string; enhedsNummer: number }[];
        }
      >();
      for (const r of results) {
        if (r) map.set(r.cvr, { bestyrelse: r.bestyrelse, direktion: r.direktion });
      }
      setNoeglePersonerMap(map);
    });
  }, [topLevelEjer, derived?.andreVirksomheder]);

  /**
   * Henter ejendomsportefølje progressivt: første batch (5) vises straks,
   * efterfølgende batches tilføjes automatisk i baggrunden.
   * Bruger AbortController til at annullere igangværende hentning ved CVR-ændring.
   */
  /**
   * BIZZ-264: Extended to support both CVR (company) and enhedsNummer (person) lookups.
   * Builds query params with cvr= and/or enhedsNummer= as appropriate.
   */
  const fetchEjendommeProgressively = useCallback(
    async (uniqueCvrs: string[], personEnhedsNumre?: string[]) => {
      ejendomAbortRef.current?.abort();
      const controller = new AbortController();
      ejendomAbortRef.current = controller;

      const FIRST_BATCH = 5;
      const REST_BATCH = 10;

      setEjendommeData([]);
      setEjendommeFetchComplete(false);
      setEjendommeLoadingMore(false);
      setEjendommeLoading(true);
      setEjendommeManglerNoegle(false);
      setEjendommeManglerAdgang(false);

      // Build query params — support both CVR and enhedsNummer
      const params = new URLSearchParams();
      if (uniqueCvrs.length > 0) params.set('cvr', uniqueCvrs.join(','));
      if (personEnhedsNumre && personEnhedsNumre.length > 0)
        params.set('enhedsNummer', personEnhedsNumre.join(','));
      params.set('offset', '0');
      params.set('limit', String(FIRST_BATCH));

      try {
        const url = `/api/ejendomme-by-owner?${params}`;
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`${res.status}`);
        const json = (await res.json()) as {
          ejendomme: EjendomSummary[];
          totalBfe: number;
          manglerNoegle: boolean;
          manglerAdgang: boolean;
        };

        if (controller.signal.aborted) return;

        setEjendommeData(json.ejendomme ?? []);
        setEjendommeTotalBfe(json.totalBfe ?? 0);
        setEjendommeManglerNoegle(json.manglerNoegle === true);
        setEjendommeManglerAdgang(json.manglerAdgang === true);
        setEjendommeLoading(false);

        let offset = FIRST_BATCH;
        const total = json.totalBfe ?? 0;

        if (offset < total) setEjendommeLoadingMore(true);

        while (offset < total) {
          if (controller.signal.aborted) return;

          params.set('offset', String(offset));
          params.set('limit', String(REST_BATCH));
          const res2 = await fetch(`/api/ejendomme-by-owner?${params}`, {
            signal: controller.signal,
          });
          if (!res2.ok) break;
          const json2 = (await res2.json()) as { ejendomme: EjendomSummary[] };

          if (controller.signal.aborted) return;

          setEjendommeData((prev) => [...prev, ...(json2.ejendomme ?? [])]);
          offset += REST_BATCH;
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setEjendommeData([]);
      } finally {
        if (!controller.signal.aborted) {
          setEjendommeLoading(false);
          setEjendommeLoadingMore(false);
          setEjendommeFetchComplete(true);
        }
      }
    },
    []
  );

  /**
   * Trigger progressiv ejendomshentning når properties-tab aktiveres eller CVR-sæt ændres.
   * Kører igen når relatedCompanies ændres (datterselskaber loader ind).
   *
   * BIZZ-338: Inkluderer nu også CVR-numre fra andreVirksomheder (virksomheder hvor personen
   * har ikke-ejer roller som direktion/bestyrelse), så ejendomme ejet via disse virksomheder
   * også vises i Ejendomme-tab.
   */
  useEffect(() => {
    if ((aktivTab !== 'properties' && aktivTab !== 'relations') || !derived) return;

    /* Saml CVR-numre for direkte ejede virksomheder */
    const ejerCvrs = derived.ejerVirksomheder.map((v) => String(v.cvr).padStart(8, '0'));

    /* BIZZ-338: Tilføj CVR-numre fra virksomheder med andre roller (direktion/bestyrelse) */
    const andreVirksomhedCvrs = derived.andreVirksomheder.map((v) =>
      String(v.cvr).padStart(8, '0')
    );

    /* Tilføj datterselskaber fra relatedCompanies */
    const subsidieCvrs: string[] = [];
    for (const [, related] of relatedCompanies) {
      for (const r of related) {
        if (r.aktiv) subsidieCvrs.push(String(r.cvr).padStart(8, '0'));
      }
    }

    const uniqueCvrs = [...new Set([...ejerCvrs, ...andreVirksomhedCvrs, ...subsidieCvrs])].slice(
      0,
      30
    );

    // BIZZ-264: Also fetch person's directly owned properties via enhedsNummer
    const personEnhedsNumre = data?.enhedsNummer ? [String(data.enhedsNummer)] : [];

    const fetchKey = [...uniqueCvrs, ...personEnhedsNumre].sort().join(',');
    if (ejendomFetchKeyRef.current === fetchKey) return;
    ejendomFetchKeyRef.current = fetchKey;

    if (uniqueCvrs.length === 0 && personEnhedsNumre.length === 0) {
      setEjendommeData([]);
      setEjendommeTotalBfe(0);
      setEjendommeFetchComplete(true);
      return;
    }

    void fetchEjendommeProgressively(uniqueCvrs, personEnhedsNumre);
  }, [aktivTab, derived, relatedCompanies, fetchEjendommeProgressively]);

  /**
   * Lazy-loader personbogsdata for alle tilknyttede virksomheder når Tinglysning-tab aktiveres.
   * Fetcher parallelt for hvert CVR — cacher i state.
   */
  useEffect(() => {
    if (aktivTab !== 'liens' || !data || personbogFetchedRef.current) return;
    personbogFetchedRef.current = true;

    const cvrs = data.virksomheder.map((v) => String(v.cvr).padStart(8, '0'));
    if (cvrs.length === 0) {
      setPersonbogLoading(false);
      return;
    }

    setPersonbogLoading(true);
    setPersonbogFejl(null);

    Promise.allSettled(
      cvrs.map(async (cvr) => {
        const virk = data.virksomheder.find((v) => String(v.cvr).padStart(8, '0') === cvr);
        const res = await fetch(`/api/tinglysning/personbog?cvr=${cvr}`);
        const json = await res.json();
        return {
          cvr,
          navn: virk?.navn ?? cvr,
          haeftelser: (json.haeftelser ?? []) as PersonbogHaeftelse[],
        };
      })
    )
      .then((results) => {
        const map: Record<string, { navn: string; haeftelser: PersonbogHaeftelse[] }> = {};
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.haeftelser.length > 0) {
            map[r.value.cvr] = { navn: r.value.navn, haeftelser: r.value.haeftelser };
          }
        }
        setPersonbogMap(map);
      })
      .catch(() => {
        setPersonbogFejl(c.tinglysningError);
      })
      .finally(() => {
        setPersonbogLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aktivTab, data]);

  // ─── Tab config ──────────────────────────────────────────────────────────────
  const tabDef: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: c.tabs.overview, icon: <LayoutDashboard size={12} /> },
    { id: 'relations', label: c.tabs.relations, icon: <Briefcase size={12} /> },
    { id: 'properties', label: c.tabs.properties, icon: <Home size={12} /> },
    { id: 'group', label: c.tabs.group, icon: <Building2 size={12} /> },
    { id: 'chronology', label: c.tabs.chronology, icon: <Clock size={12} /> },
    { id: 'liens', label: c.tabs.liens, icon: <Scale size={12} /> },
  ];

  // ── Loading state — matches loading.tsx skeleton for seamless transition ──
  if (loading)
    return (
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 animate-pulse">
        {/* Back link */}
        <div className="h-4 w-24 bg-slate-700/20 rounded" />
        {/* Person header */}
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-slate-800 flex-shrink-0" />
            <div className="h-8 w-64 bg-slate-800 rounded-lg" />
          </div>
          <div className="flex items-center gap-2 mt-2">
            <Loader2
              size={14}
              className="text-blue-400 flex-shrink-0"
              style={{ animation: 'spin 0.8s linear infinite' }}
            />
            <span className="text-slate-400 text-sm" style={{ animation: 'none' }}>
              {c.loading}
            </span>
          </div>
        </div>
        {/* Tab bar */}
        <div className="flex gap-4 border-b border-slate-700/30 pb-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-4 w-24 bg-slate-700/20 rounded" />
          ))}
        </div>
        {/* Stat cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-white/5 border border-white/8 rounded-2xl p-5 space-y-3">
              <div className="h-4 w-28 bg-slate-700/30 rounded" />
              <div className="h-8 w-16 bg-slate-700/40 rounded" />
            </div>
          ))}
        </div>
        {/* Roles / company list skeleton */}
        <div className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-4">
          <div className="h-5 w-40 bg-slate-700/30 rounded" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 py-2 border-b border-slate-700/20">
              <div className="w-8 h-8 rounded-lg bg-slate-700/30 flex-shrink-0" />
              <div className="flex-1 space-y-1">
                <div className="h-4 w-48 bg-slate-700/30 rounded" />
                <div className="h-3 w-32 bg-slate-700/15 rounded" />
              </div>
              <div className="h-5 w-20 bg-slate-700/20 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    );

  if (error || !data || !derived)
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <AlertTriangle className="w-12 h-12 text-red-500/60" />
        <p className="text-slate-400 text-sm">{error ?? c.error}</p>
        <button
          onClick={() => router.push('/dashboard/owners')}
          className="px-4 py-2 text-sm bg-slate-800 border border-slate-700 rounded-lg text-slate-300 hover:text-white transition"
        >
          {c.goBack}
        </button>
      </div>
    );

  const {
    aktiveRoller,
    historiskeRoller: _historiskeRoller,
    aktiveVirksomheder,
    ophørteVirksomheder,
    ejerVirksomheder: _ejerVirksomheder,
    andreVirksomheder,
    rollerPerKategori,
    rollerPerKategoriHistorisk,
  } = derived;

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* ─── Left: Main Content ─── */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* ─── Sticky Header ─── */}
        <div className="px-3 sm:px-6 pt-5 pb-0 border-b border-slate-700/50 bg-slate-900/30">
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => router.push('/dashboard/owners')}
              className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
            >
              <ArrowLeft size={16} /> {c.goBack}
            </button>
            <div className="flex items-center gap-2">
              {/* Nyheder/AI-søgning toggle knap */}
              <button
                onClick={() => {
                  if (isDesktop) {
                    setNyhedsPanelÅben((prev) => !prev);
                  } else {
                    setMobilNyhederAaben(true);
                  }
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-sm transition-all ${
                  (isDesktop && nyhedsPanelÅben) || (!isDesktop && mobilNyhederAaben)
                    ? 'bg-blue-600/20 hover:bg-blue-600/30 border-blue-500/40 text-blue-300'
                    : 'bg-slate-800 hover:bg-slate-700 border-slate-700/60 text-slate-300'
                }`}
                title={lang === 'da' ? 'Medier & AI artikel søgning' : 'Media & AI article search'}
              >
                <Newspaper size={14} />
                {lang === 'da' ? 'Medier' : 'Media'}
              </button>
            </div>
          </div>

          <h1 className="text-white text-xl sm:text-2xl font-bold mb-2">{data.navn}</h1>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-700/50 text-slate-300 border border-slate-600/50">
              <Users size={12} />
              {data.erVirksomhed
                ? lang === 'da'
                  ? 'Virksomhed'
                  : 'Company'
                : lang === 'da'
                  ? 'Person'
                  : 'Person'}
            </span>
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-600/20 text-blue-300 border border-blue-500/30">
              {aktiveRoller.length} {lang === 'da' ? 'aktive roller' : 'active roles'}
            </span>
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-700/50 text-slate-400 border border-slate-600/50">
              {aktiveVirksomheder.length} {lang === 'da' ? 'virksomheder' : 'companies'}
            </span>
          </div>

          <div className="flex gap-1 -mb-px overflow-x-auto scrollbar-hide">
            {tabDef.map(({ id, label, icon }) => (
              <button
                key={id}
                onClick={() => setAktivTab(id)}
                className={`flex items-center gap-1 px-2 py-1.5 text-xs font-medium border-b-2 transition-all whitespace-nowrap ${
                  aktivTab === id
                    ? 'border-blue-500 text-blue-300'
                    : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600'
                }`}
              >
                {icon} {label}
              </button>
            ))}
          </div>
        </div>

        {/* ─── Scrollable Content ─── */}
        <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-5">
          {/* ══ OVERSIGT ══ */}
          {aktivTab === 'overview' && (
            <div className="space-y-4">
              {/* ── 4-kolonne rolle-oversigt ── */}
              <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
                <h2 className="text-white font-semibold text-sm flex items-center gap-2 mb-3">
                  <Users size={14} className="text-blue-400" /> {c.info}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {/* Ejerandele + Ejendomme (same column) */}
                  {(() => {
                    /** Kun top-level ejerandele (fjern datterselskaber) */
                    const topCvrs = new Set(topLevelEjer.map((v) => v.cvr));
                    const topEjerandele = rollerPerKategori.ejerandel.filter(({ v }) =>
                      topCvrs.has(v.cvr)
                    );
                    return (
                      <div className="bg-slate-900/50 rounded-lg p-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400 mb-2">
                          {lang === 'da' ? 'Ejerandele' : 'Ownership'}
                          {topEjerandele.length > 0 && (
                            <span className="text-slate-600 ml-1">({topEjerandele.length})</span>
                          )}
                        </p>
                        {topEjerandele.length > 0 ? (
                          <div className="space-y-1.5">
                            {topEjerandele.map(({ v, andel }) => (
                              <button
                                key={v.cvr}
                                onClick={() => router.push(`/dashboard/companies/${v.cvr}`)}
                                className="group w-full flex items-center gap-1.5 text-left"
                              >
                                <Building2
                                  size={10}
                                  className="text-slate-500 group-hover:text-blue-400 flex-shrink-0"
                                />
                                <span className="text-slate-300 text-[11px] truncate group-hover:text-blue-300">
                                  {v.navn}
                                </span>
                                {andel && (
                                  <span className="text-[9px] text-emerald-400 flex-shrink-0 ml-auto">
                                    {andel}
                                  </span>
                                )}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="text-slate-600 text-[10px]">
                            {lang === 'da' ? 'Ingen' : 'None'}
                          </p>
                        )}
                        {/* Ejendomme sektion */}
                        <div className="mt-3 pt-3 border-t border-slate-700/30">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-teal-400 mb-2">
                            {lang === 'da' ? 'Ejendomme' : 'Properties'}
                          </p>
                          <p className="text-slate-600 text-[10px]">
                            {lang === 'da' ? 'Kommer snart' : 'Coming soon'}
                          </p>
                        </div>
                      </div>
                    );
                  })()}
                  {/* Bestyrelse */}
                  <div className="bg-slate-900/50 rounded-lg p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-400 mb-2">
                      {lang === 'da' ? 'Bestyrelse' : 'Board'}
                      {rollerPerKategori.bestyrelse.length > 0 && (
                        <span className="text-slate-600 ml-1">
                          ({rollerPerKategori.bestyrelse.length})
                        </span>
                      )}
                    </p>
                    {rollerPerKategori.bestyrelse.length > 0 ? (
                      <div className="space-y-1.5">
                        {rollerPerKategori.bestyrelse.map(({ v, roller }) => (
                          <button
                            key={v.cvr}
                            onClick={() => router.push(`/dashboard/companies/${v.cvr}`)}
                            className="group w-full flex items-center gap-1.5 text-left"
                          >
                            <Building2
                              size={10}
                              className="text-slate-500 group-hover:text-blue-400 flex-shrink-0"
                            />
                            <span className="text-slate-300 text-[11px] truncate group-hover:text-blue-300">
                              {v.navn}
                            </span>
                            <span className="text-[8px] text-slate-500 flex-shrink-0 ml-auto">
                              {roller[0]}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-slate-600 text-[10px]">
                        {lang === 'da' ? 'Ingen' : 'None'}
                      </p>
                    )}
                  </div>
                  {/* Direktion */}
                  <div className="bg-slate-900/50 rounded-lg p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-400 mb-2">
                      {lang === 'da' ? 'Direktion' : 'Management'}
                      {rollerPerKategori.direktion.length > 0 && (
                        <span className="text-slate-600 ml-1">
                          ({rollerPerKategori.direktion.length})
                        </span>
                      )}
                    </p>
                    {rollerPerKategori.direktion.length > 0 ? (
                      <div className="space-y-1.5">
                        {rollerPerKategori.direktion.map(({ v, roller }) => (
                          <button
                            key={v.cvr}
                            onClick={() => router.push(`/dashboard/companies/${v.cvr}`)}
                            className="group w-full flex items-center gap-1.5 text-left"
                          >
                            <Building2
                              size={10}
                              className="text-slate-500 group-hover:text-blue-400 flex-shrink-0"
                            />
                            <span className="text-slate-300 text-[11px] truncate group-hover:text-blue-300">
                              {v.navn}
                            </span>
                            <span className="text-[8px] text-slate-500 flex-shrink-0 ml-auto">
                              {roller[0]}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-slate-600 text-[10px]">
                        {lang === 'da' ? 'Ingen' : 'None'}
                      </p>
                    )}
                  </div>
                  {/* Stifter / Interessenter / Andre */}
                  <div className="bg-slate-900/50 rounded-lg p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-purple-400 mb-2">
                      {lang === 'da' ? 'Stifter / Andre' : 'Founder / Other'}
                      {rollerPerKategori.andre.length > 0 && (
                        <span className="text-slate-600 ml-1">
                          ({rollerPerKategori.andre.length})
                        </span>
                      )}
                    </p>
                    {rollerPerKategori.andre.length > 0 ? (
                      <div className="space-y-1.5">
                        {rollerPerKategori.andre.map(({ v, roller }) => (
                          <button
                            key={v.cvr}
                            onClick={() => router.push(`/dashboard/companies/${v.cvr}`)}
                            className="group w-full flex items-center gap-1.5 text-left"
                          >
                            <Building2
                              size={10}
                              className="text-slate-500 group-hover:text-blue-400 flex-shrink-0"
                            />
                            <span className="text-slate-300 text-[11px] truncate group-hover:text-blue-300">
                              {v.navn}
                            </span>
                            <span className="text-[8px] text-slate-500 flex-shrink-0 ml-auto">
                              {roller[0]}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-slate-600 text-[10px]">
                        {lang === 'da' ? 'Ingen' : 'None'}
                      </p>
                    )}
                  </div>
                </div>
                {/* Ophørte / historiske — same column layout */}
                {ophørteVirksomheder.length > 0 && (
                  <CollapsibleSection
                    title={lang === 'da' ? 'Ophørte / historiske' : 'Ceased / historical'}
                    count={ophørteVirksomheder.length}
                    defaultOpen={false}
                    className="mt-3"
                  >
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-2">
                      {/* Ejerandele (historisk) */}
                      <div className="bg-slate-900/30 rounded-lg p-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400/60 mb-2">
                          {lang === 'da' ? 'Ejerandele' : 'Ownership'}
                          {rollerPerKategoriHistorisk.ejerandel.length > 0 && (
                            <span className="text-slate-700 ml-1">
                              ({rollerPerKategoriHistorisk.ejerandel.length})
                            </span>
                          )}
                        </p>
                        {rollerPerKategoriHistorisk.ejerandel.length > 0 ? (
                          <div className="space-y-1.5">
                            {rollerPerKategoriHistorisk.ejerandel.map(({ v, andel }) => (
                              <button
                                key={v.cvr}
                                onClick={() => router.push(`/dashboard/companies/${v.cvr}`)}
                                className="group w-full flex items-center gap-1.5 text-left"
                              >
                                <Building2
                                  size={10}
                                  className="text-slate-600 group-hover:text-blue-400 flex-shrink-0"
                                />
                                <span className="text-slate-500 text-[11px] truncate group-hover:text-blue-300">
                                  {v.navn}
                                </span>
                                {andel && (
                                  <span className="text-[9px] text-emerald-400/50 flex-shrink-0 ml-auto">
                                    {andel}
                                  </span>
                                )}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="text-slate-700 text-[10px]">
                            {lang === 'da' ? 'Ingen' : 'None'}
                          </p>
                        )}
                      </div>
                      {/* Bestyrelse (historisk) */}
                      <div className="bg-slate-900/30 rounded-lg p-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-400/60 mb-2">
                          {lang === 'da' ? 'Bestyrelse' : 'Board'}
                          {rollerPerKategoriHistorisk.bestyrelse.length > 0 && (
                            <span className="text-slate-700 ml-1">
                              ({rollerPerKategoriHistorisk.bestyrelse.length})
                            </span>
                          )}
                        </p>
                        {rollerPerKategoriHistorisk.bestyrelse.length > 0 ? (
                          <div className="space-y-1.5">
                            {rollerPerKategoriHistorisk.bestyrelse.map(({ v, roller }) => (
                              <button
                                key={v.cvr}
                                onClick={() => router.push(`/dashboard/companies/${v.cvr}`)}
                                className="group w-full flex items-center gap-1.5 text-left"
                              >
                                <Building2
                                  size={10}
                                  className="text-slate-600 group-hover:text-blue-400 flex-shrink-0"
                                />
                                <span className="text-slate-500 text-[11px] truncate group-hover:text-blue-300">
                                  {v.navn}
                                </span>
                                <span className="text-[8px] text-slate-600 flex-shrink-0 ml-auto">
                                  {roller[0]}
                                </span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="text-slate-700 text-[10px]">
                            {lang === 'da' ? 'Ingen' : 'None'}
                          </p>
                        )}
                      </div>
                      {/* Direktion (historisk) */}
                      <div className="bg-slate-900/30 rounded-lg p-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-400/60 mb-2">
                          {lang === 'da' ? 'Direktion' : 'Management'}
                          {rollerPerKategoriHistorisk.direktion.length > 0 && (
                            <span className="text-slate-700 ml-1">
                              ({rollerPerKategoriHistorisk.direktion.length})
                            </span>
                          )}
                        </p>
                        {rollerPerKategoriHistorisk.direktion.length > 0 ? (
                          <div className="space-y-1.5">
                            {rollerPerKategoriHistorisk.direktion.map(({ v, roller }) => (
                              <button
                                key={v.cvr}
                                onClick={() => router.push(`/dashboard/companies/${v.cvr}`)}
                                className="group w-full flex items-center gap-1.5 text-left"
                              >
                                <Building2
                                  size={10}
                                  className="text-slate-600 group-hover:text-blue-400 flex-shrink-0"
                                />
                                <span className="text-slate-500 text-[11px] truncate group-hover:text-blue-300">
                                  {v.navn}
                                </span>
                                <span className="text-[8px] text-slate-600 flex-shrink-0 ml-auto">
                                  {roller[0]}
                                </span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="text-slate-700 text-[10px]">
                            {lang === 'da' ? 'Ingen' : 'None'}
                          </p>
                        )}
                      </div>
                      {/* Andre (historisk) */}
                      <div className="bg-slate-900/30 rounded-lg p-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-purple-400/60 mb-2">
                          {lang === 'da' ? 'Stifter / Andre' : 'Founder / Other'}
                          {rollerPerKategoriHistorisk.andre.length > 0 && (
                            <span className="text-slate-700 ml-1">
                              ({rollerPerKategoriHistorisk.andre.length})
                            </span>
                          )}
                        </p>
                        {rollerPerKategoriHistorisk.andre.length > 0 ? (
                          <div className="space-y-1.5">
                            {rollerPerKategoriHistorisk.andre.map(({ v, roller }) => (
                              <button
                                key={v.cvr}
                                onClick={() => router.push(`/dashboard/companies/${v.cvr}`)}
                                className="group w-full flex items-center gap-1.5 text-left"
                              >
                                <Building2
                                  size={10}
                                  className="text-slate-600 group-hover:text-blue-400 flex-shrink-0"
                                />
                                <span className="text-slate-500 text-[11px] truncate group-hover:text-blue-300">
                                  {v.navn}
                                </span>
                                <span className="text-[8px] text-slate-600 flex-shrink-0 ml-auto">
                                  {roller[0]}
                                </span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="text-slate-700 text-[10px]">
                            {lang === 'da' ? 'Ingen' : 'None'}
                          </p>
                        )}
                      </div>
                    </div>
                  </CollapsibleSection>
                )}
              </section>
            </div>
          )}

          {/* ══ RELATIONSDIAGRAM — BIZZ-337: variant toggle matcher virksomhedssiden ══ */}
          {aktivTab === 'relations' &&
            (() => {
              const propertiesByCvr =
                ejendommeData.length > 0
                  ? ejendommeData.reduce((map, p) => {
                      const cvrNum = parseInt(p.ownerCvr, 10);
                      if (!map.has(cvrNum)) map.set(cvrNum, []);
                      map.get(cvrNum)!.push(p as DiagramPropertySummary);
                      return map;
                    }, new Map<number, DiagramPropertySummary[]>())
                  : undefined;
              const diagramGraph = buildPersonDiagramGraph(
                data.navn,
                data.enhedsNummer,
                topLevelEjer,
                relatedCompanies,
                noeglePersonerMap,
                andreVirksomheder,
                propertiesByCvr
              );
              return (
                <DiagramForce
                  graph={diagramGraph}
                  lang={lang}
                  onNodeClick={(node) => {
                    // BIZZ-368: clicking a company node in the person diagram should switch to
                    // the overview tab (staying on this page) rather than navigating to the
                    // company page. Property and person nodes without a meaningful tab target
                    // fall back to normal navigation.
                    if (node.type === 'company' || node.type === 'main') {
                      setAktivTab('overview');
                    } else if (node.link) {
                      window.location.href = node.link;
                    }
                  }}
                />
              );
            })()}

          {/* ══ EJENDOMME ══ */}
          {aktivTab === 'properties' && (
            <div className="space-y-4">
              {/* BIZZ-338: Ingen tilknyttede virksomheder — hverken ejede eller andre roller */}
              {ejendommeFetchComplete &&
                !ejendommeManglerNoegle &&
                !ejendommeManglerAdgang &&
                (derived?.ejerVirksomheder.length ?? 0) === 0 &&
                (derived?.andreVirksomheder.length ?? 0) === 0 && (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <Home size={36} className="text-slate-600 mb-3" />
                    <p className="text-slate-400 text-sm">
                      {lang === 'da'
                        ? 'Ingen registrerede tilknytninger fundet — personen har ingen aktive virksomheder.'
                        : 'No registered company links found — the person has no active companies.'}
                    </p>
                  </div>
                )}

              {/* Indledende spinner — vises kun før første batch ankommer */}
              {ejendommeLoading && ejendommeData.length === 0 && (
                <SektionLoader
                  label={
                    lang === 'da' ? 'Henter ejendomsportefølje…' : 'Loading property portfolio…'
                  }
                  rows={4}
                />
              )}

              {/* Mangler nøgle / adgang — vises når hentning er fuldført */}
              {ejendommeFetchComplete && ejendommeManglerNoegle && (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Home size={36} className="text-slate-600 mb-3" />
                  <p className="text-slate-400 text-sm max-w-sm">
                    {lang === 'da'
                      ? 'Ejendomsopslag kræver Datafordeler OAuth-nøgler (DATAFORDELER_OAUTH_CLIENT_ID / CLIENT_SECRET).'
                      : 'Property lookup requires Datafordeler OAuth keys (DATAFORDELER_OAUTH_CLIENT_ID / CLIENT_SECRET).'}
                  </p>
                </div>
              )}
              {ejendommeFetchComplete && ejendommeManglerAdgang && (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Home size={36} className="text-slate-600 mb-3" />
                  <p className="text-slate-400 text-sm max-w-sm">
                    {lang === 'da'
                      ? 'Adgang til Ejerfortegnelsen (EJF) er ikke godkendt endnu. Ansøg om Dataadgang på datafordeler.dk.'
                      : 'Access to the Danish land registry (EJF) has not been approved yet. Apply for Dataadgang at datafordeler.dk.'}
                  </p>
                </div>
              )}

              {/* Ejendomme grid — vises så snart første batch ankommer */}
              {ejendommeData.length > 0 && (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-slate-400 text-sm">
                      {ejendommeLoadingMore
                        ? lang === 'da'
                          ? `Indlæser… (${ejendommeData.length} af ${ejendommeTotalBfe} ejendomme)`
                          : `Loading… (${ejendommeData.length} of ${ejendommeTotalBfe} properties)`
                        : lang === 'da'
                          ? `${ejendommeData.length} ejendom${ejendommeData.length !== 1 ? 'me' : ''} fundet`
                          : `${ejendommeData.length} propert${ejendommeData.length !== 1 ? 'ies' : 'y'} found`}
                    </p>
                    {/* BIZZ-338: tæller inkluderer nu også andreVirksomheder */}
                    <span className="text-slate-500 text-xs">
                      {(() => {
                        const total =
                          (derived?.ejerVirksomheder.length ?? 0) +
                          (derived?.andreVirksomheder.length ?? 0);
                        return lang === 'da'
                          ? `Via ${total} virksomhed${total !== 1 ? 'er' : ''}`
                          : `Via ${total} compan${total !== 1 ? 'ies' : 'y'}`;
                      })()}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                    {ejendommeData.map((ej) => (
                      <PropertyOwnerCard key={ej.bfeNummer} ejendom={ej} showOwner lang={lang} />
                    ))}
                  </div>

                  {/* Progressiv loading-indikator i bunden */}
                  {ejendommeLoadingMore && (
                    <div className="flex items-center justify-center gap-2 py-4 text-slate-500 text-sm">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {lang === 'da' ? 'Indlæser flere ejendomme…' : 'Loading more properties…'}
                    </div>
                  )}
                </>
              )}

              {/* Ingen ejendomme fundet — vises kun når hentning er fuldført og listen er tom */}
              {ejendommeFetchComplete &&
                !ejendommeManglerNoegle &&
                !ejendommeManglerAdgang &&
                ejendommeData.length === 0 &&
                (derived?.ejerVirksomheder.length ?? 0) > 0 && (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <Home size={36} className="text-slate-600 mb-3" />
                    <p className="text-slate-400 text-sm">
                      {lang === 'da'
                        ? 'Ingen registrerede ejendomme fundet for de tilknyttede virksomheder.'
                        : 'No registered properties found for the linked companies.'}
                    </p>
                  </div>
                )}
            </div>
          )}

          {/* ══ GRUPPE ══ */}
          {aktivTab === 'group' && (
            <GroupTab
              data={data}
              ejerVirksomheder={topLevelEjer}
              andreVirksomheder={andreVirksomheder}
              relatedCompanies={relatedCompanies}
              relatedLoading={relatedLoading}
              noeglePersonerMap={noeglePersonerMap}
              lang={lang}
            />
          )}

          {/* ══ KRONOLOGI ══ */}
          {aktivTab === 'chronology' && <ChronologyTab data={data} lang={lang} />}

          {/* ══ TINGLYSNING (PERSONBOG VIA VIRKSOMHEDER) ══ */}
          {aktivTab === 'liens' && (
            <PersonTinglysningTab
              personbogMap={personbogMap}
              loading={personbogLoading}
              fejl={personbogFejl}
              // BIZZ-339: Ingen CVR at slå op — e-TL personbog API kræver CVR-nummer
              ingenVirksomheder={!personbogLoading && (data?.virksomheder.length ?? 0) === 0}
              c={c}
              da={lang === 'da'}
              expandedPant={expandedPant}
              setExpandedPant={setExpandedPant}
              selectedPantDocs={selectedPantDocs}
              setSelectedPantDocs={setSelectedPantDocs}
            />
          )}
        </div>
      </div>
      {/* END left: main content */}

      {/* ─── Nyheder/sociale medier panel (desktop) ─── */}
      {isDesktop && nyhedsPanelÅben && (
        <div
          className="flex-shrink-0 self-stretch flex flex-col overflow-hidden border-l border-slate-700/50"
          style={{ width: 340 }}
        >
          {/* Panel-header */}
          <div className="flex items-center justify-between px-4 py-3 bg-slate-900 border-b border-slate-700/50 flex-shrink-0">
            <div className="flex items-center gap-2">
              <Newspaper size={14} className="text-blue-400" />
              <span className="text-white text-sm font-medium">
                {lang === 'da' ? 'Medier & links' : 'Media & links'}
              </span>
            </div>
            <button
              onClick={() => setNyhedsPanelÅben(false)}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
              aria-label={lang === 'da' ? 'Luk panel' : 'Close panel'}
            >
              <X size={14} />
            </button>
          </div>
          {/* Panel-indhold: ØVERST nyheder (AI), NEDERST sociale medier */}
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5 min-h-0">
            {/* AI Artikel søgning */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Sparkles size={12} className="text-blue-400" />
                <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                  {lang === 'da' ? 'AI Artikel søgning' : 'AI Article Search'}
                </p>
              </div>
              <PersonArticleSearchPanel
                personData={data}
                lang={lang}
                onSocialsFound={setAiSocials}
                onAlternativesFound={setAiAlternatives}
                onThresholdFound={setConfidenceThreshold}
                onContactsFound={setAiContacts}
              />
            </div>
            {/* Sociale medier & links */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Globe size={12} className="text-slate-500" />
                <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                  {lang === 'da' ? 'Sociale medier' : 'Social media'}
                </p>
              </div>
              <VerifiedLinks
                entityType="person"
                entityId={String(data.enhedsNummer)}
                entityName={data.navn}
                lang={lang}
                aiSocials={aiSocials}
                aiAlternatives={aiAlternatives}
                confidenceThreshold={confidenceThreshold}
              />
            </div>
            {/* Kontaktoplysninger — vises kun efter AI-søgning */}
            {aiContacts.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <User size={12} className="text-slate-500" />
                  <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                    {lang === 'da' ? 'Kontaktoplysninger' : 'Contact info'}
                  </p>
                </div>
                <ContactList contacts={aiContacts} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Mobil: Nyheder-overlay — fylder hele skærmen ─── */}
      {!isDesktop && mobilNyhederAaben && (
        <div className="fixed inset-0 z-50 flex flex-col bg-slate-950">
          {/* Overlay-header */}
          <div className="flex items-center justify-between px-4 py-3 bg-slate-900 border-b border-slate-700/50 flex-shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <Newspaper size={15} className="text-blue-400 flex-shrink-0" />
              <span className="text-white text-sm font-medium truncate">
                {lang === 'da' ? 'Medier & links' : 'Media & links'}
              </span>
            </div>
            <button
              onClick={() => setMobilNyhederAaben(false)}
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors flex-shrink-0"
              aria-label={lang === 'da' ? 'Luk' : 'Close'}
            >
              <X size={18} />
            </button>
          </div>
          {/* Indhold */}
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5 min-h-0">
            {/* AI Artikel søgning */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Sparkles size={12} className="text-blue-400" />
                <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                  {lang === 'da' ? 'AI Artikel søgning' : 'AI Article Search'}
                </p>
              </div>
              <PersonArticleSearchPanel
                personData={data}
                lang={lang}
                onSocialsFound={setAiSocials}
                onAlternativesFound={setAiAlternatives}
                onThresholdFound={setConfidenceThreshold}
                onContactsFound={setAiContacts}
              />
            </div>
            {/* Sociale medier & links */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Globe size={12} className="text-slate-500" />
                <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                  {lang === 'da' ? 'Sociale medier' : 'Social media'}
                </p>
              </div>
              <VerifiedLinks
                entityType="person"
                entityId={String(data.enhedsNummer)}
                entityName={data.navn}
                lang={lang}
                aiSocials={aiSocials}
                aiAlternatives={aiAlternatives}
                confidenceThreshold={confidenceThreshold}
              />
            </div>
            {/* Kontaktoplysninger — vises kun efter AI-søgning */}
            {aiContacts.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <User size={12} className="text-slate-500" />
                  <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                    {lang === 'da' ? 'Kontaktoplysninger' : 'Contact info'}
                  </p>
                </div>
                <ContactList contacts={aiContacts} />
              </div>
            )}
          </div>
          {/* Build-nummer */}
          <div className="px-4 py-2 border-t border-slate-700/30 flex-shrink-0">
            <p className="text-slate-600 text-xs">
              Build: {process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ContactList ───────────────────────────────────────────────────────────────

/**
 * ContactList — viser AI-fundne kontaktoplysninger som kort-liste.
 * Hvert kort viser adresse, telefon (klikbart), email (klikbart), kilde og confidence badge.
 * Ingen filtrering baseret på confidence — viser ALT.
 *
 * @param contacts - Liste af ContactResult fra AI
 */
function ContactList({ contacts }: { contacts: ContactResult[] }) {
  return (
    <div className="space-y-2.5">
      {contacts.map((c, i) => {
        const badgeColor =
          c.confidence >= 85
            ? 'bg-green-500/15 text-green-400 border-green-500/30'
            : c.confidence >= 70
              ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
              : 'bg-red-500/15 text-red-400 border-red-500/30';

        return (
          <div
            key={i}
            className="rounded-lg bg-slate-800/60 border border-slate-700/50 p-3 space-y-1.5"
          >
            {/* Confidence badge + kilde */}
            <div className="flex items-center justify-between gap-2">
              <a
                href={c.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-blue-400 hover:text-blue-300 truncate flex items-center gap-1"
              >
                <ExternalLink size={9} className="flex-shrink-0" />
                {c.source}
              </a>
              <span
                className={`text-[10px] font-medium px-1.5 py-0.5 rounded border flex-shrink-0 ${badgeColor}`}
              >
                {c.confidence}%
              </span>
            </div>
            {/* Adresse */}
            {c.address && <p className="text-slate-300 text-xs leading-snug">{c.address}</p>}
            {/* Telefon */}
            {c.phone && (
              <a
                href={`tel:${c.phone.replace(/\s/g, '')}`}
                className="block text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                {c.phone}
              </a>
            )}
            {/* Email */}
            {c.email && (
              <a
                href={`mailto:${c.email}`}
                className="block text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                {c.email}
              </a>
            )}
            {/* Begrundelse */}
            {c.reason && <p className="text-slate-600 text-[10px] leading-snug">{c.reason}</p>}
          </div>
        );
      })}
    </div>
  );
}

// ─── PersonArticleSearchPanel ─────────────────────────────────────────────────

/**
 * Konverterer en dato-streng (ISO, relativ "X days ago", dansk tekst) til sorterbar timestamp.
 * Returnerer 0 hvis datoen ikke kan parses — disse vises sidst.
 *
 * @param dateStr - Datostreng fra API-svar
 * @returns Unix timestamp i millisekunder
 */
function parseDateForClientSort(dateStr: string | undefined): number {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d.getTime();
  const agoMatch = dateStr.match(/(\d+)\s+(hour|day|week|month|year|time|dag|uge|m.ned|.r)/i);
  if (agoMatch) {
    const n = parseInt(agoMatch[1], 10);
    const unit = agoMatch[2].toLowerCase();
    const now = Date.now();
    if (unit.startsWith('hour') || unit.startsWith('time')) return now - n * 3_600_000;
    if (unit.startsWith('day') || unit.startsWith('dag')) return now - n * 86_400_000;
    if (unit.startsWith('week') || unit.startsWith('uge')) return now - n * 7 * 86_400_000;
    if (unit.startsWith('month') || unit.startsWith('m')) return now - n * 30 * 86_400_000;
    if (unit.startsWith('year') || unit.startsWith('.r')) return now - n * 365 * 86_400_000;
  }
  return 0;
}

/**
 * Synkroniserer token-forbrug til Supabase i baggrunden (fire-and-forget).
 *
 * @param tokensUsed - Antal forbrugte tokens
 */
function syncPersonTokenUsageToServer(tokensUsed: number) {
  if (tokensUsed <= 0) return;
  fetch('/api/subscription/track-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokensUsed }),
  }).catch(() => {
    /* stille fejl */
  });
}

/** Et nyhedsresultat fra AI artikel søgning */
interface PersonAIArticleResult {
  title: string;
  url: string;
  source: string;
  date?: string;
  description?: string;
}

/** En kontaktoplysning fundet via AI */
interface ContactResult {
  address?: string;
  phone?: string;
  email?: string;
  source: string;
  sourceUrl: string;
  confidence: number;
  reason?: string;
}

/**
 * PersonArticleSearchPanel — AI-drevet artikelsøgning i nyheds-sidepanelet på personsiden.
 *
 * Viser tokens til rådighed og en "Søg"-knap. Når brugeren klikker,
 * hentes nyheder om personen via /api/ai/person-search/articles med dynamisk batching.
 * Søger personens navn + ALLE tilknyttede virksomheder i batches af 5.
 * Viser artikler progressivt — nye artikler tilføjes til listen med fade-in.
 * Kalder onSocialsFound med AI-fundne personlige sociale medier-URLs.
 * Kalder onContactsFound med AI-fundne kontaktoplysninger.
 *
 * @param personData - PersonPublicData for den valgte person
 * @param lang - Aktivt sprog
 * @param onSocialsFound - Callback med fundne sociale medier-URLs inkl. confidence
 * @param onAlternativesFound - Callback med alternative links per platform
 * @param onThresholdFound - Callback med confidence-tærskel fra ai_settings
 * @param onContactsFound - Callback med fundne kontaktoplysninger
 */
function PersonArticleSearchPanel({
  personData,
  lang,
  onSocialsFound,
  onAlternativesFound,
  onThresholdFound,
  onContactsFound,
}: {
  personData: PersonPublicData;
  lang: 'da' | 'en';
  onSocialsFound?: (
    socials: Record<string, { url: string; confidence: number; reason?: string }>
  ) => void;
  onAlternativesFound?: (
    alternatives: Record<string, Array<{ url: string; confidence: number; reason?: string }>>
  ) => void;
  onThresholdFound?: (threshold: number) => void;
  onContactsFound?: (contacts: ContactResult[]) => void;
}) {
  const { subscription: ctxSub, addTokenUsage, isAdmin } = useSubscription();
  const { isActive: subActive } = useSubscriptionAccess('ai');
  const [articles, setArticles] = useState<PersonAIArticleResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  /** Individuelle loading-states per søge-kategori — til progressiv visning */
  const [socialsLoading, setSocialsLoading] = useState(false);
  const [articlesLoading, setArticlesLoading] = useState(false);
  const [contactsLoading, setContactsLoading] = useState(false);
  /**
   * Fase for artikelsøgning:
   * - 'idle'    — ikke søgt endnu
   * - 'raw'     — Serper-resultater vist (foreløbige, Claude-verificering i gang)
   * - 'curated' — Claude har returneret kurerede resultater
   */
  const [articlesPhase, setArticlesPhase] = useState<'idle' | 'raw' | 'curated'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [tokenInfo, setTokenInfo] = useState<{ used: number; limit: number } | null>(null);
  const [tokensUsedThisSearch, setTokensUsedThisSearch] = useState(0);
  /** Antal synlige artikler — starter på 5, øges med 5 ved hvert "Vis flere"-klik */
  const [visibleCount, setVisibleCount] = useState(5);

  /** Mindst én søge-kategori er stadig i gang */
  const anyLoading = socialsLoading || articlesLoading || contactsLoading;

  /** Opdaterer token-info fra subscription context */
  useEffect(() => {
    if (!ctxSub) {
      setTokenInfo(null);
      return;
    }
    const plan = resolvePlan(ctxSub.planId);
    if (!plan.aiEnabled) {
      setTokenInfo(null);
      return;
    }
    const limit =
      plan.aiTokensPerMonth < 0 ? -1 : plan.aiTokensPerMonth + (ctxSub.bonusTokens ?? 0);
    setTokenInfo({ used: ctxSub.tokensUsedThisMonth, limit });
  }, [ctxSub]);

  /**
   * Bygger liste af virksomheder personen er aktiv tilknyttet — bruges som søgekontekst.
   * Inkluderer alle aktive roller (ikke kun ejerroller) da artikel-søgning profiterer af
   * alle offentlige tilknytninger (DIREKTØR, STIFTER, EJER osv.).
   */
  const ownedCompanies = useMemo(() => {
    return personData.virksomheder
      .filter((v) => v.aktiv && v.roller.some((r) => !r.til))
      .map((v) => ({ cvr: v.cvr, name: v.navn }));
  }, [personData.virksomheder]);

  /**
   * Personens primære tilknyttede virksomhed — sendes som `company` til artikel-API'et
   * så Serper kan søge "{person}" + "{virksomhed}" for bedre præcision.
   * Tager den første aktive virksomhed med en aktiv rolle.
   */
  const primaryCompanyName = useMemo(() => {
    return ownedCompanies[0]?.name ?? undefined;
  }, [ownedCompanies]);

  /** Finder personens primære by fra ejervirksomhedernes adresser */
  const city = useMemo(() => {
    for (const v of personData.virksomheder) {
      if (v.aktiv && v.by) return v.by;
    }
    return undefined;
  }, [personData.virksomheder]);

  /**
   * Starter AI-søgning med 3 parallelle kald (socials, articles, contacts).
   * Artikler bruger to-fase progressiv loading:
   * - Fase 1 (?phase=raw, ~2-3s): Serper-resultater vises straks uden Claude.
   * - Fase 2 (?phase=ai, ~10-30s): Claude rangerer/filtrerer — erstatter raw hvis der er resultater.
   */
  const handleSearch = useCallback(async () => {
    if (anyLoading) return;

    // Admin users bypass subscription/token gating (mirrors subActive = isAdmin || ...).
    if (ctxSub && !isAdmin) {
      const plan = resolvePlan(ctxSub.planId);
      if (!isSubscriptionFunctional(ctxSub, plan)) return;
      if (!plan.aiEnabled) return;
      const limit =
        plan.aiTokensPerMonth < 0 ? -1 : plan.aiTokensPerMonth + (ctxSub.bonusTokens ?? 0);
      if (limit > 0 && ctxSub.tokensUsedThisMonth >= limit) return;
    }

    setHasSearched(true);
    setError(null);
    setArticles([]);
    setArticlesPhase('idle');
    setVisibleCount(5);
    setSocialsLoading(true);
    setArticlesLoading(true);
    setContactsLoading(true);
    setTokensUsedThisSearch(0);

    const sharedPayload = {
      personName: personData.navn,
      companies: ownedCompanies,
      city,
    };

    /** Payload til /api/ai/article-search/articles med entityType=person */
    const articlesPayload = JSON.stringify({
      entityType: 'person' as const,
      name: personData.navn,
      company: primaryCompanyName,
      city,
    });

    // ── Sociale medier (hurtigst ~2s) ──
    const socialsPromise = fetch('/api/ai/person-search/socials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sharedPayload),
    })
      .then(async (res) => {
        const json = await res.json();
        type SocialMeta = { url: string; confidence: number; reason?: string };
        const socialsWithMeta = json.socialsWithMeta as Record<string, SocialMeta> | undefined;
        if (socialsWithMeta && Object.keys(socialsWithMeta).length > 0) {
          onSocialsFound?.(socialsWithMeta);
        }
        type AltMeta = { url: string; confidence: number; reason?: string };
        const altsWithMeta = json.alternativesWithMeta as Record<string, AltMeta[]> | undefined;
        if (altsWithMeta && Object.keys(altsWithMeta).length > 0) {
          onAlternativesFound?.(altsWithMeta);
        }
        if (typeof json.confidenceThreshold === 'number') {
          onThresholdFound?.(json.confidenceThreshold);
        }
        return (json.tokensUsed as number) ?? 0;
      })
      .catch(() => 0)
      .finally(() => setSocialsLoading(false));

    // ── Artikler — progressiv to-fase loading ──
    // Fase 1 (?phase=raw, ~2-3s): Serper-resultater vises straks uden Claude.
    // Fase 2 (?phase=ai, ~10-30s): Claude rangerer/filtrerer — erstatter raw hvis der er resultater.
    // Begge kald startes parallelt så ventetiden på fase 2 begynder straks.

    const rawArticlesPromise = fetch('/api/ai/article-search/articles?phase=raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: articlesPayload,
    })
      .then(async (res) => {
        const json = await res.json();
        const rawArticles: PersonAIArticleResult[] = json.articles ?? [];
        if (rawArticles.length > 0) {
          // Sortér nyeste artikler øverst uanset API-rækkefølge
          const sorted = [...rawArticles].sort(
            (a, b) => parseDateForClientSort(b.date) - parseDateForClientSort(a.date)
          );
          setArticles(sorted);
          setArticlesPhase('raw');
          setVisibleCount(5);
        }
      })
      .catch(() => {
        // Stille fejl — AI-fasen fortsætter
      });

    const aiArticlesPromise = fetch('/api/ai/article-search/articles?phase=ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: articlesPayload,
    })
      .then(async (res) => {
        const json = await res.json();
        if (json.error) setError(json.error as string);
        const aiArticles: PersonAIArticleResult[] = json.articles ?? [];
        if (aiArticles.length > 0) {
          // Claude returnerede kuraterede resultater — erstat foreløbige
          const sorted = [...aiArticles].sort(
            (a, b) => parseDateForClientSort(b.date) - parseDateForClientSort(a.date)
          );
          setArticles(sorted);
          setVisibleCount(5);
        }
        // Sæt altid fase til curated når AI-kaldet er færdigt (selv hvis 0 resultater)
        setArticlesPhase('curated');
        return (json.tokensUsed as number) ?? 0;
      })
      .catch(() => 0)
      .finally(() => setArticlesLoading(false));

    const articlesPromise = rawArticlesPromise
      .then(() => aiArticlesPromise)
      .then((tokens) => tokens);

    // ── Kontaktoplysninger (~3-5s) ──
    const contactsPromise = fetch('/api/ai/person-search/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sharedPayload),
    })
      .then(async (res) => {
        const json = await res.json();
        const contacts = json.contacts as ContactResult[] | undefined;
        if (contacts && contacts.length > 0) {
          onContactsFound?.(contacts);
        }
        return (json.tokensUsed as number) ?? 0;
      })
      .catch(() => 0)
      .finally(() => setContactsLoading(false));

    // ── Vent på alle og rapportér samlet token-forbrug ──
    const [socialsTokens, articlesTokens, contactsTokens] = await Promise.all([
      socialsPromise,
      articlesPromise,
      contactsPromise,
    ]);
    const total = socialsTokens + articlesTokens + contactsTokens;
    if (total > 0) {
      setTokensUsedThisSearch(total);
      addTokenUsage(total);
      syncPersonTokenUsageToServer(total);
    }
  }, [
    anyLoading,
    ctxSub,
    isAdmin,
    personData,
    ownedCompanies,
    primaryCompanyName,
    city,
    addTokenUsage,
    onSocialsFound,
    onAlternativesFound,
    onThresholdFound,
    onContactsFound,
  ]);

  const da = lang === 'da';

  /** Locked state — ingen AI-adgang */
  if (!subActive) {
    return (
      <div className="flex flex-col items-center gap-2 py-3 text-center">
        <div className="w-8 h-8 bg-amber-500/10 rounded-lg flex items-center justify-center">
          <Lock size={14} className="text-amber-400" />
        </div>
        <p className="text-slate-500 text-xs leading-relaxed">
          {da
            ? 'AI-søgning kræver et aktivt abonnement.'
            : 'AI search requires an active subscription.'}
        </p>
      </div>
    );
  }

  /** Token-statusbar (vises over knap og resultater) */
  const tokenBar =
    tokenInfo && (tokenInfo.limit > 0 || tokenInfo.limit === -1) ? (
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[10px] text-slate-600 whitespace-nowrap">Tokens</span>
        {tokenInfo.limit === -1 ? (
          <>
            <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-purple-500 w-full" />
            </div>
            <span className="text-[10px] font-medium text-purple-400">∞</span>
          </>
        ) : (
          <>
            <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  tokenInfo.used / tokenInfo.limit > 0.9
                    ? 'bg-red-500'
                    : tokenInfo.used / tokenInfo.limit > 0.7
                      ? 'bg-amber-500'
                      : 'bg-blue-500'
                }`}
                style={{ width: `${Math.min(100, (tokenInfo.used / tokenInfo.limit) * 100)}%` }}
              />
            </div>
            <span
              className={`text-[10px] font-medium whitespace-nowrap ${
                tokenInfo.used / tokenInfo.limit > 0.9
                  ? 'text-red-400'
                  : tokenInfo.used / tokenInfo.limit > 0.7
                    ? 'text-amber-400'
                    : 'text-slate-500'
              }`}
            >
              {formatTokens(tokenInfo.used)}/{formatTokens(tokenInfo.limit)}
            </span>
          </>
        )}
      </div>
    ) : null;

  /** AI disclaimer — vises altid under token-bar */
  const aiDisclaimer = (
    <p className="text-xs text-slate-500 mb-3">
      ⚠️ Svar genereret af AI er ikke nødvendigvis korrekte. Verificér altid vigtig information.
    </p>
  );

  /** Go-state — søgning ikke startet endnu */
  if (!hasSearched) {
    return (
      <div>
        {tokenBar}
        {aiDisclaimer}
        <p className="text-slate-300 text-xs mb-3 leading-relaxed">
          {da
            ? `Klik for at finde op til 15 seneste nyheder om ${personData.navn} og link til personlige sider på sociale medier.`
            : `Click to find up to 15 latest news articles about ${personData.navn} and links to personal social media pages.`}
        </p>
        <button
          onClick={handleSearch}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 border border-blue-500/60 rounded-lg text-white text-xs font-medium transition-all"
        >
          <Zap size={12} />
          {da ? 'Søg med AI' : 'Search with AI'}
        </button>
      </div>
    );
  }

  /** Progressiv resultat-state — vises når søgning er startet */
  return (
    <div>
      {tokenBar}
      {aiDisclaimer}

      {/* Aktive loading-indikatorer per kategori */}
      {anyLoading && (
        <div className="space-y-1 mb-3">
          {socialsLoading && (
            <div className="flex items-center gap-2 text-slate-400 text-xs">
              <Loader2 size={10} className="animate-spin text-blue-400 flex-shrink-0" />
              <span>{da ? 'Søger sociale medier…' : 'Searching social media…'}</span>
            </div>
          )}
          {articlesLoading && (
            <div className="flex items-center gap-2 text-slate-400 text-xs">
              <Loader2 size={10} className="animate-spin text-purple-400 flex-shrink-0" />
              <span>
                {articlesPhase === 'raw'
                  ? da
                    ? 'Bekræfter med AI…'
                    : 'Verifying with AI…'
                  : da
                    ? 'Søger artikler…'
                    : 'Searching articles…'}
              </span>
            </div>
          )}
          {contactsLoading && (
            <div className="flex items-center gap-2 text-slate-400 text-xs">
              <Loader2 size={10} className="animate-spin text-green-400 flex-shrink-0" />
              <span>{da ? 'Søger kontaktoplysninger…' : 'Searching contacts…'}</span>
            </div>
          )}
        </div>
      )}

      {/* Token-forbrug (vises når alle er færdige) */}
      {!anyLoading && tokensUsedThisSearch > 0 && (
        <p className="text-[10px] text-slate-600 mb-3">
          {da
            ? `Brugte ${formatTokens(tokensUsedThisSearch)} tokens`
            : `Used ${formatTokens(tokensUsedThisSearch)} tokens`}
        </p>
      )}

      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}

      {/* Foreløbige resultater-badge — vises mens AI-verificering kører */}
      {articlesPhase === 'raw' && articles.length > 0 && (
        <p className="text-[10px] text-amber-500/70 mb-1.5">
          {da ? 'Foreløbige resultater — AI verificerer…' : 'Preliminary results — AI verifying…'}
        </p>
      )}

      {/* Artikler — fade-in når de ankommer */}
      {articlesLoading && articles.length === 0 ? null : articles.length === 0 &&
        !articlesLoading ? (
        <p className="text-slate-600 text-xs">
          {da
            ? 'Ingen danske medieartikler fundet for denne person.'
            : 'No Danish media articles found for this person.'}
        </p>
      ) : (
        <div
          className="space-y-2.5"
          style={{ animation: articles.length > 0 ? 'fadeIn 0.4s ease-in' : undefined }}
        >
          {articles.slice(0, visibleCount).map((a, i) => (
            <a
              key={i}
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-2 group"
            >
              <ExternalLink
                size={10}
                className="text-slate-600 group-hover:text-blue-400 flex-shrink-0 mt-0.5"
              />
              <div className="min-w-0">
                <p className="text-slate-300 text-xs font-medium group-hover:text-blue-300 transition-colors leading-snug">
                  {a.title}
                </p>
                <p className="text-slate-600 text-[10px] mt-0.5">
                  {a.source}
                  {a.date ? ` · ${a.date}` : ''}
                </p>
                {a.description && (
                  <p className="text-slate-600 text-[10px] mt-0.5 line-clamp-2">{a.description}</p>
                )}
              </div>
            </a>
          ))}
          {visibleCount < articles.length && (
            <button
              onClick={() => setVisibleCount((c) => Math.min(c + 5, articles.length))}
              className="mt-1 flex items-center gap-1 text-[10px] text-slate-500 hover:text-blue-400 transition-colors"
            >
              <ChevronDown size={10} />
              {da
                ? `Vis flere (${articles.length - visibleCount} mere)`
                : `Show more (${articles.length - visibleCount} more)`}
            </button>
          )}
        </div>
      )}

      {/* Søg igen (vises kun når alt er færdigt) */}
      {!anyLoading && (
        <button
          onClick={handleSearch}
          className="mt-3 flex items-center gap-1.5 text-[10px] text-slate-500 hover:text-blue-400 transition-colors"
        >
          <Zap size={9} />
          {da ? 'Søg igen' : 'Search again'}
        </button>
      )}
    </div>
  );
}
// ─── GroupTab ───────────────────────────────────────────────────────────────

/**
 * Gruppe-tab — company-page-style 3-sektion kort (Stamdata, Organisation, Regnskab)
 * med hierarkisk rendering og datterselskaber.
 */
function GroupTab({
  data: _data,
  ejerVirksomheder,
  andreVirksomheder,
  relatedCompanies,
  relatedLoading,
  noeglePersonerMap,
  lang,
}: {
  data: PersonPublicData;
  ejerVirksomheder: PersonCompanyRole[];
  andreVirksomheder: PersonCompanyRole[];
  relatedCompanies: Map<number, RelateretVirksomhed[]>;
  relatedLoading: boolean;
  noeglePersonerMap: Map<
    number,
    {
      bestyrelse: { navn: string; enhedsNummer: number }[];
      direktion: { navn: string; enhedsNummer: number }[];
    }
  >;
  lang: 'da' | 'en';
}) {
  const router = useRouter();

  /** Formatér tal kort (tusinder/millioner) */
  const fmtKr = (n: number | null) => {
    if (n == null) return '–';
    const abs = Math.abs(n);
    if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')} mio`;
    if (abs >= 1_000) return `${Math.round(n / 1_000)} t.kr`;
    return n.toLocaleString('da-DK');
  };

  /** Brug den delte nøglepersonerMap fra parent */
  const gruppePersoner = noeglePersonerMap;

  /** Regnskabsdata per CVR */
  const [gruppeFinans, setGruppeFinans] = useState<
    Map<number, { brutto: number | null; balance: number | null; egenkapital: number | null }>
  >(new Map());
  const [gruppeFinansLoading, setGruppeFinansLoading] = useState(false);
  const gruppeFinansFetchedRef = useRef(false);

  /** Hent regnskabstal for alle ejervirksomheder + datterselskaber */
  useEffect(() => {
    if (gruppeFinansFetchedRef.current) return;
    const allCvrs: number[] = [];
    for (const v of ejerVirksomheder) {
      allCvrs.push(v.cvr);
      for (const r of relatedCompanies.get(v.cvr) ?? []) {
        if (r.aktiv) allCvrs.push(r.cvr);
      }
    }
    if (allCvrs.length === 0) return;
    gruppeFinansFetchedRef.current = true;
    setGruppeFinansLoading(true);

    Promise.all(
      allCvrs.map(async (cvr) => {
        try {
          const res = await fetch(`/api/regnskab/xbrl?cvr=${cvr}`, {
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) return null;
          const json = await res.json();
          const years = json.years ?? [];
          if (years.length === 0) return null;
          const y = years[0];
          return {
            cvr,
            brutto: y.resultat?.bruttofortjeneste ?? null,
            balance: y.balance?.aktiverIAlt ?? null,
            egenkapital: y.balance?.egenkapital ?? null,
          };
        } catch {
          return null;
        }
      })
    ).then((results) => {
      const map = new Map<
        number,
        { brutto: number | null; balance: number | null; egenkapital: number | null }
      >();
      for (const r of results) {
        if (r) map.set(r.cvr, { brutto: r.brutto, balance: r.balance, egenkapital: r.egenkapital });
      }
      setGruppeFinans(map);
      setGruppeFinansLoading(false);
    });
  }, [ejerVirksomheder, relatedCompanies]);

  // ── Alle synlige CVR'er for andre-roller filtrering ──
  const allCvrs = useMemo(() => {
    const s = new Set<number>();
    for (const v of ejerVirksomheder) {
      s.add(v.cvr);
      for (const r of relatedCompanies.get(v.cvr) ?? []) s.add(r.cvr);
    }
    return s;
  }, [ejerVirksomheder, relatedCompanies]);
  const filteredAndre = andreVirksomheder.filter((v) => !allCvrs.has(v.cvr));

  /** Render et 3-sektions kort for en RelateretVirksomhed */
  const renderCard = (rel: RelateretVirksomhed, depth: number) => {
    const fin = gruppeFinans.get(rel.cvr);
    return (
      <button
        key={rel.cvr}
        onClick={() => router.push(`/dashboard/companies/${rel.cvr}`)}
        className={`w-full bg-[#0f1729] border border-slate-700/50 rounded-xl px-4 py-3.5 text-left hover:border-blue-500/40 hover:bg-[#131d36] transition-all group ${depth > 0 ? 'border-l-2 border-l-blue-500/30' : ''}`}
      >
        {/* Øverste linje: Navn + badges */}
        <div className="flex items-center gap-2 mb-3">
          <Building2
            size={15}
            className="text-slate-500 group-hover:text-blue-400 shrink-0 transition-colors"
          />
          <span className="text-white text-sm font-semibold truncate group-hover:text-blue-300 transition-colors">
            {rel.navn}
          </span>
          {rel.ejerandel && (
            <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20">
              {rel.ejerandel}
            </span>
          )}
          {rel.aktiv ? (
            <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
              {lang === 'da' ? 'Aktiv' : 'Active'}
            </span>
          ) : (
            <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-red-500/15 text-red-400 border border-red-500/20">
              {lang === 'da' ? 'Ophørt' : 'Dissolved'}
            </span>
          )}
          <ExternalLink
            size={12}
            className="ml-auto text-slate-600 group-hover:text-blue-400 shrink-0 transition-colors"
          />
        </div>

        {/* 3 sektioner med vertikale dividers */}
        <div className="flex items-stretch gap-0 rounded-lg bg-[#0a1020]/60 border border-slate-700/30">
          {/* Stamdata */}
          <div className="flex-[3] min-w-0 px-3.5 py-2.5">
            <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
              Stamdata
            </div>
            <div className="text-xs text-slate-300">
              CVR {rel.cvr} · {rel.form ?? ''}
            </div>
            {rel.branche && (
              <div className="text-[11px] text-slate-400 truncate mt-0.5">{rel.branche}</div>
            )}
            {rel.adresse && (
              <div className="text-[11px] text-slate-500 truncate mt-0.5">
                {rel.adresse}
                {rel.postnr ? `, ${rel.postnr}` : ''}
                {rel.by ? ` ${rel.by}` : ''}
              </div>
            )}
            {rel.direktoer && (
              <div className="text-[11px] text-slate-400 truncate mt-0.5">Dir. {rel.direktoer}</div>
            )}
          </div>
          <div className="w-px bg-slate-700/40 self-stretch my-2" />
          {/* Bestyrelse */}
          <div className="flex-[2] min-w-0 px-3.5 py-2.5">
            <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
              {lang === 'da' ? 'Bestyrelse' : 'Board'}
            </div>
            <div className="space-y-1">
              {(rel.bestyrelse ?? []).length > 0 ? (
                rel.bestyrelse.map((p, i) => (
                  <button
                    key={i}
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`/dashboard/owners/${p.enhedsNummer}`);
                    }}
                    className="group/p w-full flex items-center gap-1 text-left"
                  >
                    <User
                      size={9}
                      className="text-slate-600 group-hover/p:text-purple-400 flex-shrink-0"
                    />
                    <span className="text-slate-300 text-[11px] truncate group-hover/p:text-purple-300 transition-colors">
                      {p.navn}
                    </span>
                  </button>
                ))
              ) : (
                <p className="text-slate-600 text-[10px]">–</p>
              )}
            </div>
          </div>
          <div className="w-px bg-slate-700/40 self-stretch my-2" />
          {/* Direktion */}
          <div className="flex-[2] min-w-0 px-3.5 py-2.5">
            <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
              {lang === 'da' ? 'Direktion' : 'Management'}
            </div>
            <div className="space-y-1">
              {(rel.direktion ?? []).length > 0 ? (
                rel.direktion.map((p, i) => (
                  <button
                    key={i}
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`/dashboard/owners/${p.enhedsNummer}`);
                    }}
                    className="group/p w-full flex items-center gap-1 text-left"
                  >
                    <User
                      size={9}
                      className="text-slate-600 group-hover/p:text-amber-400 flex-shrink-0"
                    />
                    <span className="text-slate-300 text-[11px] truncate group-hover/p:text-amber-300 transition-colors">
                      {p.navn}
                    </span>
                  </button>
                ))
              ) : (
                <p className="text-slate-600 text-[10px]">–</p>
              )}
            </div>
          </div>
          <div className="w-px bg-slate-700/40 self-stretch my-2" />
          {/* Organisation */}
          <div className="flex-[2] min-w-0 px-3.5 py-2.5">
            <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
              Organisation
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-500">Ansatte</span>
                <span className="text-slate-300 font-medium tabular-nums">
                  {rel.ansatte ?? '–'}
                </span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-500">P-enheder</span>
                <span className="text-slate-300 font-medium tabular-nums">{rel.antalPenheder}</span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-500">Datterselskaber</span>
                <span className="text-slate-300 font-medium tabular-nums">
                  {rel.antalDatterselskaber}
                </span>
              </div>
            </div>
          </div>
          <div className="w-px bg-slate-700/40 self-stretch my-2" />
          {/* Regnskab */}
          <div className="flex-[2] min-w-0 px-3.5 py-2.5">
            <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
              Regnskab
              {gruppeFinansLoading && !fin && (
                <Loader2 size={8} className="inline ml-1 animate-spin" />
              )}
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-500">Brutto</span>
                <span
                  className={`font-medium tabular-nums ${fin?.brutto != null ? (fin.brutto >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-500'}`}
                >
                  {fin ? fmtKr(fin.brutto) : '–'}
                </span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-500">Balance</span>
                <span className="font-medium tabular-nums text-slate-300">
                  {fin ? fmtKr(fin.balance) : '–'}
                </span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-500">Egenkapital</span>
                <span
                  className={`font-medium tabular-nums ${fin?.egenkapital != null ? (fin.egenkapital >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-500'}`}
                >
                  {fin ? fmtKr(fin.egenkapital) : '–'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </button>
    );
  };

  /** Render et kort for en ejervirksomhed (PersonCompanyRole) med bestyrelse+direktion kolonner */
  const renderOwnerCard = (v: PersonCompanyRole) => {
    const fin = gruppeFinans.get(v.cvr);
    const pers = gruppePersoner.get(v.cvr);
    const ejerRolle = v.roller.find((r) => !r.til && r.ejerandel);
    return (
      <button
        key={v.cvr}
        onClick={() => router.push(`/dashboard/companies/${v.cvr}`)}
        className="w-full bg-[#0f1729] border border-slate-700/50 rounded-xl px-4 py-3.5 text-left hover:border-blue-500/40 hover:bg-[#131d36] transition-all group"
      >
        <div className="flex items-center gap-2 mb-3">
          <Building2
            size={15}
            className="text-slate-500 group-hover:text-blue-400 shrink-0 transition-colors"
          />
          <span className="text-white text-sm font-semibold truncate group-hover:text-blue-300 transition-colors">
            {v.navn}
          </span>
          {ejerRolle?.ejerandel && (
            <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20">
              {ejerRolle.ejerandel}
            </span>
          )}
          <span
            className={`shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium ${v.aktiv ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/15 text-red-400 border border-red-500/20'}`}
          >
            {v.aktiv
              ? lang === 'da'
                ? 'Aktiv'
                : 'Active'
              : lang === 'da'
                ? 'Ophørt'
                : 'Dissolved'}
          </span>
          <ExternalLink
            size={12}
            className="ml-auto text-slate-600 group-hover:text-blue-400 shrink-0 transition-colors"
          />
        </div>
        <div className="flex items-stretch gap-0 rounded-lg bg-[#0a1020]/60 border border-slate-700/30">
          <div className="flex-[3] min-w-0 px-3.5 py-2.5">
            <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
              Stamdata
            </div>
            <div className="text-xs text-slate-300">
              CVR {v.cvr} · {v.form ?? ''}
            </div>
            {v.branche && (
              <div className="text-[11px] text-slate-400 truncate mt-0.5">{v.branche}</div>
            )}
            {v.adresse && (
              <div className="text-[11px] text-slate-500 truncate mt-0.5">
                {v.adresse}
                {v.postnr ? `, ${v.postnr}` : ''}
                {v.by ? ` ${v.by}` : ''}
              </div>
            )}
          </div>
          <div className="w-px bg-slate-700/40 self-stretch my-2" />
          {/* Bestyrelse */}
          <div className="flex-[2] min-w-0 px-3.5 py-2.5">
            <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
              {lang === 'da' ? 'Bestyrelse' : 'Board'}
            </div>
            <div className="space-y-1">
              {pers?.bestyrelse && pers.bestyrelse.length > 0 ? (
                pers.bestyrelse.map((p, i) => (
                  <button
                    key={i}
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`/dashboard/owners/${p.enhedsNummer}`);
                    }}
                    className="group/p w-full flex items-center gap-1 text-left"
                  >
                    <User
                      size={9}
                      className="text-slate-600 group-hover/p:text-purple-400 flex-shrink-0"
                    />
                    <span className="text-slate-300 text-[11px] truncate group-hover/p:text-purple-300 transition-colors">
                      {p.navn}
                    </span>
                  </button>
                ))
              ) : (
                <p className="text-slate-600 text-[10px]">–</p>
              )}
            </div>
          </div>
          <div className="w-px bg-slate-700/40 self-stretch my-2" />
          {/* Direktion */}
          <div className="flex-[2] min-w-0 px-3.5 py-2.5">
            <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
              {lang === 'da' ? 'Direktion' : 'Management'}
            </div>
            <div className="space-y-1">
              {pers?.direktion && pers.direktion.length > 0 ? (
                pers.direktion.map((p, i) => (
                  <button
                    key={i}
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`/dashboard/owners/${p.enhedsNummer}`);
                    }}
                    className="group/p w-full flex items-center gap-1 text-left"
                  >
                    <User
                      size={9}
                      className="text-slate-600 group-hover/p:text-amber-400 flex-shrink-0"
                    />
                    <span className="text-slate-300 text-[11px] truncate group-hover/p:text-amber-300 transition-colors">
                      {p.navn}
                    </span>
                  </button>
                ))
              ) : (
                <p className="text-slate-600 text-[10px]">–</p>
              )}
            </div>
          </div>
          <div className="w-px bg-slate-700/40 self-stretch my-2" />
          {/* Organisation */}
          <div className="flex-[2] min-w-0 px-3.5 py-2.5">
            <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
              Organisation
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-500">Ansatte</span>
                <span className="text-slate-300 font-medium tabular-nums">{v.ansatte ?? '–'}</span>
              </div>
            </div>
          </div>
          <div className="w-px bg-slate-700/40 self-stretch my-2" />
          <div className="flex-[2] min-w-0 px-3.5 py-2.5">
            <div className="text-[10px] text-slate-500/80 font-medium uppercase tracking-wider mb-1.5">
              Regnskab
              {gruppeFinansLoading && !fin && (
                <Loader2 size={8} className="inline ml-1 animate-spin" />
              )}
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-500">Brutto</span>
                <span
                  className={`font-medium tabular-nums ${fin?.brutto != null ? (fin.brutto >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-500'}`}
                >
                  {fin ? fmtKr(fin.brutto) : '–'}
                </span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-500">Balance</span>
                <span className="font-medium tabular-nums text-slate-300">
                  {fin ? fmtKr(fin.balance) : '–'}
                </span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-slate-500">Egenkapital</span>
                <span
                  className={`font-medium tabular-nums ${fin?.egenkapital != null ? (fin.egenkapital >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-500'}`}
                >
                  {fin ? fmtKr(fin.egenkapital) : '–'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </button>
    );
  };

  return (
    <div className="space-y-4">
      {relatedLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
          <span className="ml-2 text-slate-400 text-sm">
            {lang === 'da' ? 'Henter gruppevirksomheder…' : 'Loading group companies…'}
          </span>
        </div>
      )}

      {!relatedLoading && (
        <>
          {/* Andre roller — øverst, klappet sammen som default */}
          {filteredAndre.length > 0 && (
            <CollapsibleSection
              title={lang === 'da' ? 'Andre roller' : 'Other roles'}
              count={filteredAndre.length}
              defaultOpen={false}
            >
              <div className="space-y-1">
                {filteredAndre.map((v) => (
                  <CompanyRowCompact key={v.cvr} v={v} lang={lang} />
                ))}
              </div>
            </CollapsibleSection>
          )}

          {ejerVirksomheder.length > 0 ? (
            <div className="grid gap-3">
              {ejerVirksomheder.map((v) => {
                const related = (relatedCompanies.get(v.cvr) ?? []).filter((r) => r.aktiv);
                // Byg hierarki: root = direkte ejet af ejervirksomheden, børn = ejetAfCvr
                const rodVirksomheder = related.filter(
                  (r) => !r.ejetAfCvr || r.ejetAfCvr === v.cvr
                );
                const boernMap = new Map<number, RelateretVirksomhed[]>();
                for (const r of related) {
                  if (r.ejetAfCvr && r.ejetAfCvr !== v.cvr) {
                    const arr = boernMap.get(r.ejetAfCvr) ?? [];
                    arr.push(r);
                    boernMap.set(r.ejetAfCvr, arr);
                  }
                }
                /** Recursive tree renderer (identical to company page renderTree) */
                const renderTree = (rel: RelateretVirksomhed, depth: number): React.ReactNode => (
                  <div
                    key={rel.cvr}
                    style={depth > 0 ? { paddingLeft: `${depth * 32}px` } : undefined}
                  >
                    {renderCard(rel, depth)}
                    {boernMap.has(rel.cvr) && (
                      <div className="grid gap-2 mt-2">
                        {boernMap.get(rel.cvr)!.map((child) => renderTree(child, depth + 1))}
                      </div>
                    )}
                  </div>
                );
                return (
                  <div key={v.cvr}>
                    {renderOwnerCard(v)}
                    {rodVirksomheder.length > 0 && (
                      <div className="ml-8 mt-2 grid gap-2">
                        {rodVirksomheder.map((r) => renderTree(r, 0))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState
              ikon={<Building2 size={32} className="text-slate-600" />}
              tekst={lang === 'da' ? 'Ingen ejede virksomheder' : 'No owned companies'}
            />
          )}
        </>
      )}
    </div>
  );
}

// ─── ChronologyTab ──────────────────────────────────────────────────────────

/**
 * Kronologi — viser roller kronologisk: Periode | Rolle | Selskab (med status-tag).
 * Filtrerer EJERREGISTER-roller fra og viser ikke adresser.
 */
function ChronologyTab({ data, lang }: { data: PersonPublicData; lang: 'da' | 'en' }) {
  const router = useRouter();
  const [filter, setFilter] = useState<string | null>(null);

  // Saml alle roller, ekskluder EJERREGISTER
  const alleRoller = data.virksomheder.flatMap((v) =>
    v.roller.filter((r) => !erEjerregister(r.rolle)).map((r) => ({ ...r, virksomhed: v }))
  );

  // Sortér nyeste først (brug filterDummyDato for sortering)
  alleRoller.sort((a, b) => {
    const da = filterDummyDato(a.fra) ?? '';
    const db = filterDummyDato(b.fra) ?? '';
    return db.localeCompare(da);
  });

  const kategorier = [...new Set(alleRoller.map((r) => rolleKategori(r.rolle)))];
  const filtered = filter
    ? alleRoller.filter((r) => rolleKategori(r.rolle) === filter)
    : alleRoller;

  return (
    <div className="space-y-4">
      <h2 className="text-white font-semibold text-base flex items-center gap-2">
        <Clock size={16} className="text-blue-400" />
        {lang === 'da' ? 'Kronologi' : 'Chronology'}
        <span className="text-slate-500 text-sm font-normal">({alleRoller.length})</span>
      </h2>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setFilter(null)}
          className={`px-3 py-1 rounded-full text-xs font-medium transition-all border ${
            filter === null
              ? 'bg-white/10 border-white/30 text-white'
              : 'bg-slate-800/50 border-slate-700/40 text-slate-400 hover:text-slate-200'
          }`}
        >
          {lang === 'da' ? 'Alle' : 'All'} ({alleRoller.length})
        </button>
        {kategorier.map((kat) => {
          const count = alleRoller.filter((r) => rolleKategori(r.rolle) === kat).length;
          return (
            <button
              key={kat}
              onClick={() => setFilter(filter === kat ? null : kat)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-all border ${
                filter === kat
                  ? 'bg-blue-600/30 border-blue-500/50 text-blue-300'
                  : 'bg-slate-800/50 border-slate-700/40 text-slate-400 hover:text-slate-200'
              }`}
            >
              {kat} ({count})
            </button>
          );
        })}
      </div>

      {/* Kronologi-liste */}
      <div className="space-y-1.5">
        {filtered.map((r, i) => {
          const fraStr = filterDummyDato(r.fra);
          const tilStr = filterDummyDato(r.til);

          return (
            <div
              key={i}
              className={`flex items-center gap-4 px-4 py-2.5 rounded-lg transition ${
                !r.til
                  ? 'bg-slate-800/40 border border-slate-700/40'
                  : 'bg-slate-900/30 border border-transparent hover:bg-slate-800/30'
              }`}
            >
              {/* Periode */}
              <div className="w-[180px] flex-shrink-0">
                <p className="text-slate-400 text-xs">
                  {fraStr ? formatDatoKort(fraStr) : '?'} —{' '}
                  {tilStr ? (
                    formatDatoKort(tilStr)
                  ) : (
                    <span className="text-emerald-400">{lang === 'da' ? 'nu' : 'present'}</span>
                  )}
                </p>
              </div>

              {/* Rolle */}
              <div className="w-[120px] flex-shrink-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-white text-xs font-medium">{r.rolle}</span>
                  {r.ejerandel && (
                    <span className="text-[9px] text-emerald-400">{r.ejerandel}</span>
                  )}
                </div>
              </div>

              {/* Selskab + status */}
              <div className="flex-1 min-w-0 flex items-center gap-2">
                <button
                  onClick={() => router.push(`/dashboard/companies/${r.virksomhed.cvr}`)}
                  className="group flex items-center gap-1.5 min-w-0"
                >
                  <Building2
                    size={11}
                    className="text-slate-500 group-hover:text-blue-400 flex-shrink-0"
                  />
                  <span className="text-slate-300 text-xs font-medium truncate group-hover:text-blue-300 transition-colors">
                    {r.virksomhed.navn}
                  </span>
                  <ExternalLink
                    size={9}
                    className="text-slate-600 group-hover:text-blue-400 flex-shrink-0"
                  />
                </button>

                {/* Status tag */}
                <span
                  className={`px-1.5 py-0.5 rounded text-[8px] font-medium flex-shrink-0 ${
                    r.virksomhed.aktiv
                      ? 'bg-emerald-600/20 text-emerald-400'
                      : 'bg-red-600/20 text-red-400'
                  }`}
                >
                  {r.virksomhed.aktiv
                    ? lang === 'da'
                      ? 'Aktiv'
                      : 'Active'
                    : lang === 'da'
                      ? 'Ophørt'
                      : 'Ceased'}
                </span>

                {/* Aktiv rolle tag */}
                {!r.til && (
                  <span className="px-1.5 py-0.5 rounded text-[8px] font-medium bg-blue-600/20 text-blue-300 flex-shrink-0">
                    {lang === 'da' ? 'Aktiv rolle' : 'Active role'}
                  </span>
                )}
              </div>
            </div>
          );
        })}

        {filtered.length === 0 && (
          <EmptyState
            ikon={<Clock size={24} className="text-slate-600" />}
            tekst={lang === 'da' ? 'Ingen roller fundet' : 'No roles found'}
          />
        )}
      </div>
    </div>
  );
}
