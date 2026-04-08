'use client';

/**
 * Personer listeside — søg efter personer og virksomheds-deltagere i CVR-registret.
 *
 * Bruger /api/person-search til autocomplete-søgning i CVR ES deltager-index.
 * Gemmer seneste besøgte personer i Supabase via /api/recents (type=person).
 * Matcher interaktionsmønsteret fra ejendomme- og virksomheds-listesiderne
 * (dropdown autocomplete med tastatur-navigation).
 *
 * Filter-panel (BIZZ-29):
 * - Antal virksomheder: Alle / 1-5 / 6-20 / 20+ (radio)
 * - Aktiv rolle: Kun aktive enheder (checkbox — filtrerer erVirksomhed=false)
 * - "Nulstil filtre" knap
 *
 * @see /api/person-search — server-side søgning i CVR ES
 * @see /dashboard/owners/[enhedsNummer] — persondetaljeside
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Search,
  Users,
  ChevronRight,
  X,
  Loader2,
  Clock,
  Building2,
  User,
  ArrowRight,
  Filter,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import type { PersonSearchResult } from '@/app/api/person-search/route';
import { getRecentPersons, type RecentPerson } from '@/app/lib/recentPersons';

// ─── Translations ───────────────────────────────────────────────────────────

const t = {
  da: {
    title: 'Personer',
    subtitle: 'Søg efter ejere, direktører og bestyrelsesmedlemmer i CVR',
    placeholder: 'Indtast personnavn...',
    searching: 'Søger i CVR-registret...',
    noResults: 'Ingen person fundet for',
    recentSearches: 'Seneste besøgte',
    clearHistory: 'Ryd historik',
    emptyTitle: 'Ingen personer besøgt endnu',
    emptyDesc: 'Søg på et personnavn ovenfor — personer du besøger vises her',
    companies: 'virksomheder',
    person: 'Person',
    company: 'Virksomhed',
    networkError: 'Netværksfejl — prøv igen',
    showingBest: 'Viser de bedste resultater',
    // Filter strings
    filtre: 'Filtre',
    nulstilFiltre: 'Nulstil filtre',
    antalVirksomheder: 'Antal virksomheder',
    alle: 'Alle',
    en_til_fem: '1–5',
    seks_til_tyve: '6–20',
    over_tyve: '20+',
    kunPersoner: 'Kun personer (ikke virksomheder)',
    visResultater: (n: number) => `Viser ${n} personer`,
    ingenMatch: 'Ingen personer matcher filtrene',
  },
  en: {
    title: 'People',
    subtitle: 'Search for owners, directors and board members in CVR',
    placeholder: 'Enter person name...',
    searching: 'Searching CVR registry...',
    noResults: 'No person found for',
    recentSearches: 'Recently visited',
    clearHistory: 'Clear history',
    emptyTitle: 'No people visited yet',
    emptyDesc: 'Search for a person name above — people you visit will appear here',
    companies: 'companies',
    person: 'Person',
    company: 'Company',
    networkError: 'Network error — try again',
    showingBest: 'Showing best results',
    // Filter strings
    filtre: 'Filters',
    nulstilFiltre: 'Reset filters',
    antalVirksomheder: 'Number of companies',
    alle: 'All',
    en_til_fem: '1–5',
    seks_til_tyve: '6–20',
    over_tyve: '20+',
    kunPersoner: 'People only (not companies)',
    visResultater: (n: number) => `Showing ${n} people`,
    ingenMatch: 'No people match the filters',
  },
} as const;

// ─── Filter types ────────────────────────────────────────────────────────────

/** Interval-filter for antal tilknyttede virksomheder */
type AntalFilter = 'alle' | '1-5' | '6-20' | '20+';

/** Aktive filtervalg for owners/personer-listesiden */
interface PersonFilterState {
  /** Filter på antal tilknyttede virksomheder */
  antal: AntalFilter;
  /** Vis kun personer (erVirksomhed=false) */
  kunPersoner: boolean;
}

/** Standard filterstatus — ingen aktive filtre */
const DEFAULT_FILTERS: PersonFilterState = {
  antal: 'alle',
  kunPersoner: false,
};

