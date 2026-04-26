/**
 * EjendomHierarkiSections — Bilingual klient-komponent der renderer de
 * tre hierarki-specifikke blokke brugt på SFE/bygning/lejlighed-sider:
 *   1. Breadcrumb med lokaliserede labels
 *   2. "Tilhører hovedejendom" link-kort
 *   3. "Søster-enheder" / "Enheder i bygningen" sektion
 *
 * BIZZ-827 (iter 2b): tidligere hardkodet DA-strings på bygning- og
 * SFE-detaljesider. Da de er server-komponenter og `useLanguage()` er
 * client-only, indkapsles de bilingual-afhængige blokke i denne klient-
 * komponent — server-komponenterne delegerer rendering via props.
 *
 * Oversættelses-keys lever i `translations.hierarchy.*` (BIZZ-832).
 */

'use client';

import Link from 'next/link';
import { Building2, ChevronRight } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';

/**
 * Breadcrumb-niveau. Enten en stukket label (typeless) eller et key-
 * baseret niveau der slår op i `translations.hierarchy.*`.
 */
export type HierarkiLevelKey = 'dashboard' | 'properties' | 'sfe' | 'building' | 'condominium';

export interface HierarkiLevel {
  /** Key der slår op i translations.hierarchy. Når sat ignoreres label. */
  key?: HierarkiLevelKey;
  /** Optional parameter der renderes efter labelet (fx BFE-nummer). */
  param?: string | number;
  /** Fri tekst-label (hvis ikke key-baseret). */
  label?: string;
  /** URL — udeladt på current page. */
  href?: string;
}

/**
 * Søster-/bygningsenhed (subset af EjendomDetailPage's enheder).
 */
export interface SisterEnhed {
  id: string;
  etage: string | null;
  doer: string | null;
  anvendelse: string | null;
  areal: number | null;
}

interface Props {
  /** Breadcrumb-niveauer (fra top til current page). Udelad for at skjule. */
  breadcrumb?: HierarkiLevel[];
  /**
   * BFE for hovedejendom (SFE) når tilstede → render "Tilhører
   * hovedejendom"-kort.
   */
  sfeBfe?: number | null;
  /**
   * Søster-enheder (andre enheder i samme bygning eller matrikel).
   * Renderes kun når array er ikke-tom.
   */
  sisterEnheder?: SisterEnhed[];
  /**
   * Overskrift for søster-sektionen — 'building' giver "Enheder i
   * bygningen", 'matrikel' giver "Søster-enheder".
   */
  sisterContext?: 'building' | 'matrikel';
}

/**
 * Rendér breadcrumb + hierarki-blokke med bilingual support.
 */
export default function EjendomHierarkiSections({
  breadcrumb,
  sfeBfe,
  sisterEnheder,
  sisterContext = 'building',
}: Props) {
  const { lang } = useLanguage();
  const h = translations[lang].hierarchy;

  const renderLabel = (lvl: HierarkiLevel): string => {
    if (lvl.label) return lvl.label;
    if (!lvl.key) return '';
    const base = h[lvl.key] ?? lvl.key;
    return lvl.param != null ? `${base} ${lvl.param}` : base;
  };

  return (
    <>
      {/* Breadcrumb */}
      {breadcrumb && breadcrumb.length > 0 && (
        <nav aria-label={h.breadcrumbLabel} className="text-xs">
          <ol className="flex flex-wrap items-center gap-1 text-slate-400">
            {breadcrumb.map((lvl, i) => {
              const isLast = i === breadcrumb.length - 1;
              const label = renderLabel(lvl);
              return (
                <li key={`${label}-${i}`} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight size={12} className="text-slate-600 shrink-0" />}
                  {isLast || !lvl.href ? (
                    <span
                      aria-current={isLast ? 'page' : undefined}
                      className={isLast ? 'text-slate-200 font-medium' : 'text-slate-400'}
                    >
                      {label}
                    </span>
                  ) : (
                    <Link
                      href={lvl.href}
                      className="text-slate-400 hover:text-white transition-colors"
                    >
                      {label}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      )}

      {/* "Tilhører hovedejendom" link-kort — render kun når SFE er kendt */}
      {sfeBfe != null && (
        <Link
          href={`/dashboard/ejendomme/sfe/${sfeBfe}`}
          className="flex items-center gap-3 px-4 py-3 rounded-lg bg-amber-500/5 border border-amber-500/20 hover:border-amber-500/40 transition-colors"
        >
          <Building2 size={16} className="text-amber-400 shrink-0" />
          <div className="flex-1">
            <p className="text-amber-300 text-sm font-medium">{h.belongsToMain}</p>
            <p className="text-slate-500 text-xs mt-0.5">
              {h.sfe} {sfeBfe} — {h.mainProperty}
            </p>
          </div>
        </Link>
      )}

      {/* Søster-enheder / enheder-i-bygningen sektion */}
      {sisterEnheder && sisterEnheder.length > 0 && (
        <div className="rounded-xl bg-[#0f172a] border border-slate-700/50 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-700/40 flex items-center justify-between">
            <h2 className="text-white text-sm font-semibold flex items-center gap-2">
              <Building2 size={14} className="text-blue-400" />
              {sisterContext === 'building'
                ? lang === 'da'
                  ? 'Enheder i bygningen'
                  : 'Units in the building'
                : h.siblingUnits}
            </h2>
            <span className="text-slate-500 text-xs">
              {sisterEnheder.length}{' '}
              {lang === 'da'
                ? sisterEnheder.length === 1
                  ? 'enhed'
                  : 'enheder'
                : sisterEnheder.length === 1
                  ? 'unit'
                  : 'units'}
            </span>
          </div>
          <div className="divide-y divide-slate-700/30">
            {sisterEnheder.map((e) => {
              const hasFloor = e.etage || e.doer;
              const unitLabel = hasFloor
                ? [e.etage, e.doer].filter(Boolean).join('. ')
                : lang === 'da'
                  ? 'Hovedadresse'
                  : 'Main address';
              return (
                <div key={e.id} className="px-4 py-2.5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <Building2 size={12} className="text-slate-500 shrink-0" />
                    <span className="text-slate-200 text-sm font-medium truncate">{unitLabel}</span>
                    {e.anvendelse && (
                      <span className="text-slate-500 text-xs truncate">· {e.anvendelse}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-slate-400 shrink-0">
                    {e.areal != null && <span>{e.areal} m²</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
