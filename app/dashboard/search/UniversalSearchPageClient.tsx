'use client';

/**
 * Universal Search page — `/dashboard/search`
 *
 * Single search input that queries all three data sources in parallel:
 *   1. Properties   → /api/adresse/autocomplete (DAR/DAWA address autocomplete)
 *   2. Companies    → /api/cvr-search (CVR ElasticSearch)
 *   3. People       → /api/person-search (CVR deltager-index)
 *
 * Results are presented in three tabs with count badges.
 * Each result links to its own detail page.
 *
 * Design: dark theme, bg-[#0a1020], cards bg-[#0f172a] border border-slate-700/50
 * Bilingual DA/EN via LanguageContext.
 * Accessibility: WCAG AA — tablist/tab/tabpanel roles, aria-labels on all icon buttons.
 *
 * @see /api/adresse/autocomplete — returns DawaAutocompleteResult[]
 * @see /api/cvr-search          — returns { results: CVRSearchResult[] }
 * @see /api/person-search       — returns { results: PersonSearchResult[] }
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Search,
  X,
  Loader2,
  MapPin,
  Building2,
  Users,
  User,
  CheckCircle,
  XCircle,
  Briefcase,
  Home,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';
import type { DawaAutocompleteResult } from '@/app/lib/dawa';
import type { CVRSearchResult } from '@/app/api/cvr-search/route';
import type { PersonSearchResult } from '@/app/api/person-search/route';

// ─── Tab types ────────────────────────────────────────────────────────────────

/** The three available result tabs */
type Tab = 'properties' | 'companies' | 'people';

// ─── Loading skeleton ─────────────────────────────────────────────────────────

/**
 * Animated skeleton card for the loading state.
 *
 * @param wide - When true, renders a wider second line (for address text)
 */
function SkeletonCard({ wide = false }: { wide?: boolean }) {
  return (
    <div className="bg-[#0f172a] border border-slate-700/50 rounded-xl p-4 flex items-center gap-4 animate-pulse">
      <div className="w-9 h-9 rounded-lg bg-slate-700/60 shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="h-3.5 bg-slate-700/60 rounded w-3/5" />
        <div className={`h-3 bg-slate-700/40 rounded ${wide ? 'w-4/5' : 'w-2/5'}`} />
      </div>
    </div>
  );
}

/**
 * Renders a column of skeleton cards while results are loading.
 *
 * @param count - Number of skeleton cards to show
 */
function SkeletonList({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} wide={i % 2 === 0} />
      ))}
    </div>
  );
}

// ─── Result cards ─────────────────────────────────────────────────────────────

/**
 * Card for a single address / property result.
 *
 * @param result - Autocomplete result from /api/adresse/autocomplete
 * @param lang   - Current UI language
 */
function PropertyCard({ result, lang }: { result: DawaAutocompleteResult; lang: 'da' | 'en' }) {
  const t = translations[lang].searchPage;
  const { adresse } = result;
  // Property detail page uses the DAWA UUID as the [id] segment
  const href = `/dashboard/ejendomme/${adresse.id}`;
  const subtitle = [adresse.postnr, adresse.postnrnavn, adresse.kommunenavn]
    .filter(Boolean)
    .join(' · ');

  return (
    <Link
      href={href}
      className="group bg-[#0f172a] border border-slate-700/50 hover:border-emerald-500/40 rounded-xl p-4 flex items-center gap-4 transition-all hover:bg-slate-800/60"
    >
      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-emerald-500/10 text-emerald-400 group-hover:bg-emerald-500/20 transition-colors">
        <MapPin size={16} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-white font-medium text-sm truncate leading-snug">{result.tekst}</p>
        <p className="text-slate-500 text-xs mt-0.5 truncate">
          {subtitle}
          {adresse.id && adresse.id.length < 20 ? ` · ${t.bfe}: ${adresse.id}` : ''}
        </p>
      </div>
    </Link>
  );
}

