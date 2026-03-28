'use client';

/**
 * Virksomheder listeside — søg efter danske virksomheder via CVR-nummer eller navn.
 *
 * Bruger /api/cvr-public (cvrapi.dk) til opslag. Gemmer seneste søgninger
 * i localStorage og viser dem som genveje. Matcher det visuelle design
 * fra ejendomme-listesiden.
 *
 * @see /api/cvr-public — server-side proxy til cvrapi.dk
 * @see /dashboard/companies/[cvr] — virksomhedsdetaljeside
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Link from 'next/link';
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
  MapPin,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import type { CVRPublicData } from '@/app/api/cvr-public/route';

// ─── Constants ──────────────────────────────────────────────────────────────

const RECENT_KEY = 'ba-companies-recent';
const MAX_RECENT = 8;

// ─── Translations ───────────────────────────────────────────────────────────

const t = {
  da: {
    title: 'Virksomheder',
    subtitle: 'Søg på CVR-nummer eller virksomhedsnavn',
    placeholder: 'Indtast 8-cifret CVR-nummer eller virksomhedsnavn...',
    searching: 'Søger i CVR-registret...',
    noResults: 'Ingen virksomhed fundet for',
    invalidCvr: 'CVR-nummer skal være 8 cifre',
    recentSearches: 'Seneste søgninger',
    clearHistory: 'Ryd historik',
    emptyTitle: 'Ingen virksomheder søgt endnu',
    emptyDesc:
      'Søg på et CVR-nummer eller virksomhedsnavn ovenfor — virksomheder du besøger vises her',
    active: 'Aktiv',
    inactive: 'Ophørt',
    employees: 'ansatte',
    infoBanner: 'Søg via CVR-nummer for præcise resultater',
    infoBannerDesc:
      'Indtast et 8-cifret CVR-nummer for at slå en virksomhed op direkte. Du kan også prøve et virksomhedsnavn — men CVR-opslag giver mest præcise data.',
    networkError: 'Netværksfejl — prøv igen',
    exampleSearches: ['Novo Nordisk', 'Mærsk', 'Carlsberg', 'LEGO', 'Danske Bank'],
  },
  en: {
    title: 'Companies',
    subtitle: 'Search by CVR number or company name',
    placeholder: 'Enter 8-digit CVR number or company name...',
    searching: 'Searching CVR registry...',
    noResults: 'No company found for',
    invalidCvr: 'CVR number must be 8 digits',
    recentSearches: 'Recent searches',
    clearHistory: 'Clear history',
    emptyTitle: 'No companies searched yet',
    emptyDesc:
      'Search for a CVR number or company name above — companies you visit will appear here',
    active: 'Active',
    inactive: 'Ceased',
    employees: 'employees',
    infoBanner: 'Search by CVR number for precise results',
    infoBannerDesc:
      'Enter an 8-digit CVR number to look up a company directly. You can also try a company name — but CVR lookup provides the most accurate data.',
    networkError: 'Network error — try again',
    exampleSearches: ['Novo Nordisk', 'Mærsk', 'Carlsberg', 'LEGO', 'Danske Bank'],
  },
} as const;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Cached recent company entry stored in localStorage */
interface RecentCompany {
  cvr: number;
  name: string;
  industry: string | null;
  address: string;
  zipcode: string;
  city: string;
  active: boolean;
  visitedAt: number;
}

// ─── Helper components ──────────────────────────────────────────────────────

/**
 * Card for a single recently visited company.
 * Shows name, CVR, industry, address, and time since last visit.
 *
 * @param company - The cached company data
 * @param lang - Current language for translations
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
 * A single search result row for a CVR lookup result.
 *
 * @param data - Company data from the API
 * @param lang - Current language
 */