/**
 * Returnerer true hvis personen matcher antal-filteret.
 *
 * @param antalVirksomheder - Personens antal tilknyttede virksomheder
 * @param filter - Valgt interval-filter
 */
function matcherAntalFilter(antalVirksomheder: number, filter: AntalFilter): boolean {
  switch (filter) {
    case 'alle':
      return true;
    case '1-5':
      return antalVirksomheder >= 1 && antalVirksomheder <= 5;
    case '6-20':
      return antalVirksomheder >= 6 && antalVirksomheder <= 20;
    case '20+':
      return antalVirksomheder > 20;
  }
}

// ─── Helper components ──────────────────────────────────────────────────────

/**
 * Card for a recently visited person.
 *
 * @param person - Cached person data
 * @param lang - Current language
 * @param now - Stable timestamp for relative time display
 */
function RecentPersonCard({
  person,
  lang,
  now,
}: {
  person: RecentPerson;
  lang: 'da' | 'en';
  now: number;
}) {
  const minAgo = Math.round((now - person.visitedAt) / 60000);
  const timeText =
    minAgo < 1
      ? lang === 'da'
        ? 'Lige nu'
        : 'Just now'
      : minAgo < 60
        ? `${minAgo} min. ${lang === 'da' ? 'siden' : 'ago'}`
        : minAgo < 1440
          ? `${Math.round(minAgo / 60)} ${lang === 'da' ? 't. siden' : 'h ago'}`
          : `${Math.round(minAgo / 1440)} ${lang === 'da' ? 'd. siden' : 'd ago'}`;

  return (
    <Link
      href={`/dashboard/owners/${person.enhedsNummer}`}
      className="group bg-slate-800/40 border border-slate-700/40 hover:border-purple-500/40 rounded-2xl p-5 flex flex-col gap-3 transition-all hover:bg-slate-800/60"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="p-2 rounded-xl text-purple-400 bg-purple-400/10">
          {person.erVirksomhed ? <Building2 size={18} /> : <User size={18} />}
        </div>
        <div className="flex items-center gap-2">
          {person.erVirksomhed && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium bg-purple-600/20 text-purple-400">
              {lang === 'da' ? 'Virksomhed' : 'Company'}
            </span>
          )}
          <div className="flex items-center gap-1 text-slate-500 text-xs">
            <Clock size={11} />
            {timeText}
          </div>
        </div>
      </div>
      <div>
        <p className="text-white font-semibold text-sm leading-snug">{person.name}</p>
        {person.antalVirksomheder > 0 && (
          <p className="text-slate-400 text-xs mt-0.5">
            {person.antalVirksomheder} {t[lang].companies}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end pt-1 border-t border-slate-700/40">
        <ChevronRight
          size={16}
          className="text-slate-600 group-hover:text-purple-400 transition-colors"
        />
      </div>
    </Link>
  );
}

/**
 * Et enkelt person-resultat i dropdown.
 *
 * @param data - Personresultat fra /api/person-search
 * @param aktiv - Om rækken er tastatur-markeret
 * @param lang - Sprog
 * @param onVælg - Callback ved valg
 */
function DropdownResultItem({
  data,
  aktiv,
  lang,
  onVælg,
}: {
  data: PersonSearchResult;
  aktiv?: boolean;
  lang: 'da' | 'en';
  onVælg: (r: PersonSearchResult) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onVælg(data)}
      className={`w-full flex items-center gap-3 px-4 py-3 transition-colors text-left group ${
        aktiv ? 'bg-purple-600/20' : 'hover:bg-slate-700/50'
      }`}
    >
      <div
        className={`p-1.5 rounded-lg flex-shrink-0 transition-colors ${
          aktiv ? 'bg-purple-600/30' : 'bg-slate-700 group-hover:bg-purple-600/20'
        }`}
      >
        {data.erVirksomhed ? (
          <Building2
            size={13}
            className={aktiv ? 'text-purple-400' : 'text-slate-400 group-hover:text-purple-400'}
          />
        ) : (
          <User
            size={13}
            className={aktiv ? 'text-purple-400' : 'text-slate-400 group-hover:text-purple-400'}
          />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-white text-sm font-medium truncate">{data.name}</p>
          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium flex-shrink-0 bg-purple-600/20 text-purple-400">
            {data.erVirksomhed ? t[lang].company : t[lang].person}
          </span>
        </div>
        {data.roller && data.roller.length > 0 ? (
          <p className="text-slate-500 text-xs truncate">
            {data.roller
              .map((r) => (r.rolle ? `${r.rolle}, ${r.virksomhedNavn}` : r.virksomhedNavn))
              .join(' · ')}
          </p>
        ) : data.antalVirksomheder > 0 ? (
          <p className="text-slate-500 text-xs truncate">
            {data.antalVirksomheder} {t[lang].companies}
          </p>
        ) : null}
      </div>
      <ArrowRight
        size={13}
        className={aktiv ? 'text-purple-400' : 'text-slate-600 group-hover:text-purple-400'}
      />
    </button>
  );
}

// ─── Dropdown Portal ────────────────────────────────────────────────────────

interface DropdownPos {
  top: number;
  left: number;
  width: number;
}

/**
 * Portal-komponent til autocomplete-dropdown.
 * Renderes i document.body for at undgå overflow:hidden klipning.
 *
 * @param inputRef - Ref til søgeinput — position beregnes herfra
 * @param dropdownRef - Ref til dropdown-div — bruges til klik-udenfor detection
 */
function DropdownPortal({
  inputRef,
  dropdownRef,
  query,
  results,
  searching,
  searchDone,
  error,
  markeret,
  onVælg,
  lang,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  query: string;
  results: PersonSearchResult[];
  searching: boolean;
  searchDone: boolean;
  error: string | null;
  markeret: number;
  onVælg: (r: PersonSearchResult) => void;
  lang: 'da' | 'en';
}) {
  const [pos, setPos] = useState<DropdownPos | null>(null);

  useEffect(() => {
    function opdater() {
      if (!inputRef.current) return;
      const r = inputRef.current.getBoundingClientRect();
      if (r.width > 0) setPos({ top: r.bottom + 8, left: r.left, width: r.width });
    }
    opdater();
    window.addEventListener('resize', opdater);
    window.addEventListener('scroll', opdater, true);
    return () => {
      window.removeEventListener('resize', opdater);
      window.removeEventListener('scroll', opdater, true);
    };
  }, [inputRef]);

  if (!pos) return null;

  const txt = t[lang];

  return createPortal(
    <div
      ref={dropdownRef}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        width: pos.width,
        zIndex: 9999,
        maxHeight: '60vh',
        overflowY: 'auto',
      }}
      className="bg-slate-800 border border-slate-700/60 rounded-2xl overflow-hidden shadow-2xl"
    >
      {/* Loading */}
      {searching && (
        <div className="flex items-center gap-3 px-4 py-3 text-slate-500 text-sm">
          <Loader2 size={14} className="animate-spin" />
          {txt.searching}
        </div>
      )}

      {/* Results */}
      {!searching && results.length > 0 && (
        <>
          {results.map((r, i) => (
            <DropdownResultItem
              key={r.enhedsNummer}
              data={r}
              aktiv={i === markeret}
              lang={lang}
              onVælg={onVælg}
            />
          ))}
          {results.length >= 15 && (
            <div className="px-4 py-2 border-t border-slate-700/40">
              <p className="text-slate-600 text-xs text-center">{txt.showingBest}</p>
            </div>
          )}
        </>
      )}

      {/* No results */}
      {!searching && searchDone && results.length === 0 && error && (
        <div className="px-4 py-4 text-slate-500 text-sm text-center">
          {txt.noResults} &ldquo;{query}&rdquo;
        </div>
      )}
    </div>,
    document.body
  );
}