/**
 * Card for a single company result.
 *
 * @param result - CVR search result from /api/cvr-search
 * @param lang   - Current UI language
 */
function CompanyCard({ result, lang }: { result: CVRSearchResult; lang: 'da' | 'en' }) {
  const t = translations[lang].searchPage;
  const href = `/dashboard/companies/${result.cvr}`;
  const meta = [String(result.cvr), result.industry].filter(Boolean).join(' · ');

  return (
    <Link
      href={href}
      className="group bg-[#0f172a] border border-slate-700/50 hover:border-blue-500/40 rounded-xl p-4 flex items-center gap-4 transition-all hover:bg-slate-800/60"
    >
      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-blue-500/10 text-blue-400 group-hover:bg-blue-500/20 transition-colors">
        <Briefcase size={16} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-white font-medium text-sm truncate leading-snug">{result.name}</p>
          <span
            className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium flex-shrink-0 ${
              result.active ? 'bg-emerald-600/20 text-emerald-400' : 'bg-red-600/20 text-red-400'
            }`}
          >
            {result.active ? (
              <>
                <CheckCircle size={8} />
                {t.active}
              </>
            ) : (
              <>
                <XCircle size={8} />
                {t.inactive}
              </>
            )}
          </span>
        </div>
        <p className="text-slate-500 text-xs mt-0.5 truncate">CVR {meta}</p>
      </div>
    </Link>
  );
}

/**
 * Card for a single person result.
 *
 * @param result - Person search result from /api/person-search
 * @param lang   - Current UI language
 */
function PersonCard({ result, lang }: { result: PersonSearchResult; lang: 'da' | 'en' }) {
  const t = translations[lang].searchPage;
  const href = `/dashboard/owners/${result.enhedsNummer}`;
  const subtitle =
    result.roller.length > 0
      ? result.roller
          .map((r) => (r.rolle ? `${r.rolle}, ${r.virksomhedNavn}` : r.virksomhedNavn))
          .join(' · ')
      : result.antalVirksomheder > 0
        ? `${result.antalVirksomheder} ${t.companies}`
        : null;

  return (
    <Link
      href={href}
      className="group bg-[#0f172a] border border-slate-700/50 hover:border-purple-500/40 rounded-xl p-4 flex items-center gap-4 transition-all hover:bg-slate-800/60"
    >
      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-purple-500/10 text-purple-400 group-hover:bg-purple-500/20 transition-colors">
        {result.erVirksomhed ? <Building2 size={16} /> : <User size={16} />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-white font-medium text-sm truncate leading-snug">{result.name}</p>
        {subtitle && <p className="text-slate-500 text-xs mt-0.5 truncate">{subtitle}</p>}
      </div>
    </Link>
  );
}

// ─── Tab button ───────────────────────────────────────────────────────────────

/**
 * Accessible tab button with count badge.
 *
 * @param label      - Display label
 * @param count      - Number of results for this tab
 * @param active     - Whether this tab is selected
 * @param loading    - Whether results are still loading
 * @param color      - Tailwind color class prefix (e.g. "emerald")
 * @param onSelect   - Click / keyboard handler
 */
function TabButton({
  label,
  count,
  active,
  loading,
  color,
  onSelect,
}: {
  label: string;
  count: number;
  active: boolean;
  loading: boolean;
  color: 'emerald' | 'blue' | 'purple';
  onSelect: () => void;
}) {
  const colorMap: Record<string, { text: string; badge: string; border: string }> = {
    emerald: {
      text: 'text-emerald-400',
      badge: 'bg-emerald-500/20 text-emerald-300',
      border: 'border-emerald-500',
    },
    blue: {
      text: 'text-blue-400',
      badge: 'bg-blue-500/20 text-blue-300',
      border: 'border-blue-500',
    },
    purple: {
      text: 'text-purple-400',
      badge: 'bg-purple-500/20 text-purple-300',
      border: 'border-purple-500',
    },
  };
  const c = colorMap[color];

  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-all whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
        active
          ? `${c.text} ${c.border}`
          : 'text-slate-500 border-transparent hover:text-slate-300 hover:border-slate-600'
      }`}
    >
      {label}
      {loading ? (
        <Loader2 size={12} className="animate-spin text-slate-500" />
      ) : (
        <span
          className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
            active ? c.badge : 'bg-slate-700/60 text-slate-500'
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

/**
 * Empty state display when a tab has no results.
 *
 * @param query   - The search query that produced no results
 * @param message - The "no results" message to show
 * @param icon    - The icon to render above the message
 */
function EmptyState({
  query,
  message,
  icon,
}: {
  query: string;
  message: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
      <div className="p-4 bg-slate-800/40 rounded-2xl text-slate-600">{icon}</div>
      <p className="text-slate-400 text-sm font-medium">{message}</p>
      {query.trim().length > 0 && (
        <p className="text-slate-600 text-xs">&ldquo;{query.trim()}&rdquo;</p>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * UniversalSearchPage — `/dashboard/search`
 *
 * Provides a single search field that queries properties, companies, and people
 * in parallel (debounced 300 ms). Results are shown in three tabs with badge counts.
 * Clicking a result navigates to the appropriate detail page.
 */
/** BIZZ-763: Shape of a matrikel-search result row. */
interface MatrikelLejlighed {
  bfe: number;
  adresse: string;
  etage: string | null;
  doer: string | null;
  ejer: string;
  ejertype: 'person' | 'selskab' | 'ukendt';
  areal: number | null;
  koebspris: number | null;
  koebsdato: string | null;
  dawaId: string | null;
}

export default function UniversalSearchPageClient() {
  const { lang } = useLanguage();
  const t = translations[lang].searchPage;
  const da = lang === 'da';

  // BIZZ-763: When navigated from an ejendom-detail's "find other properties
  // on matrikel" button, the page opens in matrikel-mode. In this mode the
  // normal text-search is bypassed and results come from /api/ejerlejligheder.
  const sp = useSearchParams();
  const matrikelMode = sp.get('type') === 'matrikel';
  const matEjerlavKode = sp.get('ejerlavKode') ?? '';
  const matMatrikelnr = sp.get('matrikelnr') ?? '';
  const matEjerlavNavn = sp.get('ejerlavNavn') ?? '';
  const [matLejligheder, setMatLejligheder] = useState<MatrikelLejlighed[]>([]);
  const [matLoading, setMatLoading] = useState(false);
  const [matError, setMatError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('properties');

  // BIZZ-774: right-side filter-panel state. Start open when matrikel-mode
  // so the user can immediately toggle "vis udfasede" for the property list.
  const [filterOpen, setFilterOpen] = useState(matrikelMode);
  const [hideRetiredProperties, setHideRetiredProperties] = useState(true);
  const [onlyActiveCompanies, setOnlyActiveCompanies] = useState(true);

  // Results state
  const [properties, setProperties] = useState<DawaAutocompleteResult[]>([]);
  const [companies, setCompanies] = useState<CVRSearchResult[]>([]);
  const [people, setPeople] = useState<PersonSearchResult[]>([]);

  // Per-tab loading states
  const [loadingProps, setLoadingProps] = useState(false);
  const [loadingComps, setLoadingComps] = useState(false);
  const [loadingPeople, setLoadingPeople] = useState(false);

  /** Whether at least one search has been fired for the current query */
  const [searched, setSearched] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  // BIZZ-763: Matrikel-mode auto-runs one lookup when the page lands with
  // type=matrikel query params. We call /api/ejerlejligheder which returns
  // the full list of ejerlejligheder on the jordstykke.
  useEffect(() => {
    if (!matrikelMode || !matEjerlavKode || !matMatrikelnr) return;
    let cancelled = false;
    setMatLoading(true);
    setMatError(null);
    (async () => {
      try {
        const params = new URLSearchParams({
          ejerlavKode: matEjerlavKode,
          matrikelnr: matMatrikelnr,
        });
        const res = await fetch(`/api/ejerlejligheder?${params.toString()}`);
        if (!res.ok) {
          if (!cancelled) {
            setMatError(da ? `Fejl ${res.status}` : `Error ${res.status}`);
          }
          return;
        }
        const json = (await res.json()) as { lejligheder?: MatrikelLejlighed[] };
        if (!cancelled) setMatLejligheder(json.lejligheder ?? []);
      } catch (err) {
        if (!cancelled) {
          setMatError(err instanceof Error ? err.message : 'Unknown error');
        }
      } finally {
        if (!cancelled) setMatLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [matrikelMode, matEjerlavKode, matMatrikelnr, da]);

  /** Focus the input on mount */
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /**
   * Clears all result state so stale results are never shown
   * between consecutive searches.
   */
  const clearResults = useCallback(() => {
    setProperties([]);
    setCompanies([]);
    setPeople([]);
    setSearched(false);
  }, []);

  /**
   * Debounced parallel search — fires 300 ms after the query settles.
   * All three endpoints are called simultaneously; each has an independent
   * loading indicator so slow endpoints don't block fast ones.
   */
  useEffect(() => {
    const trimmed = query.trim();

    if (trimmed.length < 2) {
      clearResults();
      setLoadingProps(false);
      setLoadingComps(false);
      setLoadingPeople(false);
      return;
    }

    // Indicate loading immediately (before debounce fires) for snappy UX
    setLoadingProps(true);
    setLoadingComps(true);
    setLoadingPeople(true);

    const timer = setTimeout(async () => {
      setSearched(true);

      // ─── Properties ───────────────────────────────────────────────────
      const propsPromise = fetch(`/api/adresse/autocomplete?q=${encodeURIComponent(trimmed)}`)
        .then(async (res) => {
          if (!res.ok) return [];
          const data = await res.json();
          return Array.isArray(data) ? (data as DawaAutocompleteResult[]) : [];
        })
        .catch(() => [] as DawaAutocompleteResult[])
        .finally(() => setLoadingProps(false));

      // ─── Companies ────────────────────────────────────────────────────
      const compsPromise = fetch(`/api/cvr-search?q=${encodeURIComponent(trimmed)}`)
        .then(async (res) => {
          if (!res.ok) return [];
          const data = await res.json();
          return Array.isArray(data.results) ? (data.results as CVRSearchResult[]) : [];
        })
        .catch(() => [] as CVRSearchResult[])
        .finally(() => setLoadingComps(false));

      // ─── People ───────────────────────────────────────────────────────
      const peoplePromise = fetch(`/api/person-search?q=${encodeURIComponent(trimmed)}`)
        .then(async (res) => {
          if (!res.ok) return [];
          const data = await res.json();
          return Array.isArray(data.results) ? (data.results as PersonSearchResult[]) : [];
        })
        .catch(() => [] as PersonSearchResult[])
        .finally(() => setLoadingPeople(false));

      // Wait for all three, then update state
      const [propsResult, compsResult, peopleResult] = await Promise.all([
        propsPromise,
        compsPromise,
        peoplePromise,
      ]);

      setProperties(propsResult);
      setCompanies(compsResult);
      setPeople(peopleResult);
    }, 300);

    return () => clearTimeout(timer);
  }, [query, clearResults]);

  /**
   * Resets the search field and clears all results.
   */
  function handleClear() {
    setQuery('');
    clearResults();
    inputRef.current?.focus();
  }

  const anyLoading = loadingProps || loadingComps || loadingPeople;
  const hasQuery = query.trim().length >= 2;

  // Auto-switch to the first tab with results when search completes
  useEffect(() => {
    if (!searched || anyLoading) return;
    if (activeTab === 'properties' && properties.length === 0 && companies.length > 0) {
      setActiveTab('companies');
    } else if (
      activeTab === 'properties' &&
      properties.length === 0 &&
      companies.length === 0 &&
      people.length > 0
    ) {
      setActiveTab('people');
    }
  }, [searched, anyLoading, properties.length, companies.length, people.length, activeTab]);

  // BIZZ-763: Matrikel-mode dedicated view — shown when arriving from an
  // ejendom-detail page's "find other properties on matrikel" button.
  if (matrikelMode) {
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-[#0a1020] overflow-auto">
        <div className="max-w-4xl mx-auto w-full px-6 py-8 space-y-6">
          <div>
            <Link
              href="/dashboard/search"
              className="text-slate-400 hover:text-white text-sm inline-flex items-center gap-1"
            >
              <X size={14} /> {da ? 'Tilbage til fri søgning' : 'Back to free-text search'}
            </Link>
            <h1 className="text-2xl font-bold text-white mt-3 mb-1">
              {da ? 'Ejendomme på matriklen' : 'Properties on matrikel'}
            </h1>
            <p className="text-slate-400 text-sm">
              {da ? 'Matrikel' : 'Matrikel'}{' '}
              <span className="font-mono text-slate-300">{matMatrikelnr}</span>
              {matEjerlavNavn && (
                <>
                  {', '}
                  {matEjerlavNavn}
                </>
              )}
              {' · '}
              {da ? 'Ejerlavkode' : 'Ejerlav code'}{' '}
              <span className="font-mono text-slate-300">{matEjerlavKode}</span>
            </p>
          </div>

          {matLoading ? (
            <div className="flex items-center gap-2 text-slate-400 text-sm">
              <Loader2 size={14} className="animate-spin" />
              {da ? 'Henter ejendomme…' : 'Loading properties…'}
            </div>
          ) : matError ? (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-red-300 text-sm">
              {matError}
            </div>
          ) : matLejligheder.length === 0 ? (
            <div className="text-center py-16 bg-slate-800/40 border border-slate-700/40 rounded-xl">
              <Home size={32} className="mx-auto text-slate-600 mb-3" />
              <p className="text-slate-400 text-sm">
                {da
                  ? 'Ingen ejerlejligheder fundet på matriklen.'
                  : 'No properties found on this matrikel.'}
              </p>
            </div>
          ) : (
            <>
              <p className="text-slate-400 text-xs">
                {matLejligheder.length}{' '}
                {da
                  ? matLejligheder.length === 1
                    ? 'ejendom'
                    : 'ejendomme'
                  : matLejligheder.length === 1
                    ? 'property'
                    : 'properties'}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {matLejligheder.map((l) => (
                  <Link
                    key={`${l.bfe}-${l.dawaId ?? l.adresse}`}
                    href={
                      l.dawaId
                        ? `/dashboard/ejendomme/${l.dawaId}`
                        : `/dashboard/ejendomme/${l.bfe}`
                    }
                    className="block bg-slate-800/40 hover:bg-slate-800/60 border border-slate-700/40 rounded-xl p-4 transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <Home size={16} className="text-blue-400 mt-0.5 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-sm font-medium truncate">{l.adresse}</p>
                        <p className="text-slate-400 text-xs mt-0.5">
                          BFE <span className="font-mono">{l.bfe || '—'}</span>
                          {l.areal != null && ` · ${l.areal} m²`}
                          {l.ejer && l.ejer !== '–' && ` · ${l.ejer}`}
                        </p>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#0a1020]">
      {/* ─── Header + search input ─────────────────────────────────────── */}
      <div className="px-6 sm:px-8 pt-8 pb-6 border-b border-slate-700/40 shrink-0">
        <h1 className="text-2xl font-bold text-white mb-1">{t.title}</h1>
        <p className="text-slate-400 text-sm mb-5">{t.subtitle}</p>

        {/* Search box */}
        <div className="relative max-w-2xl">
          <Search
            size={20}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
          />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.placeholder}
            aria-label={t.placeholder}
            className="w-full bg-slate-800/60 border border-slate-600/50 focus:border-blue-500/60 rounded-2xl pl-12 pr-12 py-4 text-white placeholder:text-slate-500 outline-none transition-all text-base shadow-lg"
          />
          {/* Loading spinner / clear button */}
          <div className="absolute right-4 top-1/2 -translate-y-1/2">
            {anyLoading && hasQuery ? (
              <Loader2 size={18} className="text-blue-400 animate-spin" />
            ) : query.length > 0 ? (
              <button
                type="button"
                onClick={handleClear}
                aria-label="Ryd søgning"
                className="text-slate-500 hover:text-slate-300 transition-colors"
              >
                <X size={18} />
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* BIZZ-774: Filter-panel toggle */}
      <div className="flex items-center justify-end gap-2 px-6 sm:px-8 pt-3 shrink-0">
        <button
          onClick={() => setFilterOpen((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-slate-800/50 transition-colors"
          aria-expanded={filterOpen}
        >
          <SlidersHorizontal size={13} />
          {da ? 'Filtre' : 'Filters'}
          {filterOpen ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
        </button>
      </div>

      {/* ─── Tab bar ───────────────────────────────────────────────────── */}
      <div
        role="tablist"
        aria-label="Søgeresultat-kategorier"
        className="flex items-center gap-0 border-b border-slate-700/40 px-6 sm:px-8 shrink-0 overflow-x-auto"
      >
        <TabButton
          label={t.tabProperties}
          count={properties.length}
          active={activeTab === 'properties'}
          loading={loadingProps}
          color="emerald"
          onSelect={() => setActiveTab('properties')}
        />
        <TabButton
          label={t.tabCompanies}
          count={companies.length}
          active={activeTab === 'companies'}
          loading={loadingComps}
          color="blue"
          onSelect={() => setActiveTab('companies')}
        />
        <TabButton
          label={t.tabPeople}
          count={people.length}
          active={activeTab === 'people'}
          loading={loadingPeople}
          color="purple"
          onSelect={() => setActiveTab('people')}
        />
      </div>

      {/* ─── Results + optional filter side-panel ──────────────────────── */}
      <div className="flex-1 flex min-h-0">
        {/* BIZZ-774: Filter-panel right-hand sidebar. Collapsible. 3 columns
            for ejendomme/virksomheder/personer. Iter 1 ships a handful of
            working filters + stubs for the rest; full filter backends are
            tracked as iter 2 (see ticket). */}
        {filterOpen && (
          <aside
            aria-label={da ? 'Filter-panel' : 'Filter panel'}
            className="w-64 shrink-0 border-l border-slate-700/40 bg-slate-900/40 overflow-y-auto p-4 order-last"
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-white text-sm font-semibold flex items-center gap-2">
                <SlidersHorizontal size={14} className="text-blue-400" />
                {da ? 'Filtre' : 'Filters'}
              </h2>
              <button
                onClick={() => {
                  setHideRetiredProperties(true);
                  setOnlyActiveCompanies(true);
                }}
                className="text-xs text-slate-400 hover:text-blue-300 transition-colors"
              >
                {da ? 'Nulstil' : 'Reset'}
              </button>
            </div>

            {/* Column 1: Ejendomme */}
            <section className="mb-5 space-y-2">
              <h3 className="text-emerald-300 text-xs uppercase font-semibold tracking-wide">
                {da ? 'Ejendomme' : 'Properties'}
              </h3>
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hideRetiredProperties}
                  onChange={(e) => setHideRetiredProperties(e.target.checked)}
                  className="accent-blue-500"
                />
                {da ? 'Skjul udfasede' : 'Hide retired'}
              </label>
              <p className="text-[10px] text-slate-500 italic pl-5">
                {da
                  ? 'Flere filtre (opførelsesår, areal, energimærke, bygningstype, varmeform, ejerforhold, fredning, zone) kommer i iter 2.'
                  : 'More filters (year built, area, energy rating, building type, heating, ownership, listed, zone) in iter 2.'}
              </p>
            </section>

            {/* Column 2: Virksomheder */}
            <section className="mb-5 space-y-2">
              <h3 className="text-blue-300 text-xs uppercase font-semibold tracking-wide">
                {da ? 'Virksomheder' : 'Companies'}
              </h3>
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={onlyActiveCompanies}
                  onChange={(e) => setOnlyActiveCompanies(e.target.checked)}
                  className="accent-blue-500"
                />
                {da ? 'Kun aktive' : 'Active only'}
              </label>
              <p className="text-[10px] text-slate-500 italic pl-5">
                {da
                  ? 'Flere filtre (virksomhedsform, branche, geografi, stiftet, ansatte) kommer i iter 2.'
                  : 'More filters (form, industry, geography, founded, employees) in iter 2.'}
              </p>
            </section>

            {/* Column 3: Personer */}
            <section className="mb-2 space-y-2">
              <h3 className="text-purple-300 text-xs uppercase font-semibold tracking-wide">
                {da ? 'Personer' : 'People'}
              </h3>
              <p className="text-[10px] text-slate-500 italic">
                {da
                  ? 'Filtre (rolle, stilling, geografi) kommer i iter 2.'
                  : 'Filters (role, title, geography) in iter 2.'}
              </p>
            </section>
          </aside>
        )}

        <div className="flex-1 overflow-y-auto px-6 sm:px-8 py-6">
          {/* Initial state — nothing typed yet */}
          {!hasQuery && (
            <div className="flex flex-col items-center justify-center py-20 text-center gap-3">
              <div className="p-5 bg-slate-800/40 rounded-2xl text-slate-600">
                <Search size={32} />
              </div>
              <p className="text-slate-400 text-sm font-medium">{t.startTyping}</p>
            </div>
          )}

          {/* Properties tab */}
          {hasQuery && activeTab === 'properties' && (
            <div role="tabpanel" aria-label={t.tabProperties}>
              {loadingProps ? (
                <SkeletonList count={6} />
              ) : properties.length > 0 ? (
                <div className="space-y-3">
                  {properties.map((r) => (
                    <PropertyCard key={r.adresse.id} result={r} lang={lang} />
                  ))}
                </div>
              ) : (
                searched && (
                  <EmptyState
                    query={query}
                    message={`${t.noResultsFor} "${query.trim()}"`}
                    icon={<MapPin size={28} />}
                  />
                )
              )}
            </div>
          )}

          {/* Companies tab */}
          {hasQuery && activeTab === 'companies' && (
            <div role="tabpanel" aria-label={t.tabCompanies}>
              {loadingComps ? (
                <SkeletonList count={6} />
              ) : companies.filter((r) => !onlyActiveCompanies || r.active).length > 0 ? (
                <div className="space-y-3">
                  {companies
                    .filter((r) => !onlyActiveCompanies || r.active)
                    .map((r) => (
                      <CompanyCard key={r.cvr} result={r} lang={lang} />
                    ))}
                </div>
              ) : (
                searched && (
                  <EmptyState
                    query={query}
                    message={`${t.noResultsFor} "${query.trim()}"`}
                    icon={<Briefcase size={28} />}
                  />
                )
              )}
            </div>
          )}

          {/* People tab */}
          {hasQuery && activeTab === 'people' && (
            <div role="tabpanel" aria-label={t.tabPeople}>
              {loadingPeople ? (
                <SkeletonList count={6} />
              ) : people.length > 0 ? (
                <div className="space-y-3">
                  {people.map((r) => (
                    <PersonCard key={r.enhedsNummer} result={r} lang={lang} />
                  ))}
                </div>
              ) : (
                searched && (
                  <EmptyState
                    query={query}
                    message={`${t.noResultsFor} "${query.trim()}"`}
                    icon={<Users size={28} />}
                  />
                )
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
