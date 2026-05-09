/**
 * AnalyseModulLayout — shared wizard-layout for alle analyse-moduler.
 *
 * BIZZ-1231: Viser target-vælger + "Kør analyse" knap. Bygger prompt
 * via analysePromptBuilder og sender til AI Chat panel.
 *
 * Autocomplete-søgning bruger /api/search (same fuzzy logic som
 * dashboard-søgningen) med debounce og dropdown-resultater.
 *
 * @param modul - Analyse-modul definition
 * @returns Wizard UI
 */

'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { Search, ChevronRight, Sparkles, Building2, MapPin, User, Loader2 } from 'lucide-react';
import {
  buildAnalysePrompt,
  type AnalyseModul,
  type AnalyseTarget,
} from '@/app/lib/analysePromptBuilder';
import type { UnifiedSearchResult } from '@/app/api/search/route';

interface Props {
  /** Analyse-modul definition */
  modul: AnalyseModul;
  /** Valgfrit ekstra indhold (fx fil-upload) der vises mellem target-vælger og knap */
  children?: React.ReactNode;
  /** Ekstra kontekst at inkludere i prompten (fx parsed fil-data) */
  ekstraKontekst?: string;
}

/**
 * Ikon for søgeresultat baseret på type.
 *
 * @param type - Resultat-type
 * @returns Lucide ikon
 */
function ResultIcon({ type }: { type: string }) {
  if (type === 'company') return <Building2 size={14} className="text-blue-400" />;
  if (type === 'address') return <MapPin size={14} className="text-emerald-400" />;
  return <User size={14} className="text-purple-400" />;
}

/**
 * Shared analyse-modul layout med target-vælger, autocomplete-søgning
 * og AI Chat integration.
 *
 * @param props - Modul + optional children
 * @returns Layout JSX
 */