// ─── Filter panel ────────────────────────────────────────────────────────────

/**
 * Vandret filterpanel for owners/personer-listesiden.
 * Filtrerer på antal tilknyttede virksomheder og person vs. virksomhed.
 *
 * @param filters - Aktive filtervalg
 * @param onFiltersChange - Callback når filtre ændres
 * @param lang - Aktuelt sprog
 */
function PersonFilterPanel({
  filters,
  onFiltersChange,
  lang,
}: {
  filters: PersonFilterState;
  onFiltersChange: (f: PersonFilterState) => void;
  lang: 'da' | 'en';
}) {
  const txt = t[lang];

  return (
    <div className="bg-[#0f172a] border border-slate-700/50 rounded-xl p-4 mt-3 flex flex-wrap gap-6">
      {/* Antal virksomheder radio */}
      <div className="flex flex-col gap-1.5">
        <span className="text-slate-400 text-xs font-medium uppercase tracking-wide">
          {txt.antalVirksomheder}
        </span>
        <div className="flex gap-3 flex-wrap">
          {(
            [
              ['alle', txt.alle],
              ['1-5', txt.en_til_fem],
              ['6-20', txt.seks_til_tyve],
              ['20+', txt.over_tyve],
            ] as [AntalFilter, string][]
          ).map(([val, label]) => (
            <label key={val} className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="person-antal"
                value={val}
                checked={filters.antal === val}
                onChange={() => onFiltersChange({ ...filters, antal: val })}
                className="accent-purple-500"
              />
              <span className="text-slate-300 text-sm">{label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Kun personer checkbox */}
      <div className="flex flex-col gap-1.5 justify-end">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={filters.kunPersoner}
            onChange={(e) => onFiltersChange({ ...filters, kunPersoner: e.target.checked })}
            className="accent-purple-500 rounded"
          />
          <span className="text-slate-300 text-sm">{txt.kunPersoner}</span>
        </label>
      </div>
    </div>
  );
}

/**
 * Viser aktive filtre som removable chip-piller for owners-listesiden.
 *
 * @param filters - Aktive filtervalg
 * @param onFiltersChange - Callback til opdatering
 * @param lang - Aktuelt sprog
 */
function ActiveFilterChips({
  filters,
  onFiltersChange,
  lang,
}: {
  filters: PersonFilterState;
  onFiltersChange: (f: PersonFilterState) => void;
  lang: 'da' | 'en';
}) {
  const txt = t[lang];
  const chips: { label: string; onRemove: () => void }[] = [];

  if (filters.antal !== 'alle') {
    const labels: Record<AntalFilter, string> = {
      alle: txt.alle,
      '1-5': txt.en_til_fem,
      '6-20': txt.seks_til_tyve,
      '20+': txt.over_tyve,
    };
    chips.push({
      label: `${txt.antalVirksomheder}: ${labels[filters.antal]}`,
      onRemove: () => onFiltersChange({ ...filters, antal: 'alle' }),
    });
  }
  if (filters.kunPersoner) {
    chips.push({
      label: txt.kunPersoner,
      onRemove: () => onFiltersChange({ ...filters, kunPersoner: false }),
    });
  }

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 mt-3">
      {chips.map((chip) => (
        <span
          key={chip.label}
          className="inline-flex items-center gap-1.5 bg-blue-900/40 text-blue-300 border border-blue-700/50 rounded-full px-3 py-1 text-xs"
        >
          {chip.label}
          <button
            type="button"
            onClick={chip.onRemove}
            aria-label={`${lang === 'da' ? 'Fjern filter' : 'Remove filter'}: ${chip.label}`}
            className="text-blue-400 hover:text-blue-200 transition-colors"
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={() => onFiltersChange(DEFAULT_FILTERS)}
        className="text-slate-500 hover:text-slate-300 text-xs transition-colors ml-1"
      >
        {txt.nulstilFiltre}
      </button>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

/**
 * PersonerListeside — Person search and list page.
 *
 * Autocomplete-dropdown søgning (som ejendomme/virksomheder) + seneste besøgte.
 * Understøtter tastatur-navigation (pil op/ned, enter, escape).
 * Filtrerer de loadede recent-personer lokalt via filterState (BIZZ-29).
 */
export default function PersonerListeside() {
  const { lang } = useLanguage();
  const txt = t[lang];
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  /** Stable timestamp for relative time display */
  const now = useMemo(() => Date.now(), []);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PersonSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchDone, setSearchDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [åben, setÅben] = useState(false);
  const [markeret, setMarkeret] = useState(-1);

  /** Recent persons loaded from Supabase (in-memory cache) */
  const [recentPersons, setRecentPersons] = useState<RecentPerson[]>(() => getRecentPersons());

  /** Om filter-panelet er synligt */
  const [filterOpen, setFilterOpen] = useState(false);

  /** Aktive filtervalg — standard = ingen filter */
  const [filters, setFilters] = useState<PersonFilterState>(DEFAULT_FILTERS);

  /**
   * Filtreret liste af recent-personer baseret på aktive filtervalg.
   * Kører rent client-side på allerede-loadede data.
   */
  const filteredPersons = useMemo<RecentPerson[]>(() => {
    return recentPersons.filter((p) => {
      // Antal-virksomheder-filter
      if (!matcherAntalFilter(p.antalVirksomheder, filters.antal)) return false;
      // Kun-personer-filter: vis ikke enheder der er klassificeret som virksomheder
      if (filters.kunPersoner && p.erVirksomhed) return false;
      return true;
    });
  }, [recentPersons, filters]);

  /** Om nogen filtre er aktive */
  const hasActiveFilters = useMemo<boolean>(() => {
    return filters.antal !== 'alle' || filters.kunPersoner;
  }, [filters]);

  /** Listen for cache updates from background fetch */
  useEffect(() => {
    const handler = () => setRecentPersons(getRecentPersons());
    window.addEventListener('ba-recents-updated', handler);
    return () => window.removeEventListener('ba-recents-updated', handler);
  }, []);

  /** Luk dropdown ved klik udenfor */
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setÅben(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  /**
   * Debounced search — calls /api/person-search?q=...
   * Personer gemmes IKKE i historikken her — kun når detaljesiden åbnes.
   */
  useEffect(() => {
    setSearchDone(false);
    setError(null);
    setResults([]);

    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSearching(false);
      return;
    }

    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/person-search?q=${encodeURIComponent(trimmed)}`);
        if (!res.ok) {
          setError(txt.networkError);
          setResults([]);
        } else {
          const json = await res.json();
          const list = (json.results ?? []) as PersonSearchResult[];
          if (list.length > 0) {
            setResults(list);
            setError(null);
          } else {
            setError(`${txt.noResults} "${trimmed}"`);
            setResults([]);
          }
        }
      } catch {
        setError(txt.networkError);
        setResults([]);
      } finally {
        setSearching(false);
        setSearchDone(true);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [query, txt.networkError, txt.noResults]);

  /** Håndterer valg af person fra dropdown — navigerer til detaljeside */
  function vælgPerson(r: PersonSearchResult) {
    setÅben(false);
    setQuery('');
    router.push(`/dashboard/owners/${r.enhedsNummer}`);
  }

  /** Clear recent persons from Supabase and state */
  function clearRecent() {
    fetch('/api/recents?type=person', { method: 'DELETE' }).catch(() => {
      /* ignore */
    });
    setRecentPersons([]);
  }

  const visDropdown =
    åben && query.trim().length >= 2 && (results.length > 0 || searching || searchDone);

  return (
    <div className="flex-1 flex flex-col bg-[#0a1628]">
      {/* ─── Header ─── */}
      <div className="px-8 pt-8 pb-6 border-b border-slate-700/40">
        <h1 className="text-2xl font-bold text-purple-400 mb-1">{txt.title}</h1>
        <p className="text-slate-400 text-sm">{txt.subtitle}</p>

        {/* Search box + Filter toggle */}
        <div className="relative mt-5">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search
                size={18}
                className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
              />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setÅben(true);
                  setMarkeret(-1);
                }}
                onFocus={() => setÅben(true)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setMarkeret((m) => Math.min(m + 1, results.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setMarkeret((m) => Math.max(m - 1, -1));
                  } else if (e.key === 'Enter') {
                    const valgt = markeret >= 0 ? results[markeret] : results[0];
                    if (valgt) vælgPerson(valgt);
                  } else if (e.key === 'Escape') {
                    setÅben(false);
                    setMarkeret(-1);
                  }
                }}
                placeholder={txt.placeholder}
                className="w-full bg-slate-800/60 border border-slate-600/50 focus:border-purple-500/60 rounded-2xl pl-11 pr-12 py-4 text-white placeholder:text-slate-500 outline-none transition-all text-base shadow-lg"
              />
              <div className="absolute right-4 top-1/2 -translate-y-1/2">
                {searching ? (
                  <Loader2 size={18} className="text-purple-400 animate-spin" />
                ) : query.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('');
                      setResults([]);
                      setError(null);
                      setSearchDone(false);
                      setÅben(false);
                      inputRef.current?.focus();
                    }}
                    className="text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    <X size={18} />
                  </button>
                ) : null}
              </div>
            </div>

            {/* Filter toggle — kun synlig når der er recent-personer at filtrere */}
            {recentPersons.length > 0 && (
              <button
                type="button"
                onClick={() => setFilterOpen((o) => !o)}
                aria-label={txt.filtre}
                aria-expanded={filterOpen}
                className={`flex items-center gap-2 px-4 py-2 rounded-2xl border transition-all text-sm font-medium shadow-lg ${
                  hasActiveFilters || filterOpen
                    ? 'bg-purple-600/20 border-purple-500/50 text-purple-300'
                    : 'bg-slate-800/60 border-slate-600/50 text-slate-400 hover:border-slate-500/60 hover:text-slate-300'
                }`}
              >
                <Filter size={16} />
                {txt.filtre}
                {hasActiveFilters && (
                  <span className="bg-purple-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                    {[filters.antal !== 'alle' ? 1 : 0, filters.kunPersoner ? 1 : 0].reduce(
                      (a, b) => a + b,
                      0
                    )}
                  </span>
                )}
              </button>
            )}
          </div>

          {/* Filter panel */}
          {filterOpen && recentPersons.length > 0 && (
            <PersonFilterPanel filters={filters} onFiltersChange={setFilters} lang={lang} />
          )}

          {/* Active filter chips */}
          <ActiveFilterChips filters={filters} onFiltersChange={setFilters} lang={lang} />

          {/* Dropdown via Portal */}
          {visDropdown && typeof document !== 'undefined' && (
            <DropdownPortal
              inputRef={inputRef}
              dropdownRef={dropdownRef}
              query={query}
              results={results}
              searching={searching}
              searchDone={searchDone}
              error={error}
              markeret={markeret}
              onVælg={vælgPerson}
              lang={lang}
            />
          )}
        </div>
      </div>

      {/* ─── Content ─── */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {/* Recent persons */}
        {recentPersons.length > 0 ? (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Clock size={15} className="text-slate-400" />
                <h2 className="text-white font-semibold text-base">{txt.recentSearches}</h2>
                {hasActiveFilters && (
                  <span className="text-slate-500 text-xs">
                    — {txt.visResultater(filteredPersons.length)}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={clearRecent}
                className="text-slate-600 hover:text-slate-400 text-xs transition-colors"
              >
                {txt.clearHistory}
              </button>
            </div>

            {filteredPersons.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {filteredPersons.map((p) => (
                  <RecentPersonCard key={p.enhedsNummer} person={p} lang={lang} now={now} />
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
                <div className="p-4 bg-slate-800/40 rounded-2xl">
                  <Filter size={24} className="text-slate-600" />
                </div>
                <p className="text-slate-400 text-sm font-medium">{txt.ingenMatch}</p>
                <button
                  type="button"
                  onClick={() => setFilters(DEFAULT_FILTERS)}
                  className="text-purple-400 hover:text-purple-300 text-xs transition-colors"
                >
                  {txt.nulstilFiltre}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
            <div className="p-4 bg-slate-800/40 rounded-2xl">
              <Users size={28} className="text-slate-600" />
            </div>
            <p className="text-slate-400 text-sm font-medium">{txt.emptyTitle}</p>
            <p className="text-slate-600 text-xs max-w-xs leading-relaxed">{txt.emptyDesc}</p>
          </div>
        )}
      </div>
    </div>
  );
}
