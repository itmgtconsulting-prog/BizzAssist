'use client';

/**
 * FilterPanel (BIZZ-792 / BIZZ-788a) — generisk filter-komponent der
 * renderer et array af FilterSchema som primitives: multi-select,
 * dropdown, range, toggle.
 *
 * Design per ARCHITECT sign-off (2026-04-23):
 *   - Generisk typed — ingen hardcoded felter
 *   - 300ms debounced onFilterChange callback (debounce sker via
 *     useFiltersFromURL hook — denne komponent sender bare øjeblikkeligt)
 *   - matchCount prop: number | null → spinner når null
 *   - WCAG AA: aria-labels, keyboard nav, focus management
 *   - Samme darktheme som andre admin-paneler (#0a1020 / #0f172a)
 */

import { useCallback, useId } from 'react';
import { Loader2, SlidersHorizontal, ChevronRight } from 'lucide-react';
import type {
  FilterSchema,
  FilterState,
  MultiSelectFilterSchema,
  DropdownFilterSchema,
  RangeFilterSchema,
  ToggleFilterSchema,
} from '@/app/lib/search/filterSchema';

export interface FilterPanelProps {
  /** Schema-definition — array af alle filtre der skal renderes */
  schemas: FilterSchema[];
  /** Nuværende filter-state (fra useFiltersFromURL) */
  filters: FilterState;
  /** Opdater en enkelt filter-værdi. */
  onFilterChange: (key: string, value: FilterState[string]) => void;
  /** Reset alle filtre til default — fires når "Nulstil"-knap trykkes */
  onReset: () => void;
  /** Antal matchende resultater (null = loading, vises som spinner) */
  matchCount: number | null;
  /** Bilingual — "da" eller "en" */
  lang: 'da' | 'en';
  /** Valgfri collapse-callback (hvis panelet er collapsible, fx på /dashboard/search) */
  onCollapse?: () => void;
}

// ─── Primitive renderers ────────────────────────────────────────────────────

/**
 * Multi-select (chip-toggles). Klik på chip toggler on/off i value-array.
 */
