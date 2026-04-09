'use client';

/**
 * AI Analyse-side — ét søgefelt + fire analysetyper.
 *
 * Flow:
 *  1. Søg efter en virksomhed eller ejendom via unified search
 *  2. Vælg analysetype (Due Diligence, Konkurrentanalyse, Investeringsscreening, Markedsanalyse)
 *  3. Klik "Kør analyse" → streaming resultat via /api/analysis/run
 *
 * Bruger de samme AI-tools som AI Bizzness Assistent:
 * CVR, regnskab, BBR, vurdering, ejerskab, salgshistorik, plandata m.fl.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  ClipboardCheck,
  BarChart3,
  Target,
  TrendingUp,
  Search,
  X,
  Building2,
  Briefcase,
  MapPin,
  User,
  Loader2,
  AlertCircle,
  RefreshCw,
  ChevronDown,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import type { UnifiedSearchResult } from '@/app/api/search/route';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Union of all supported analysis type identifiers */
type AnalysisType = 'due_diligence' | 'konkurrent' | 'investering' | 'marked';

/** A selected entity from the search results */
interface SelectedEntity {
  id: string;
  title: string;
  subtitle: string;
  type: 'address' | 'company' | 'person';
  meta?: Record<string, string>;
}

/** Configuration for a single analysis type card */
interface AnalysisTypeConfig {
  id: AnalysisType;
  titleDa: string;
  titleEn: string;
  descDa: string;
  descEn: string;
  iconColor: string;
  iconBg: string;
  icon: React.ElementType;
}

// ─── Analysis type definitions ────────────────────────────────────────────────

/** All four analysis type configurations */
const ANALYSIS_TYPES: AnalysisTypeConfig[] = [
  {
    id: 'due_diligence',
    titleDa: 'Due Diligence',
    titleEn: 'Due Diligence',
    descDa: 'Grundig gennemgang — økonomi, ejerskab, risici',
    descEn: 'Thorough review — financials, ownership, risks',
    icon: ClipboardCheck,
    iconColor: 'text-emerald-400',
    iconBg: 'bg-emerald-500/10',
  },
  {
    id: 'konkurrent',
    titleDa: 'Konkurrentanalyse',
    titleEn: 'Competitor Analysis',
    descDa: 'Sammenlign med konkurrenter i samme branche',
    descEn: 'Compare companies in the same industry',
    icon: BarChart3,
    iconColor: 'text-blue-400',
    iconBg: 'bg-blue-500/10',
  },
  {
    id: 'investering',
    titleDa: 'Investeringsscreening',
    titleEn: 'Investment Screening',
    descDa: 'Vurder investeringspotentiale og afkast',
    descEn: 'Assess investment potential and return',
    icon: Target,
    iconColor: 'text-purple-400',
    iconBg: 'bg-purple-500/10',
  },
  {
    id: 'marked',
    titleDa: 'Markedsanalyse',
    titleEn: 'Market Analysis',
    descDa: 'Ejendomsmarked i et geografisk område',
    descEn: 'Real estate market in a geographic area',
    icon: TrendingUp,
    iconColor: 'text-amber-400',
    iconBg: 'bg-amber-500/10',
  },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * Icon component for a search result based on its type.
 *
 * @param type - 'address' | 'company' | 'person'
 */
function ResultTypeIcon({ type }: { type: 'address' | 'company' | 'person' }) {
  if (type === 'company') return <Briefcase size={14} className="text-blue-400" />;
  if (type === 'address') return <MapPin size={14} className="text-emerald-400" />;
  return <User size={14} className="text-purple-400" />;
}

/**
 * Chip showing the currently selected entity with a dismiss button.
 *
 * @param entity  - Selected entity to display
 * @param onClear - Called when user clicks the dismiss button
 */
function EntityChip({ entity, onClear }: { entity: SelectedEntity; onClear: () => void }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
      <ResultTypeIcon type={entity.type} />
      <div className="min-w-0">
        <div className="text-sm font-medium text-white truncate max-w-xs">{entity.title}</div>
        {entity.subtitle && (
          <div className="text-xs text-slate-500 truncate max-w-xs">{entity.subtitle}</div>
        )}
      </div>
      <button
        type="button"
        onClick={onClear}
        aria-label="Fjern valgt entitet"
        className="ml-1 text-slate-500 hover:text-white transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
}

/** Props for the AnalysisTypeCard component */
interface AnalysisTypeCardProps {
  config: AnalysisTypeConfig;
  selected: boolean;
  lang: 'da' | 'en';
  onClick: () => void;
}

/**
 * Single analysis type selection card.
 * Highlights with a blue border when selected.
 *
 * @param props - AnalysisTypeCardProps
 */
function AnalysisTypeCard({ config, selected, lang, onClick }: AnalysisTypeCardProps) {
  const Icon = config.icon;
  const title = lang === 'da' ? config.titleDa : config.titleEn;
  const desc = lang === 'da' ? config.descDa : config.descEn;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={[
        'w-full text-left rounded-2xl border p-4 transition-all duration-150',
        'bg-white/5 hover:bg-white/8',
        selected
          ? 'border-blue-500 ring-1 ring-blue-500/40'
          : 'border-white/8 hover:border-blue-500/40',
      ].join(' ')}
    >
      <div className="flex items-start gap-3">
        <div
          className={[
            'w-9 h-9 rounded-xl flex items-center justify-center shrink-0',
            config.iconBg,
          ].join(' ')}
        >
          <Icon size={17} className={config.iconColor} />
        </div>
        <div className="min-w-0">
          <div className="font-semibold text-white text-sm">{title}</div>
          <div className="text-slate-400 text-xs mt-0.5 leading-snug">{desc}</div>
        </div>
        {selected && (
          <div className="ml-auto shrink-0 w-4 h-4 rounded-full bg-blue-500 flex items-center justify-center">
            <div className="w-2 h-2 rounded-full bg-white" />
          </div>
        )}
      </div>
    </button>
  );
}

