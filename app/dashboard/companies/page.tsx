'use client';

/**
 * Virksomheder listeside — søg efter danske virksomheder via CVR-nummer eller navn.
 *
 * Bruger /api/cvr-search til autocomplete-søgning i CVR ES.
 * Gemmer seneste besøgte virksomheder i Supabase via /api/recents.
 * Matcher interaktionsmønsteret fra ejendomme-listesiden (dropdown autocomplete).
 *
 * @see /api/cvr-search — server-side multi-result søgning i CVR ES
 * @see /dashboard/companies/[cvr] — virksomhedsdetaljeside
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Search,
  Building2,
  ChevronRight,
  X,
  Loader2,
  Clock,
  Briefcase,
  CheckCircle,
  XCircle,
  ArrowRight,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import type { CVRSearchResult } from '@/app/api/cvr-search/route';
import { getRecentCompanies, type RecentCompany } from '@/app/lib/recentCompanies';

// ─── Translations ───────────────────────────────────────────────────────────

const t = {
  da: {
    title: 'Virksomheder',
    subtitle: 'Søg på CVR-nummer eller virksomhedsnavn',
    placeholder: 'Indtast CVR-nummer eller virksomhedsnavn...',
    searching: 'Søger i CVR-registret...',
    noResults: 'Ingen virksomhed fundet for',
    invalidCvr: 'CVR-nummer skal være 8 cifre',
    recentSearches: 'Seneste besøgte',
    clearHistory: 'Ryd historik',
    emptyTitle: 'Ingen virksomheder besøgt endnu',
    emptyDesc:
      'Søg på et CVR-nummer eller virksomhedsnavn ovenfor — virksomheder du besøger vises her',
    active: 'Aktiv',
    inactive: 'Ophørt',
    networkError: 'Netværksfejl — prøv igen',
    showingBest: 'Viser de bedste resultater',
  },
  en: {
    title: 'Companies',
    subtitle: 'Search by CVR number or company name',
    placeholder: 'Enter CVR number or company name...',
    searching: 'Searching CVR registry...',
    noResults: 'No company found for',
    invalidCvr: 'CVR number must be 8 digits',
    recentSearches: 'Recently visited',
    clearHistory: 'Clear history',
    emptyTitle: 'No companies visited yet',
    emptyDesc:
      'Search for a CVR number or company name above — companies you visit will appear here',
    active: 'Active',
    inactive: 'Ceased',
    networkError: 'Network error — try again',
    showingBest: 'Showing best results',
  },
} as const;

// ─── Helper components ──────────────────────────────────────────────────────

/**
 * Card for a single recently visited company.
 *
 * @param company - The cached company data
 * @param lang - Current language for translations
 * @param now - Stable timestamp for relative time
 */
function RecentCompanyCard({
  company,
  lang,
  now,
}: {
  company: RecentCompany;
  lang: 'da' | 'en';
  now: number;
}) {
  const minAgo = Math.round((now - company.visitedAt) / 60000);
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
      href={`/dashboard/companies/${company.cvr}`}
      className="group bg-slate-800/40 border border-slate-700/40 hover:border-blue-500/40 rounded-2xl p-5 flex flex-col gap-3 transition-all hover:bg-slate-800/60"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="p-2 rounded-xl text-blue-400 bg-blue-400/10">
          <Briefcase size={18} />
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium ${
              company.active ? 'bg-emerald-600/20 text-emerald-400' : 'bg-red-600/20 text-red-400'
            }`}
          >
            {company.active ? (
              <>
                <CheckCircle size={10} />
                {t[lang].active}
              </>
            ) : (
              <>
                <XCircle size={10} />
                {t[lang].inactive}
              </>
            )}
          </span>
          <div className="flex items-center gap-1 text-slate-500 text-xs">
            <Clock size={11} />
            {timeText}
          </div>
        </div>
      </div>
      <div>
        <p className="text-white font-semibold text-sm leading-snug">{company.name}</p>
        <p className="text-slate-400 text-xs mt-0.5">
          CVR {company.cvr} · {company.zipcode} {company.city}
        </p>
        {company.industry && <p className="text-slate-500 text-xs mt-1">{company.industry}</p>}
      </div>
      <div className="flex items-center justify-end pt-1 border-t border-slate-700/40">
        <ChevronRight
          size={16}
          className="text-slate-600 group-hover:text-blue-400 transition-colors"
        />
      </div>
    </Link>
  );
}

/**
 * Et enkelt CVR-resultat i dropdown.
 *
 * @param data - Virksomhedsresultat fra /api/cvr-search
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
  data: CVRSearchResult;
  aktiv?: boolean;
  lang: 'da' | 'en';
  onVælg: (r: CVRSearchResult) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onVælg(data)}
      className={`w-full flex items-center gap-3 px-4 py-3 transition-colors text-left group ${
        aktiv ? 'bg-blue-600/20' : 'hover:bg-slate-700/50'
      }`}
    >
      <div
        className={`p-1.5 rounded-lg flex-shrink-0 transition-colors ${
          aktiv ? 'bg-blue-600/30' : 'bg-slate-700 group-hover:bg-blue-600/20'
        }`}
      >
        <Briefcase
          size={13}
          className={aktiv ? 'text-blue-400' : 'text-slate-400 group-hover:text-blue-400'}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-white text-sm font-medium truncate">{data.name}</p>
          <span
            className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium flex-shrink-0 ${
              data.active ? 'bg-emerald-600/20 text-emerald-400' : 'bg-red-600/20 text-red-400'
            }`}
          >
            {data.active ? t[lang].active : t[lang].inactive}
          </span>
          {data.companyType && (
            <span className="text-[10px] text-slate-500 flex-shrink-0">{data.companyType}</span>
          )}
        </div>
        <p className="text-slate-500 text-xs truncate">
          CVR {data.cvr}
          {data.industry ? ` · ${data.industry}` : ''}
          {data.address ? ` · ${data.address}, ${data.zipcode} ${data.city}` : ''}
        </p>
      </div>
      <ArrowRight
        size={13}
        className={aktiv ? 'text-blue-400' : 'text-slate-600 group-hover:text-blue-400'}
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
  results: CVRSearchResult[];
  searching: boolean;
  searchDone: boolean;
  error: string | null;
  markeret: number;
  onVælg: (r: CVRSearchResult) => void;
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
              key={r.cvr}
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

