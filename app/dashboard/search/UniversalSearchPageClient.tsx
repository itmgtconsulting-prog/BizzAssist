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
export default function UniversalSearchPageClient() {
  const { lang } = useLanguage();
  const t = translations[lang].searchPage;

  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('properties');

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

      {/* ─── Results ───────────────────────────────────────────────────── */}
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
            ) : companies.length > 0 ? (
              <div className="space-y-3">
                {companies.map((r) => (
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
  );
}