function CompanyResultRow({ data, lang }: { data: CVRPublicData; lang: 'da' | 'en' }) {
  const isActive = !data.enddate;

  return (
    <Link
      href={`/dashboard/companies/${data.vat}`}
      className="group flex items-center gap-4 px-5 py-4 bg-slate-800/40 border border-slate-700/40 hover:border-blue-500/40 rounded-2xl transition-all hover:bg-slate-800/60"
    >
      <div className="p-2.5 rounded-xl text-blue-400 bg-blue-400/10 flex-shrink-0">
        <Briefcase size={20} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-white font-semibold text-sm truncate">{data.name}</p>
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium flex-shrink-0 ${
              isActive ? 'bg-emerald-600/20 text-emerald-400' : 'bg-red-600/20 text-red-400'
            }`}
          >
            {isActive ? (
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
        </div>
        <div className="flex items-center gap-3 mt-1 text-xs text-slate-400">
          <span className="font-mono">CVR {data.vat}</span>
          {data.industrydesc && (
            <>
              <span className="text-slate-600">|</span>
              <span className="truncate">{data.industrydesc}</span>
            </>
          )}
        </div>
        {data.address && (
          <div className="flex items-center gap-1 mt-1 text-xs text-slate-500">
            <MapPin size={11} className="flex-shrink-0" />
            <span className="truncate">
              {data.address}, {data.zipcode} {data.city}
            </span>
          </div>
        )}
      </div>
      <ChevronRight
        size={18}
        className="text-slate-600 group-hover:text-blue-400 transition-colors flex-shrink-0"
      />
    </Link>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

/**
 * VirksomhederListeside — Companies search and list page.
 *
 * Provides a search bar for CVR number or company name lookup,
 * displays search results, and shows recently visited companies
 * from localStorage. Supports bilingual DA/EN.
 */
export default function VirksomhederListeside() {
  const { lang } = useLanguage();
  const txt = t[lang];
  const inputRef = useRef<HTMLInputElement>(null);

  /** Stable timestamp for relative time display — avoids Date.now() during render */
  const now = useMemo(() => Date.now(), []);

  const [query, setQuery] = useState('');
  const [result, setResult] = useState<CVRPublicData | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchDone, setSearchDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Recent companies loaded from localStorage */
  const [recentCompanies, setRecentCompanies] = useState<RecentCompany[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const parsed = raw ? (JSON.parse(raw) as RecentCompany[]) : [];
      return Array.isArray(parsed) ? parsed.filter((c) => c?.cvr && c?.name) : [];
    } catch {
      return [];
    }
  });

  /**
   * Save a company to the recent searches list in localStorage.
   * Deduplicates by CVR and keeps only the most recent MAX_RECENT entries.
   */
  const saveRecent = useCallback((data: CVRPublicData) => {
    setRecentCompanies((prev) => {
      const entry: RecentCompany = {
        cvr: data.vat,
        name: data.name,
        industry: data.industrydesc,
        address: data.address,
        zipcode: data.zipcode,
        city: data.city,
        active: !data.enddate,
        visitedAt: Date.now(),
      };
      const filtered = prev.filter((c) => c.cvr !== data.vat);
      const updated = [entry, ...filtered].slice(0, MAX_RECENT);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
      } catch {
        /* ignore quota errors */
      }
      return updated;
    });
  }, []);

  /**
   * Debounced search — supports both CVR number (8 digits) and company name.
   * CVR: calls /api/cvr-public?vat=...
   * Name: calls /api/search?q=... (unified search, filters company results)
   */
  useEffect(() => {
    setSearchDone(false);
    setError(null);
    setResult(null);

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

    const isCvr = /^\d{8}$/.test(trimmed);

    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        if (isCvr) {
          // Direct CVR lookup
          const res = await fetch(`/api/cvr-public?vat=${encodeURIComponent(trimmed)}`);
          const json = await res.json();
          if (!res.ok || json.error) {
            setError(json.error ?? txt.networkError);
            setResult(null);
          } else {
            const data = json as CVRPublicData;
            setResult(data);
            setError(null);
            saveRecent(data);
          }
        } else {
          // Name search via unified search API (filter company results)
          const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`);
          const results = res.ok ? await res.json() : [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const company = results.find((r: any) => r.type === 'company');
          if (company) {
            // Fetch full company data from CVR
            const cvrRes = await fetch(`/api/cvr-public?vat=${company.id}`);
            const cvrJson = await cvrRes.json();
            if (cvrRes.ok && !cvrJson.error) {
              setResult(cvrJson as CVRPublicData);
              setError(null);
              saveRecent(cvrJson as CVRPublicData);
            } else {
              setError(`${txt.noResults} "${trimmed}"`);
              setResult(null);
            }
          } else {
            setError(`${txt.noResults} "${trimmed}"`);
            setResult(null);
          }
        }
      } catch {
        setError(txt.networkError);
        setResult(null);
      } finally {
        setSearching(false);
        setSearchDone(true);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [query, txt.invalidCvr, txt.networkError, txt.noResults, saveRecent]);

  /** Clear recent searches from localStorage and state */
  function clearRecent() {
    try {
      localStorage.removeItem(RECENT_KEY);
    } catch {
      /* ignore */
    }
    setRecentCompanies([]);
  }

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
              onChange={(e) => setQuery(e.target.value)}
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
                    setResult(null);
                    setError(null);
                    setSearchDone(false);
                    inputRef.current?.focus();
                  }}
                  className="text-slate-500 hover:text-slate-300 transition-colors"
                >
                  <X size={18} />
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* ─── Content ─── */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {/* Search loading state */}
        {searching && (
          <div className="flex items-center gap-3 px-4 py-6 text-slate-400 text-sm">
            <Loader2 size={16} className="animate-spin text-blue-400" />
            {txt.searching}
          </div>
        )}

        {/* Search result */}
        {!searching && searchDone && result && (
          <div className="mb-8 space-y-3">
            <CompanyResultRow data={result} lang={lang} />
          </div>
        )}

        {/* Search error */}
        {!searching && searchDone && error && (
          <div className="mb-8 px-5 py-4 bg-slate-800/40 border border-slate-700/40 rounded-2xl text-center">
            <p className="text-slate-400 text-sm">
              {error.includes('fundet') || error.includes('found')
                ? `${txt.noResults} "${query}"`
                : error}
            </p>
          </div>
        )}

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
          !searching &&
          !searchDone && (
            <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
              <div className="p-4 bg-slate-800/40 rounded-2xl">
                <Building2 size={28} className="text-slate-600" />
              </div>
              <p className="text-slate-400 text-sm font-medium">{txt.emptyTitle}</p>
              <p className="text-slate-600 text-xs max-w-xs leading-relaxed">{txt.emptyDesc}</p>
            </div>
          )
        )}

        {/* Info banner */}
        <div className="mt-8 flex items-start gap-3 bg-blue-600/8 border border-blue-500/20 rounded-2xl px-5 py-4">
          <Briefcase size={18} className="text-blue-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-blue-300 text-sm font-medium">{txt.infoBanner}</p>
            <p className="text-slate-400 text-xs mt-0.5 leading-relaxed">{txt.infoBannerDesc}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