export default function AnalyseModulLayout({ modul, children, ekstraKontekst }: Props) {
  const [targetType, setTargetType] = useState<AnalyseTarget['type']>('virksomhed');
  const [targetId, setTargetId] = useState('');
  const [targetLabel, setTargetLabel] = useState('');
  const [loading, setLoading] = useState(false);

  /** Søge-state for autocomplete */
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UnifiedSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  /**
   * Debounced søgning mod /api/search ved tastatur-input.
   */
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (value.trim().length < 2) {
      setSearchResults([]);
      setDropdownOpen(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(value.trim())}`);
        if (res.ok) {
          const data: UnifiedSearchResult[] = await res.json();
          setSearchResults(data);
          setDropdownOpen(data.length > 0);
        }
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
  }, []);

  /**
   * Vælg et søgeresultat — sæt target-type, ID og label automatisk.
   *
   * @param result - Valgt søgeresultat
   */
  const selectResult = useCallback((result: UnifiedSearchResult) => {
    const typeMap: Record<string, AnalyseTarget['type']> = {
      company: 'virksomhed',
      address: 'ejendom',
      person: 'person',
    };
    setTargetType(typeMap[result.type] ?? 'virksomhed');
    setTargetId(result.id);
    setTargetLabel(result.title);
    setSearchQuery(result.title);
    setDropdownOpen(false);
    setSearchResults([]);
  }, []);

  /** Luk dropdown ved klik udenfor */
  useEffect(() => {
    /** @param e - Mouse event */
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  /**
   * Bygger prompt og sender til AI Chat via custom event.
   */
  const koerAnalyse = useCallback(() => {
    if (!targetId) return;
    setLoading(true);

    const target: AnalyseTarget = {
      type: targetType,
      id: targetId,
      label: targetLabel || targetId,
    };

    const prompt = buildAnalysePrompt(modul, target, ekstraKontekst);

    window.dispatchEvent(new CustomEvent('bizz:ai-open-with-prompt', { detail: { prompt } }));

    // Reset loading efter kort delay (chat åbner)
    setTimeout(() => setLoading(false), 500);
  }, [modul, targetType, targetId, targetLabel, ekstraKontekst]);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-white text-xl font-bold flex items-center gap-2">
          <Sparkles size={22} className="text-blue-400" />
          {modul.label}
        </h1>
        <p className="text-slate-400 text-sm mt-1">{modul.beskrivelse}</p>
      </div>

      {/* Target-vælger */}
      <div className="bg-slate-800/30 border border-slate-700/40 rounded-2xl p-6 space-y-4">
        <h2 className="text-white font-semibold text-sm">Vælg target</h2>

        {/* Autocomplete søgefelt */}
        <div className="relative" ref={dropdownRef}>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              onFocus={() => {
                if (searchResults.length > 0) setDropdownOpen(true);
              }}
              placeholder="Søg efter adresse, virksomhed eller person..."
              className="w-full pl-9 pr-10 py-2.5 bg-slate-800 border border-slate-700/60 rounded-lg text-sm text-white outline-none focus:border-blue-500/60"
            />
            {searchLoading && (
              <Loader2
                size={14}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-blue-400 animate-spin"
              />
            )}
          </div>

          {/* Dropdown med resultater */}
          {dropdownOpen && searchResults.length > 0 && (
            <div className="absolute z-50 w-full mt-1 bg-slate-800 border border-slate-700/60 rounded-lg shadow-xl max-h-64 overflow-y-auto">
              {searchResults.map((result) => (
                <button
                  key={`${result.type}-${result.id}`}
                  type="button"
                  onClick={() => selectResult(result)}
                  className="w-full text-left px-3 py-2.5 hover:bg-slate-700/50 transition-colors flex items-start gap-3 border-b border-slate-700/30 last:border-b-0"
                >
                  <div className="mt-0.5 shrink-0">
                    <ResultIcon type={result.type} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-white truncate">{result.title}</div>
                    <div className="text-xs text-slate-400 truncate">{result.subtitle}</div>
                  </div>
                  <span className="text-[10px] text-slate-500 shrink-0 mt-0.5">
                    {result.type === 'company'
                      ? 'Virksomhed'
                      : result.type === 'address'
                        ? 'Ejendom'
                        : 'Person'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Type toggle + manuelt ID input (fallback) */}
        <div className="flex items-center gap-2">
          <span className="text-slate-500 text-xs">eller angiv manuelt:</span>
          {(['person', 'virksomhed', 'ejendom'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTargetType(t)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                targetType === t
                  ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                  : 'bg-slate-800 text-slate-400 border border-slate-700/40 hover:text-slate-300'
              }`}
            >
              {t === 'person' ? 'Person' : t === 'virksomhed' ? 'Virksomhed' : 'Ejendom'}
            </button>
          ))}
        </div>

        <div className="flex gap-3">
          <input
            type="text"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            placeholder={
              targetType === 'person'
                ? 'EnhedsNummer'
                : targetType === 'virksomhed'
                  ? 'CVR-nummer (8 cifre)'
                  : 'BFE-nummer eller DAWA-ID'
            }
            className="flex-1 px-3 py-2.5 bg-slate-800 border border-slate-700/60 rounded-lg text-sm text-white outline-none focus:border-blue-500/60"
          />
          <input
            type="text"
            value={targetLabel}
            onChange={(e) => setTargetLabel(e.target.value)}
            placeholder="Navn (valgfrit)"
            className="w-48 px-3 py-2.5 bg-slate-800 border border-slate-700/60 rounded-lg text-sm text-white outline-none focus:border-blue-500/60"
          />
        </div>

        {/* Extra content (fil-upload etc.) */}
        {children}

        {/* Kør analyse */}
        <button
          onClick={koerAnalyse}
          disabled={!targetId || loading}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
        >
          {loading ? 'Starter analyse...' : 'Kør analyse'}
          <ChevronRight size={14} />
        </button>

        <p className="text-slate-600 text-[10px]">
          Analysen kører i AI Chat og bruger dine eksisterende tokens.
        </p>
      </div>

      {/* Tools info */}
      <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl p-4">
        <p className="text-slate-500 text-xs font-medium mb-2">
          Data-kilder brugt i denne analyse:
        </p>
        <div className="flex flex-wrap gap-1.5">
          {modul.anbefaletTools.map((tool) => (
            <span
              key={tool}
              className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700/40"
            >
              {tool}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