// ─── Main component ─────────────────────────────────────────────────────────

/**
 * VirksomhederListeside — Companies search and list page.
 *
 * Autocomplete-dropdown søgning (som ejendomme) + seneste besøgte virksomheder.
 * Understøtter tastatur-navigation (pil op/ned, enter, escape).
 */
export default function VirksomhederListeside() {
  const { lang } = useLanguage();
  const txt = t[lang];
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  /** Stable timestamp for relative time display */
  const now = useMemo(() => Date.now(), []);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CVRSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchDone, setSearchDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [åben, setÅben] = useState(false);
  const [markeret, setMarkeret] = useState(-1);

  /** Recent companies loaded from Supabase (in-memory cache) */
  const [recentCompanies, setRecentCompanies] = useState<RecentCompany[]>(() =>
    getRecentCompanies()
  );

  /** Listen for cache updates from background fetch */
  useEffect(() => {
    const handler = () => setRecentCompanies(getRecentCompanies());
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
   * Debounced search — calls /api/cvr-search?q=...
   * Virksomheder gemmes IKKE i historikken her — kun når detaljesiden åbnes.
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

    // Digits only but not 8 → still typing CVR or invalid
    if (/^\d+$/.test(trimmed) && trimmed.length < 8) return;
    if (/^\d+$/.test(trimmed) && trimmed.length > 8) {
      setError(txt.invalidCvr);
      setSearchDone(true);
      return;
    }

    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/cvr-search?q=${encodeURIComponent(trimmed)}`);
        if (!res.ok) {
          setError(txt.networkError);
          setResults([]);
        } else {
          const json = await res.json();
          const list = (json.results ?? []) as CVRSearchResult[];
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
  }, [query, txt.invalidCvr, txt.networkError, txt.noResults]);

  /** Håndterer valg af virksomhed fra dropdown — navigerer til detaljeside */
  function vælgVirksomhed(r: CVRSearchResult) {
    setÅben(false);
    setQuery('');
    router.push(`/dashboard/companies/${r.cvr}`);
  }

  /** Clear recent companies from Supabase and state */
  function clearRecent() {
    fetch('/api/recents?type=company', { method: 'DELETE' }).catch(() => {
      /* ignore */
    });
    setRecentCompanies([]);
  }

  const visDropdown =
    åben && query.trim().length >= 2 && (results.length > 0 || searching || searchDone);

  return (
    <div className="flex-1 flex flex-col bg-[#0a1628]">
      {/* ─── Header ─── */}
      <div className="px-8 pt-8 pb-6 border-b border-slate-700/40">
        <h1 className="text-2xl font-bold text-blue-400 mb-1">{txt.title}</h1>
        <p className="text-slate-400 text-sm">{txt.subtitle}</p>

        {/* Search box */}
        <div className="relative mt-5">
          <div className="relative">
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
                  if (valgt) vælgVirksomhed(valgt);
                } else if (e.key === 'Escape') {
                  setÅben(false);
                  setMarkeret(-1);
                }
              }}
              placeholder={txt.placeholder}
              className="w-full bg-slate-800/60 border border-slate-600/50 focus:border-blue-500/60 rounded-2xl pl-11 pr-12 py-4 text-white placeholder:text-slate-500 outline-none transition-all text-base shadow-lg"
            />
            {/* Loader / Clear button */}
            <div className="absolute right-4 top-1/2 -translate-y-1/2">
              {searching ? (
                <Loader2 size={18} className="text-blue-400 animate-spin" />
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
              onVælg={vælgVirksomhed}
              lang={lang}
            />
          )}
        </div>
      </div>

      {/* ─── Content ─── */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {/* Recent companies */}
        {recentCompanies.length > 0 ? (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Clock size={15} className="text-slate-400" />
                <h2 className="text-white font-semibold text-base">{txt.recentSearches}</h2>
              </div>
              <button
                type="button"
                onClick={clearRecent}
                className="text-slate-600 hover:text-slate-400 text-xs transition-colors"
              >
                {txt.clearHistory}
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {recentCompanies.map((c) => (
                <RecentCompanyCard key={c.cvr} company={c} lang={lang} now={now} />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
            <div className="p-4 bg-slate-800/40 rounded-2xl">
              <Building2 size={28} className="text-slate-600" />
            </div>
            <p className="text-slate-400 text-sm font-medium">{txt.emptyTitle}</p>
            <p className="text-slate-600 text-xs max-w-xs leading-relaxed">{txt.emptyDesc}</p>
          </div>
        )}
      </div>
    </div>
  );
}
