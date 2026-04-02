'use client';

/**
 * Personer listeside — søg efter personer og virksomheds-deltagere i CVR-registret.
 *
 * Bruger /api/person-search til autocomplete-søgning i CVR ES deltager-index.
 * Gemmer seneste besøgte personer i Supabase via /api/recents (type=person).
 * Matcher interaktionsmønsteret fra ejendomme- og virksomheds-listesiderne
 * (dropdown autocomplete med tastatur-navigation).
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
  },
} as const;

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

// ─── Main component ─────────────────────────────────────────────────────────

/**
 * PersonerListeside — Person search and list page.
 *
 * Autocomplete-dropdown søgning (som ejendomme/virksomheder) + seneste besøgte.
 * Understøtter tastatur-navigation (pil op/ned, enter, escape).
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
              {recentPersons.map((p) => (
                <RecentPersonCard key={p.enhedsNummer} person={p} lang={lang} now={now} />
              ))}
            </div>
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