/** Props for the MarkdownResult display panel */
interface MarkdownResultProps {
  text: string;
  streaming: boolean;
  statusMessages: string[];
}

/**
 * Renders streamed markdown output as structured HTML.
 * Shows live tool-status messages while streaming.
 *
 * @param props - MarkdownResultProps
 */
function MarkdownResult({ text, streaming, statusMessages }: MarkdownResultProps) {
  const lines = text.split('\n');
  const lastStatus = statusMessages[statusMessages.length - 1];

  return (
    <div className="space-y-3">
      {/* Tool status indicator while streaming */}
      {streaming && lastStatus && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 size={12} className="animate-spin text-blue-400 shrink-0" />
          <span>{lastStatus}</span>
        </div>
      )}

      {/* Rendered markdown */}
      {text && (
        <div className="prose prose-invert prose-sm max-w-none space-y-2">
          {lines.map((line, i) => {
            if (line.startsWith('## '))
              return (
                <h2
                  key={i}
                  className="text-base font-bold text-white mt-6 mb-2 first:mt-0 border-b border-white/10 pb-1"
                >
                  {line.slice(3)}
                </h2>
              );
            if (line.startsWith('### '))
              return (
                <h3 key={i} className="text-sm font-semibold text-slate-200 mt-4 mb-1">
                  {line.slice(4)}
                </h3>
              );
            if (line.startsWith('# '))
              return (
                <h1 key={i} className="text-lg font-bold text-white mt-4 mb-2">
                  {line.slice(2)}
                </h1>
              );
            if (line.startsWith('- ') || line.startsWith('* '))
              return (
                <div key={i} className="flex gap-2 text-slate-300 text-sm leading-relaxed">
                  <span className="text-blue-400 mt-1 shrink-0">•</span>
                  <span>{renderInline(line.slice(2))}</span>
                </div>
              );
            const numMatch = line.match(/^(\d+)\.\s(.*)$/);
            if (numMatch)
              return (
                <div key={i} className="flex gap-2 text-slate-300 text-sm leading-relaxed">
                  <span className="text-blue-400 shrink-0 tabular-nums">{numMatch[1]}.</span>
                  <span>{renderInline(numMatch[2])}</span>
                </div>
              );
            if (line.trim() === '---' || line.trim() === '***')
              return <hr key={i} className="border-white/10 my-4" />;
            if (line.trim() === '') return <div key={i} className="h-2" />;
            return (
              <p key={i} className="text-slate-300 text-sm leading-relaxed">
                {renderInline(line)}
              </p>
            );
          })}
          {streaming && (
            <span className="inline-block w-1 h-4 bg-blue-400 animate-pulse ml-0.5 align-middle" />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Renders inline markdown (bold/italic) within a text segment.
 *
 * @param text - Raw text with optional ** and * markers
 * @returns React nodes
 */
function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return (
        <strong key={i} className="text-white font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    if (part.startsWith('*') && part.endsWith('*'))
      return (
        <em key={i} className="text-slate-200 italic">
          {part.slice(1, -1)}
        </em>
      );
    return part;
  });
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * AI Analyse-side.
 *
 * State machine:
 *  'search'    → søgefelt med autocomplete
 *  'ready'     → entitet valgt, vælg analysetype
 *  'streaming' → analyse kører, viser tool-status + streaming tekst
 *  'done'      → analyse færdig
 */
export default function AnalysisPageClient() {
  const { lang } = useLanguage();

  /** Unified search query text */
  const [query, setQuery] = useState('');
  /** Autocomplete dropdown results */
  const [searchResults, setSearchResults] = useState<UnifiedSearchResult[]>([]);
  /** True while fetching search results */
  const [searchLoading, setSearchLoading] = useState(false);
  /** True when dropdown should be visible */
  const [dropdownOpen, setDropdownOpen] = useState(false);

  /** The entity the user has selected from search */
  const [selectedEntity, setSelectedEntity] = useState<SelectedEntity | null>(null);
  /** The analysis type the user has chosen */
  const [selectedType, setSelectedType] = useState<AnalysisType | null>(null);

  /** Page phase */
  const [phase, setPhase] = useState<'search' | 'ready' | 'streaming' | 'done'>('search');
  /** Streamed markdown result text */
  const [resultText, setResultText] = useState('');
  /** Tool status messages shown while streaming */
  const [statusMessages, setStatusMessages] = useState<string[]>([]);
  /** Error message */
  const [errorMessage, setErrorMessage] = useState('');

  const abortRef = useRef<AbortController | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultBottomRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // ── Search debounce ─────────────────────────────────────────────────────────

  /**
   * Debounced handler for search query changes.
   * Waits 300ms after last keystroke before fetching.
   *
   * @param value - Current input value
   */
  const handleQueryChange = useCallback((value: string) => {
    setQuery(value);

    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);

    if (!value.trim()) {
      setSearchResults([]);
      setDropdownOpen(false);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(value.trim())}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const data = (await res.json()) as UnifiedSearchResult[];
          setSearchResults(data.slice(0, 6));
          setDropdownOpen(data.length > 0);
        }
      } catch {
        // Network error — fail silently
      } finally {
        setSearchLoading(false);
      }
    }, 300);
  }, []);

  /** Close dropdown when clicking outside */
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        searchInputRef.current &&
        !searchInputRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // ── Entity selection ────────────────────────────────────────────────────────

  /**
   * Handle selection of a search result.
   * Transitions to the 'ready' phase.
   *
   * @param result - Unified search result the user clicked
   */
  const handleSelectResult = useCallback((result: UnifiedSearchResult) => {
    setSelectedEntity({
      id: result.id,
      title: result.title,
      subtitle: result.subtitle,
      type: result.type,
      meta: result.meta as Record<string, string> | undefined,
    });
    setQuery('');
    setSearchResults([]);
    setDropdownOpen(false);
    setSelectedType(null);
    setPhase('ready');
  }, []);

  /** Clear selected entity and return to search */
  const handleClearEntity = useCallback(() => {
    setSelectedEntity(null);
    setSelectedType(null);
    setPhase('search');
    setResultText('');
    setErrorMessage('');
    setStatusMessages([]);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, []);

  // ── Analysis submission ─────────────────────────────────────────────────────

  /**
   * Submit the analysis request.
   * Opens an SSE stream from /api/analysis/run and accumulates chunks.
   */
  const handleSubmit = useCallback(async () => {
    if (!selectedEntity || !selectedType) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setResultText('');
    setErrorMessage('');
    setStatusMessages([]);
    setPhase('streaming');

    try {
      const res = await fetch('/api/analysis/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: selectedType, entity: selectedEntity }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        setErrorMessage(json.error ?? `Serverfejl (${res.status})`);
        setPhase('done');
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setErrorMessage('Kunne ikke læse svarstrøm');
        setPhase('done');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const event of events) {
          const dataLine = event.startsWith('data: ') ? event.slice(6).trim() : '';
          if (!dataLine || dataLine === '[DONE]') continue;

          try {
            const parsed = JSON.parse(dataLine) as {
              t?: string;
              status?: string;
              error?: string;
            };
            if (parsed.error) {
              setErrorMessage(parsed.error);
            } else if (parsed.status) {
              setStatusMessages((prev) => [...prev, parsed.status!]);
            } else if (parsed.t) {
              setResultText((prev) => prev + parsed.t);
              requestAnimationFrame(() => {
                resultBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
              });
            }
          } catch {
            // Malformed SSE chunk — skip
          }
        }
      }

      setPhase('done');
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setErrorMessage(err instanceof Error ? err.message : 'Uventet fejl');
      setPhase('done');
    }
  }, [selectedEntity, selectedType]);

  /** Reset everything and start a new analysis */
  const handleReset = useCallback(() => {
    abortRef.current?.abort();
    setPhase('search');
    setSelectedEntity(null);
    setSelectedType(null);
    setResultText('');
    setErrorMessage('');
    setStatusMessages([]);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, []);

  // ── Labels ──────────────────────────────────────────────────────────────────

  const pageTitle = lang === 'da' ? 'AI Analyse' : 'AI Analysis';
  const searchPlaceholder =
    lang === 'da'
      ? 'Søg virksomhed, adresse eller CVR-nummer…'
      : 'Search company, address or CVR number…';
  const chooseTypeLabel = lang === 'da' ? 'Vælg analysetype' : 'Choose analysis type';
  const runLabel = lang === 'da' ? 'Kør analyse' : 'Run analysis';
  const analysisLabel = lang === 'da' ? 'Analyserer…' : 'Analysing…';
  const newAnalysisLabel = lang === 'da' ? 'Ny analyse' : 'New analysis';
  const errorLabel = lang === 'da' ? 'Der opstod en fejl' : 'An error occurred';
  const tryAgainLabel = lang === 'da' ? 'Prøv igen' : 'Try again';
  const resultLabel = lang === 'da' ? 'Analyseresultat' : 'Analysis result';

  const activeConfig = ANALYSIS_TYPES.find((t) => t.id === selectedType) ?? null;
  const isStreaming = phase === 'streaming';

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">{pageTitle}</h1>
        {(phase === 'streaming' || phase === 'done') && (
          <button
            type="button"
            onClick={handleReset}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors"
          >
            <RefreshCw size={13} />
            {newAnalysisLabel}
          </button>
        )}
      </div>

      {/* ── Phase: search ── */}
      {phase === 'search' && (
        <div className="max-w-xl space-y-4">
          {/* Search input + dropdown */}
          <div className="relative">
            <div className="relative flex items-center">
              {searchLoading ? (
                <Loader2
                  size={16}
                  className="absolute left-3.5 text-slate-400 animate-spin pointer-events-none"
                />
              ) : (
                <Search
                  size={16}
                  className="absolute left-3.5 text-slate-500 pointer-events-none"
                />
              )}
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(e) => handleQueryChange(e.target.value)}
                onFocus={() => searchResults.length > 0 && setDropdownOpen(true)}
                placeholder={searchPlaceholder}
                autoFocus
                className={[
                  'w-full rounded-2xl border border-white/10 bg-white/5',
                  'pl-10 pr-4 py-3 text-sm text-slate-200 placeholder:text-slate-600',
                  'focus:border-blue-500/60 focus:outline-none focus:ring-1 focus:ring-blue-500/30',
                  'transition-colors',
                ].join(' ')}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => handleQueryChange('')}
                  aria-label="Ryd søgning"
                  className="absolute right-3.5 text-slate-500 hover:text-white transition-colors"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {/* Dropdown */}
            {dropdownOpen && searchResults.length > 0 && (
              <div
                ref={dropdownRef}
                className={[
                  'absolute z-50 mt-1.5 w-full rounded-2xl border border-white/10',
                  'bg-[#0f172a] shadow-xl overflow-hidden',
                ].join(' ')}
              >
                {searchResults.map((result) => (
                  <button
                    key={`${result.type}-${result.id}`}
                    type="button"
                    onClick={() => handleSelectResult(result)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors text-left"
                  >
                    <div className="shrink-0 w-7 h-7 rounded-lg bg-white/5 border border-white/8 flex items-center justify-center">
                      <ResultTypeIcon type={result.type} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-white truncate">{result.title}</div>
                      {result.subtitle && (
                        <div className="text-xs text-slate-500 truncate">{result.subtitle}</div>
                      )}
                    </div>
                    <ChevronDown size={13} className="text-slate-600 shrink-0 -rotate-90" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Helper text */}
          <p className="text-xs text-slate-600">
            {lang === 'da'
              ? 'Søg efter en virksomhed ved navn eller CVR-nummer, eller en ejendom ved adresse.'
              : 'Search for a company by name or CVR number, or a property by address.'}
          </p>
        </div>
      )}

      {/* ── Phase: ready ── */}
      {phase === 'ready' && selectedEntity && (
        <div className="max-w-xl space-y-6">
          {/* Selected entity chip */}
          <div className="space-y-2">
            <p className="text-xs text-slate-500 uppercase tracking-wider font-medium">
              {lang === 'da' ? 'Valgt entitet' : 'Selected entity'}
            </p>
            <EntityChip entity={selectedEntity} onClear={handleClearEntity} />
          </div>

          {/* Analysis type selection */}
          <div className="space-y-3">
            <p className="text-xs text-slate-500 uppercase tracking-wider font-medium">
              {chooseTypeLabel}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {ANALYSIS_TYPES.map((config) => (
                <AnalysisTypeCard
                  key={config.id}
                  config={config}
                  selected={selectedType === config.id}
                  lang={lang}
                  onClick={() => setSelectedType(config.id)}
                />
              ))}
            </div>
          </div>

          {/* Run button */}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!selectedType}
            className={[
              'w-full rounded-xl py-3 px-4 text-sm font-semibold transition-all',
              selectedType
                ? 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer'
                : 'bg-white/5 text-slate-600 cursor-not-allowed',
            ].join(' ')}
          >
            {selectedType && activeConfig
              ? `${runLabel} — ${lang === 'da' ? activeConfig.titleDa : activeConfig.titleEn}`
              : runLabel}
          </button>
        </div>
      )}

      {/* ── Phase: streaming / done ── */}
      {(phase === 'streaming' || phase === 'done') && selectedEntity && (
        <div className="max-w-3xl space-y-4">
          {/* Header bar */}
          <div className="flex items-center gap-3">
            {isStreaming ? (
              <Loader2 size={16} className="text-blue-400 animate-spin shrink-0" />
            ) : activeConfig ? (
              <div
                className={[
                  'w-7 h-7 rounded-lg flex items-center justify-center shrink-0',
                  activeConfig.iconBg,
                ].join(' ')}
              >
                <activeConfig.icon size={14} className={activeConfig.iconColor} />
              </div>
            ) : null}
            <div className="min-w-0">
              <span className="text-sm font-semibold text-white">
                {isStreaming
                  ? analysisLabel
                  : `${activeConfig ? (lang === 'da' ? activeConfig.titleDa : activeConfig.titleEn) : ''}`}
              </span>
              {!isStreaming && (
                <span className="text-slate-500 font-normal text-sm"> — {resultLabel}</span>
              )}
              <div className="text-xs text-slate-500 truncate mt-0.5">{selectedEntity.title}</div>
            </div>
          </div>

          {/* Error panel */}
          {errorMessage && (
            <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
              <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
              <div className="flex-1 space-y-2">
                <p className="text-sm text-red-300">
                  {errorLabel}: {errorMessage}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setPhase('ready');
                    setErrorMessage('');
                    setResultText('');
                    setStatusMessages([]);
                  }}
                  className="text-xs text-red-400 hover:text-red-300 underline underline-offset-2"
                >
                  {tryAgainLabel}
                </button>
              </div>
            </div>
          )}

          {/* Result panel */}
          {(resultText || isStreaming) && !errorMessage && (
            <div className="bg-white/5 border border-white/8 rounded-2xl p-6 overflow-y-auto max-h-[70vh]">
              <MarkdownResult
                text={resultText}
                streaming={isStreaming}
                statusMessages={statusMessages}
              />
              <div ref={resultBottomRef} />
            </div>
          )}

          {/* Streaming-only: collecting data placeholder */}
          {isStreaming && !resultText && !errorMessage && (
            <div className="bg-white/5 border border-white/8 rounded-2xl p-6">
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <Loader2 size={14} className="animate-spin text-blue-400 shrink-0" />
                <span>
                  {statusMessages[statusMessages.length - 1] ??
                    (lang === 'da' ? 'Henter data fra registre…' : 'Fetching data from registers…')}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Building2 icon for empty entity placeholder (cosmetic) */}
      {phase === 'search' && !query && (
        <div className="max-w-xl">
          <div className="rounded-2xl border border-white/5 bg-white/3 p-8 flex flex-col items-center gap-3 text-center">
            <div className="w-12 h-12 rounded-2xl bg-blue-500/10 flex items-center justify-center">
              <Building2 size={22} className="text-blue-400" />
            </div>
            <div>
              <div className="text-sm font-medium text-slate-300">
                {lang === 'da'
                  ? 'AI-drevet analyse med rigtige data'
                  : 'AI-powered analysis with real data'}
              </div>
              <div className="text-xs text-slate-500 mt-1 max-w-xs">
                {lang === 'da'
                  ? 'Henter automatisk CVR, regnskaber, BBR, vurdering, ejerskab og meget mere fra offentlige registre.'
                  : 'Automatically fetches CVR, financials, BBR, valuations, ownership and more from public registers.'}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