function MultiSelectControl({
  schema,
  value,
  onChange,
  lang,
}: {
  schema: MultiSelectFilterSchema;
  value: string[];
  onChange: (next: string[]) => void;
  lang: 'da' | 'en';
}) {
  const labelId = useId();
  const toggle = useCallback(
    (v: string) => {
      const has = value.includes(v);
      onChange(has ? value.filter((x) => x !== v) : [...value, v]);
    },
    [value, onChange]
  );
  return (
    <fieldset aria-labelledby={labelId}>
      <legend id={labelId} className="text-slate-200 text-xs font-semibold mb-2">
        {schema.label}
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {schema.options.map((opt) => {
          const active = value.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => toggle(opt.value)}
              aria-pressed={active}
              aria-label={`${schema.label}: ${opt.label}${active ? (lang === 'da' ? ' (valgt)' : ' (selected)') : ''}`}
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                active
                  ? 'bg-blue-500/20 text-blue-200 border-blue-400/50'
                  : 'bg-slate-800/50 text-slate-300 border-slate-700/50 hover:border-slate-600'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Enkelt-valg dropdown (native select for bred a11y-støtte). */
function DropdownControl({
  schema,
  value,
  onChange,
  lang,
}: {
  schema: DropdownFilterSchema;
  value: string;
  onChange: (next: string) => void;
  lang: 'da' | 'en';
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-slate-200 text-xs font-semibold mb-2">
        {schema.label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-slate-800/60 border border-slate-700/50 rounded-md px-2 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none"
      >
        <option value="">{schema.placeholder ?? (lang === 'da' ? 'Alle' : 'All')}</option>
        {schema.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Range (min/max numeriske inputs). Slider-UI parkeres til iter 2. */
function RangeControl({
  schema,
  value,
  onChange,
  lang,
}: {
  schema: RangeFilterSchema;
  value: { min?: number; max?: number };
  onChange: (next: { min?: number; max?: number }) => void;
  lang: 'da' | 'en';
}) {
  const idMin = useId();
  const idMax = useId();
  const unit = schema.unit ? ` (${schema.unit})` : '';
  return (
    <fieldset>
      <legend className="text-slate-200 text-xs font-semibold mb-2">
        {schema.label}
        {unit}
      </legend>
      <div className="flex items-center gap-2">
        <label htmlFor={idMin} className="sr-only">
          {lang === 'da' ? 'Minimum' : 'Minimum'}
        </label>
        <input
          id={idMin}
          type="number"
          inputMode="numeric"
          min={schema.min}
          max={schema.max}
          step={schema.step ?? 1}
          value={value.min ?? ''}
          placeholder={String(schema.min)}
          onChange={(e) => {
            const v = e.target.value;
            onChange({ ...value, min: v === '' ? undefined : Number(v) });
          }}
          className="w-20 bg-slate-800/60 border border-slate-700/50 rounded-md px-2 py-1 text-xs text-white focus:border-blue-500 focus:outline-none"
        />
        <span className="text-slate-500 text-xs">–</span>
        <label htmlFor={idMax} className="sr-only">
          {lang === 'da' ? 'Maksimum' : 'Maximum'}
        </label>
        <input
          id={idMax}
          type="number"
          inputMode="numeric"
          min={schema.min}
          max={schema.max}
          step={schema.step ?? 1}
          value={value.max ?? ''}
          placeholder={String(schema.max)}
          onChange={(e) => {
            const v = e.target.value;
            onChange({ ...value, max: v === '' ? undefined : Number(v) });
          }}
          className="w-20 bg-slate-800/60 border border-slate-700/50 rounded-md px-2 py-1 text-xs text-white focus:border-blue-500 focus:outline-none"
        />
      </div>
    </fieldset>
  );
}

/** Toggle (checkbox). */
function ToggleControl({
  schema,
  value,
  onChange,
}: {
  schema: ToggleFilterSchema;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
        <input
          id={id}
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 accent-blue-500"
        />
        <span className="flex-1">
          <span className="font-medium text-slate-200">{schema.label}</span>
          {schema.description && (
            <span className="block text-[10px] text-slate-500 mt-0.5 leading-snug">
              {schema.description}
            </span>
          )}
        </span>
      </label>
    </div>
  );
}

// ─── Main panel ─────────────────────────────────────────────────────────────

/**
 * FilterPanel — render-loop over schemas der dispatcher til den korrekte
 * primitive control. Fuldhøjde, scrollable, med Nulstil-knap og
 * live matchCount. Collapse-knap hvis onCollapse er givet.
 */
export default function FilterPanel({
  schemas,
  filters,
  onFilterChange,
  onReset,
  matchCount,
  lang,
  onCollapse,
}: FilterPanelProps) {
  const da = lang === 'da';
  return (
    <aside
      aria-label={da ? 'Filter-panel' : 'Filter panel'}
      className="h-full overflow-y-auto bg-slate-900/40 border-l border-slate-700/40 p-4"
    >
      {/* Header: title + matchCount + reset + collapse */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-white text-sm font-semibold flex items-center gap-2">
          <SlidersHorizontal size={14} className="text-blue-400" />
          {da ? 'Filtre' : 'Filters'}
        </h2>
        <div className="flex items-center gap-3">
          {/* Live match-count */}
          <span
            className="text-[11px] text-slate-400 tabular-nums"
            aria-live="polite"
            aria-label={
              matchCount === null
                ? da
                  ? 'Tæller resultater'
                  : 'Counting results'
                : da
                  ? `${matchCount} resultater`
                  : `${matchCount} results`
            }
          >
            {matchCount === null ? (
              <Loader2 size={12} className="inline animate-spin text-blue-400" />
            ) : (
              <>
                <span className="text-white font-semibold">{matchCount}</span>{' '}
                {da ? 'resultater' : 'results'}
              </>
            )}
          </span>
          <button
            type="button"
            onClick={onReset}
            className="text-xs text-slate-400 hover:text-blue-300 transition-colors"
          >
            {da ? 'Nulstil' : 'Reset'}
          </button>
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              aria-label={da ? 'Skjul filter-panel' : 'Hide filter panel'}
              className="text-slate-400 hover:text-white transition-colors"
            >
              <ChevronRight size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Filter sections */}
      <div className="space-y-5">
        {schemas.map((schema) => {
          switch (schema.type) {
            case 'multi-select': {
              const value = (filters[schema.key] as string[] | undefined) ?? [];
              return (
                <section key={schema.key}>
                  <MultiSelectControl
                    schema={schema}
                    value={value}
                    onChange={(next) => onFilterChange(schema.key, next)}
                    lang={lang}
                  />
                </section>
              );
            }
            case 'dropdown': {
              const value = (filters[schema.key] as string | undefined) ?? '';
              return (
                <section key={schema.key}>
                  <DropdownControl
                    schema={schema}
                    value={value}
                    onChange={(next) => onFilterChange(schema.key, next)}
                    lang={lang}
                  />
                </section>
              );
            }
            case 'range': {
              const value =
                (filters[schema.key] as { min?: number; max?: number } | undefined) ?? {};
              return (
                <section key={schema.key}>
                  <RangeControl
                    schema={schema}
                    value={value}
                    onChange={(next) => onFilterChange(schema.key, next)}
                    lang={lang}
                  />
                </section>
              );
            }
            case 'toggle': {
              const value = (filters[schema.key] as boolean | undefined) ?? schema.default;
              return (
                <section key={schema.key}>
                  <ToggleControl
                    schema={schema}
                    value={value}
                    onChange={(next) => onFilterChange(schema.key, next)}
                  />
                </section>
              );
            }
          }
        })}
      </div>
    </aside>
  );
}
