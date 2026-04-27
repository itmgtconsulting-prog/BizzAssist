/**
 * FilterPanel — sidepanel til filtrering af ejendomme.
 *
 * BIZZ-1007 fase 1: Vertikalt sidepanel (højre side) med geografi-filtre.
 * Erstatter det inline horisontale filterpanel fra BIZZ-28.
 * Filter-state synkroniseres til URL searchParams for delbare links.
 *
 * @param filters - Aktive filtervalg
 * @param onFiltersChange - Callback når filtre ændres
 * @param uniqueKommuner - Unikke kommunenavne fra loadede resultater
 * @param uniquePostnumre - Unikke postnumre fra loadede resultater
 * @param resultCount - Antal filtrerede resultater
 * @param isOpen - Om panelet er synligt
 * @param onClose - Callback til lukning
 * @param lang - 'da' | 'en'
 */

'use client';

import { X, RotateCcw } from 'lucide-react';

/** Kategorier for BBR-ejendomstype-filter */
export type EjendomstypeFilter = 'alle' | 'beboelse' | 'erhverv' | 'ubebygget';

/** Aktive filtervalg for ejendomme-listesiden */
export interface EjendomFilterState {
  /** Valgt kommunenavn (tom streng = ingen filter) */
  kommune: string;
  /** Ejendomstype baseret på BBR-anvendelse */
  ejendomstype: EjendomstypeFilter;
  /** Postnummer-filter (tom streng = ingen filter) */
  postnummer: string;
}

/** Standard filterstatus — ingen aktive filtre */
export const DEFAULT_FILTERS: EjendomFilterState = {
  kommune: '',
  ejendomstype: 'alle',
  postnummer: '',
};

/** Tæl antal aktive filtre */
export function countActiveFilters(f: EjendomFilterState): number {
  let n = 0;
  if (f.kommune) n++;
  if (f.ejendomstype !== 'alle') n++;
  if (f.postnummer) n++;
  return n;
}

/** Translations for filter panel */
const t = {
  da: {
    filtre: 'Filtre',
    nulstil: 'Nulstil',
    kommune: 'Kommune',
    alleKommuner: 'Alle kommuner',
    postnummer: 'Postnummer',
    postnummerPlaceholder: 'F.eks. 2100',
    ejendomstype: 'Ejendomstype',
    alle: 'Alle',
    beboelse: 'Beboelse',
    erhverv: 'Erhverv',
    ubebygget: 'Ubebygget',
    resultater: (n: number) => `${n} ejendomme`,
  },
  en: {
    filtre: 'Filters',
    nulstil: 'Reset',
    kommune: 'Municipality',
    alleKommuner: 'All municipalities',
    postnummer: 'Postal code',
    postnummerPlaceholder: 'E.g. 2100',
    ejendomstype: 'Property type',
    alle: 'All',
    beboelse: 'Residential',
    erhverv: 'Commercial',
    ubebygget: 'Undeveloped',
    resultater: (n: number) => `${n} properties`,
  },
};

interface Props {
  filters: EjendomFilterState;
  onFiltersChange: (f: EjendomFilterState) => void;
  uniqueKommuner: string[];
  uniquePostnumre: string[];
  resultCount: number;
  isOpen: boolean;
  onClose: () => void;
  lang: 'da' | 'en';
}

/**
 * Vertikalt filter-sidepanel med kommune, postnummer og ejendomstype.
 */
export default function FilterPanel({
  filters,
  onFiltersChange,
  uniqueKommuner,
  uniquePostnumre,
  resultCount,
  isOpen,
  onClose,
  lang,
}: Props) {
  const l = t[lang];
  const activeCount = countActiveFilters(filters);

  if (!isOpen) return null;

  return (
    <div className="w-72 shrink-0 border-l border-slate-700/50 bg-[#0a1020] flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700/50">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-white">{l.filtre}</h2>
          {activeCount > 0 && (
            <span className="bg-emerald-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
              {activeCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {activeCount > 0 && (
            <button
              type="button"
              onClick={() => onFiltersChange(DEFAULT_FILTERS)}
              className="text-slate-500 hover:text-slate-300 transition-colors"
              aria-label={l.nulstil}
              title={l.nulstil}
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-300 transition-colors"
            aria-label={lang === 'da' ? 'Luk filtre' : 'Close filters'}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Scrollbart indhold */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {/* ── Kommune ── */}
        <div>
          <label
            htmlFor="filter-kommune"
            className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5"
          >
            {l.kommune}
          </label>
          <select
            id="filter-kommune"
            value={filters.kommune}
            onChange={(e) => onFiltersChange({ ...filters, kommune: e.target.value })}
            className="w-full bg-slate-800 border border-slate-700/60 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500/60 transition-colors"
          >
            <option value="">{l.alleKommuner}</option>
            {uniqueKommuner.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>

        {/* ── Postnummer ── */}
        <div>
          <label
            htmlFor="filter-postnr"
            className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5"
          >
            {l.postnummer}
          </label>
          {uniquePostnumre.length > 0 ? (
            <select
              id="filter-postnr"
              value={filters.postnummer}
              onChange={(e) => onFiltersChange({ ...filters, postnummer: e.target.value })}
              className="w-full bg-slate-800 border border-slate-700/60 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500/60 transition-colors"
            >
              <option value="">{lang === 'da' ? 'Alle postnumre' : 'All postal codes'}</option>
              {uniquePostnumre.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="filter-postnr"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              value={filters.postnummer}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, '').slice(0, 4);
                onFiltersChange({ ...filters, postnummer: val });
              }}
              placeholder={l.postnummerPlaceholder}
              className="w-full bg-slate-800 border border-slate-700/60 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 outline-none focus:border-blue-500/60 transition-colors"
            />
          )}
        </div>

        {/* ── Ejendomstype ── */}
        <div>
          <span className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-2">
            {l.ejendomstype}
          </span>
          <div className="space-y-1.5">
            {(
              [
                ['alle', l.alle],
                ['beboelse', l.beboelse],
                ['erhverv', l.erhverv],
                ['ubebygget', l.ubebygget],
              ] as [EjendomstypeFilter, string][]
            ).map(([val, label]) => (
              <label key={val} className="flex items-center gap-2.5 cursor-pointer py-1 group">
                <input
                  type="radio"
                  name="filter-ejendom-type"
                  value={val}
                  checked={filters.ejendomstype === val}
                  onChange={() => onFiltersChange({ ...filters, ejendomstype: val })}
                  className="accent-emerald-500"
                />
                <span className="text-sm text-slate-300 group-hover:text-white transition-colors">
                  {label}
                </span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Footer med resultattæller */}
      <div className="px-4 py-3 border-t border-slate-700/50 text-center">
        <span className="text-xs text-slate-500">{l.resultater(resultCount)}</span>
      </div>
    </div>
  );
}
