'use client';

/**
 * AI Analyse-side — BIZZ-342 redesign med foruddefinerede analyseområder.
 *
 * Flow:
 *  1. Bruger ser et gitter med 6 analyseområde-kort og klikker på ét
 *  2. Et simpelt formular vises: fritekst-mål (CVR/BFE/område) + valgfri søgning
 *  3. "Kør analyse" → streaming resultat via /api/analysis/run
 *
 * Nye analysetyper (BIZZ-342):
 *  - virksomhed   — regnskab, ejerskab, risikoprofil
 *  - ejendom      — vurdering vs. markedspris, skatteoptimering
 *  - ejerskab     — koncernstruktur, ultimativ ejer, krydsejerskab
 *  - omraade      — ejendomspriser, virksomhedstæthed
 *  - due_diligence — samlet rapport for opkøb/investering
 *  - portefolje   — overblik over ejendomme/virksomheder for én ejer
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Building2,
  HomeIcon,
  Network,
  MapPin,
  ClipboardCheck,
  LayoutGrid,
  Search,
  X,
  ArrowLeft,
  Loader2,
  AlertCircle,
  RefreshCw,
  ChevronRight,
  Briefcase,
  User,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import type { UnifiedSearchResult } from '@/app/api/search/route';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Supported analysis type identifiers.
 * Must match the z.enum in /api/analysis/run/route.ts.
 */
type AnalysisType =
  | 'virksomhed'
  | 'ejendom'
  | 'ejerskab'
  | 'omraade'
  | 'due_diligence'
  | 'portefolje';

/** Entity type passed to the API — 'area' is used for free-text area targets */
type EntityType = 'company' | 'address' | 'person' | 'area';

/** Entity resolved either from search or from manual text input */
interface SelectedEntity {
  id: string;
  title: string;
  subtitle: string;
  type: EntityType;
  meta?: Record<string, string>;
}

/** Static configuration for a single analysis area card */
interface AreaConfig {
  id: AnalysisType;
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
  /** Which input mode the target form should use for this area */
  inputMode: 'cvr' | 'bfe_or_address' | 'area' | 'portfolio';
}

// ─── Analysis area definitions ────────────────────────────────────────────────

/** All six analysis area configurations */
const AREAS: AreaConfig[] = [
  {
    id: 'virksomhed',
    icon: Building2,
    iconColor: 'text-blue-400',
    iconBg: 'bg-blue-500/10',
    inputMode: 'cvr',
  },
  {
    id: 'ejendom',
    icon: HomeIcon,
    iconColor: 'text-emerald-400',
    iconBg: 'bg-emerald-500/10',
    inputMode: 'bfe_or_address',
  },
  {
    id: 'ejerskab',
    icon: Network,
    iconColor: 'text-violet-400',
    iconBg: 'bg-violet-500/10',
    inputMode: 'cvr',
  },
  {
    id: 'omraade',
    icon: MapPin,
    iconColor: 'text-amber-400',
    iconBg: 'bg-amber-500/10',
    inputMode: 'area',
  },
  {
    id: 'due_diligence',
    icon: ClipboardCheck,
    iconColor: 'text-rose-400',
    iconBg: 'bg-rose-500/10',
    inputMode: 'cvr',
  },
  {
    id: 'portefolje',
    icon: LayoutGrid,
    iconColor: 'text-cyan-400',
    iconBg: 'bg-cyan-500/10',
    inputMode: 'portfolio',
  },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * Icon for a unified search result based on its entity type.
 *
 * @param type - 'address' | 'company' | 'person'
 */
function ResultTypeIcon({ type }: { type: 'address' | 'company' | 'person' }) {
  if (type === 'company') return <Briefcase size={14} className="text-blue-400" />;
  if (type === 'address') return <MapPin size={14} className="text-emerald-400" />;
  return <User size={14} className="text-purple-400" />;
}

/** Props for the AnalysisAreaCard component */
interface AreaCardProps {
  config: AreaConfig;
  title: string;
  desc: string;
  onClick: () => void;
}

/**
 * Clickable card representing one predefined analysis area.
 * Opens the target form when clicked.
 *
 * @param props - AreaCardProps
 */
function AnalysisAreaCard({ config, title, desc, onClick }: AreaCardProps) {
  const Icon = config.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'group w-full text-left rounded-2xl border border-white/8 bg-white/5',
        'p-5 transition-all duration-150',
        'hover:border-white/20 hover:bg-white/8',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60',
      ].join(' ')}
    >
      <div className="flex items-start gap-4">
        {/* Icon */}
        <div
          className={[
            'w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-transform',
            'group-hover:scale-105',
            config.iconBg,
          ].join(' ')}
        >
          <Icon size={18} className={config.iconColor} />
        </div>

        {/* Text */}
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-white text-sm">{title}</div>
          <div className="text-slate-400 text-xs mt-1 leading-snug">{desc}</div>
        </div>

        {/* Arrow */}
        <ChevronRight
          size={15}
          className="text-slate-600 group-hover:text-slate-400 shrink-0 mt-0.5 transition-colors"
        />
      </div>
    </button>
  );
}

/** Props for the MarkdownResult panel */
interface MarkdownResultProps {
  text: string;
  streaming: boolean;
  statusMessages: string[];
}

/**
 * Renders streamed markdown output as structured HTML.
 * Shows the latest tool-status message while streaming.
 *
 * @param props - MarkdownResultProps
 */
function MarkdownResult({ text, streaming, statusMessages }: MarkdownResultProps) {
  const lines = text.split('\n');
  const lastStatus = statusMessages[statusMessages.length - 1];

  return (
    <div className="space-y-3">
      {streaming && lastStatus && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 size={12} className="animate-spin text-blue-400 shrink-0" />
          <span>{lastStatus}</span>
        </div>
      )}

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
 * @returns React nodes with bold/italic spans applied
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
 * AI Analyse page client component — BIZZ-342 redesign.
 *
 * State machine:
 *  'grid'       → 6 analysis-area cards displayed
 *  'form'       → target input form for selected area
 *  'streaming'  → analysis running, shows tool-status + streaming text
 *  'done'       → analysis complete
 */
export default function AnalysisPageClient() {
  const { lang } = useLanguage();

  /** Selected analysis area config */
  const [selectedArea, setSelectedArea] = useState<AreaConfig | null>(null);

  /** Free-text target value (CVR, BFE, area name, etc.) */
  const [targetValue, setTargetValue] = useState('');

  /** Entity resolved from search (overrides targetValue when set) */
  const [selectedEntity, setSelectedEntity] = useState<SelectedEntity | null>(null);

  /** Search input query for the optional entity search */
  const [searchQuery, setSearchQuery] = useState('');
  /** Autocomplete search results */
  const [searchResults, setSearchResults] = useState<UnifiedSearchResult[]>([]);
  /** True while fetching search results */
  const [searchLoading, setSearchLoading] = useState(false);
  /** True when the search dropdown should be visible */
  const [dropdownOpen, setDropdownOpen] = useState(false);

  /** Current page phase */
  const [phase, setPhase] = useState<'grid' | 'form' | 'streaming' | 'done'>('grid');
  /** Accumulated streamed markdown text */
  const [resultText, setResultText] = useState('');
  /** Tool-status messages received during streaming */
  const [statusMessages, setStatusMessages] = useState<string[]>([]);
  /** Error message to display */
  const [errorMessage, setErrorMessage] = useState('');

  const abortRef = useRef<AbortController | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultBottomRef = useRef<HTMLDivElement>(null);
  const targetInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // ── Translations ────────────────────────────────────────────────────────────

  /** Look up a string from the analysisPage translation bucket */
  const t = useCallback(
    (key: string): string => {
      // Access nested keys via dot notation — walk the translations object at runtime
      // using a pre-built map to keep this type-safe without dynamic indexing.
      const map: Record<string, Record<string, string>> = {
        da: {
          title: 'AI Analyse',
          subtitle: 'Vælg en analysetype og angiv et CVR-nummer, BFE-nummer eller område',
          chooseArea: 'Vælg analyseområde',
          backToAreas: 'Tilbage til analysetyper',
          targetLabel: 'Hvad vil du analysere?',
          targetPlaceholder: 'CVR-nummer, BFE-nummer eller adresse…',
          targetPlaceholderArea: 'By, postnummer eller område…',
          targetPlaceholderPortfolio: 'CVR-nummer eller navn på ejer…',
          orSearch: 'Eller søg:',
          searchPlaceholder: 'Søg virksomhed, adresse eller CVR…',
          runAnalysis: 'Kør analyse',
          runningAnalysis: 'Analyserer…',
          newAnalysis: 'Ny analyse',
          result: 'Analyseresultat',
          errorOccurred: 'Der opstod en fejl',
          tryAgain: 'Prøv igen',
          fetchingData: 'Henter data fra registre…',
          entitySelected: 'Valgt entitet',
          clearEntity: 'Fjern valgt entitet',
          emptyHint: 'AI-drevet analyse med rigtige data fra offentlige registre',
          emptyHintSub:
            'Henter automatisk CVR, regnskaber, BBR, vurdering, ejerskab og meget mere.',
        },
        en: {
          title: 'AI Analysis',
          subtitle: 'Choose an analysis type and specify a CVR number, BFE number or area',
          chooseArea: 'Choose analysis area',
          backToAreas: 'Back to analysis types',
          targetLabel: 'What do you want to analyse?',
          targetPlaceholder: 'CVR number, BFE number or address…',
          targetPlaceholderArea: 'City, postcode or area…',
          targetPlaceholderPortfolio: 'CVR number or owner name…',
          orSearch: 'Or search:',
          searchPlaceholder: 'Search company, address or CVR…',
          runAnalysis: 'Run analysis',
          runningAnalysis: 'Analysing…',
          newAnalysis: 'New analysis',
          result: 'Analysis result',
          errorOccurred: 'An error occurred',
          tryAgain: 'Try again',
          fetchingData: 'Fetching data from registers…',
          entitySelected: 'Selected entity',
          clearEntity: 'Remove selected entity',
          emptyHint: 'AI-powered analysis with real data from public registers',
          emptyHintSub:
            'Automatically fetches CVR, financials, BBR, valuations, ownership and more.',
        },
      };
      return map[lang]?.[key] ?? key;
    },
    [lang]
  );

  /**
   * Returns the translated title and description for an analysis area.
   *
   * @param id - Analysis type identifier
   * @returns { title, desc } strings for the current language
   */
  const areaLabel = useCallback(
    (id: AnalysisType): { title: string; desc: string } => {
      const labels: Record<AnalysisType, { da: [string, string]; en: [string, string] }> = {
        virksomhed: {
          da: ['Virksomhedsanalyse', 'Regnskab, ejerskab og risikoprofil'],
          en: ['Company Analysis', 'Financials, ownership and risk profile'],
        },
        ejendom: {
          da: ['Ejendomsanalyse', 'Vurdering vs. markedspris, skatteoptimering'],
          en: ['Property Analysis', 'Valuation vs. market price, tax optimisation'],
        },
        ejerskab: {
          da: ['Ejerskabsanalyse', 'Koncernstruktur, ultimativ ejer, krydsejerskab'],
          en: ['Ownership Analysis', 'Group structure, ultimate owner, cross-ownership'],
        },
        omraade: {
          da: ['Områdeanalyse', 'Ejendomspriser og virksomhedstæthed'],
          en: ['Area Analysis', 'Property prices and business density'],
        },
        due_diligence: {
          da: ['Due Diligence', 'Samlet rapport til opkøb eller investering'],
          en: ['Due Diligence', 'Full report for acquisition or investment'],
        },
        portefolje: {
          da: ['Porteføljeanalyse', 'Overblik over ejendomme og virksomheder for én ejer'],
          en: ['Portfolio Analysis', 'Overview of properties and companies for one owner'],
        },
      };
      const [title, desc] = labels[id][lang] ?? labels[id].da;
      return { title, desc };
    },
    [lang]
  );

  // ── Search debounce ─────────────────────────────────────────────────────────

  /**
   * Debounced handler for the optional entity search input.
   * Waits 300 ms after last keystroke before fetching from /api/search.
   *
   * @param value - Current search input value
   */
  const handleSearchQueryChange = useCallback((value: string) => {
    setSearchQuery(value);

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

  /** Close the search dropdown when clicking outside of it */
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

  // ── Area and form navigation ────────────────────────────────────────────────

  /**
   * Select an analysis area card and navigate to the form phase.
   *
   * @param config - The area config that was clicked
   */
  const handleSelectArea = useCallback((config: AreaConfig) => {
    setSelectedArea(config);
    setTargetValue('');
    setSelectedEntity(null);
    setSearchQuery('');
    setSearchResults([]);
    setDropdownOpen(false);
    setResultText('');
    setErrorMessage('');
    setStatusMessages([]);
    setPhase('form');
    // Focus the target input after the DOM update
    setTimeout(() => targetInputRef.current?.focus(), 50);
  }, []);

  /**
   * Navigate back from the form to the area grid.
   * Cancels any in-flight requests.
   */
  const handleBack = useCallback(() => {
    abortRef.current?.abort();
    setPhase('grid');
    setSelectedArea(null);
    setTargetValue('');
    setSelectedEntity(null);
    setSearchQuery('');
    setSearchResults([]);
    setDropdownOpen(false);
    setResultText('');
    setErrorMessage('');
    setStatusMessages([]);
  }, []);

  /**
   * Handle selection of a search result from the optional entity search dropdown.
   * Populates the target input with the result title and stores the entity.
   *
   * @param result - Unified search result the user clicked
   */
  const handleSelectSearchResult = useCallback((result: UnifiedSearchResult) => {
    setSelectedEntity({
      id: result.id,
      title: result.title,
      subtitle: result.subtitle,
      type: result.type as EntityType,
      meta: result.meta as Record<string, string> | undefined,
    });
    setTargetValue(result.title);
    setSearchQuery('');
    setSearchResults([]);
    setDropdownOpen(false);
  }, []);

  // ── Analysis submission ─────────────────────────────────────────────────────

  /**
   * Resolve the entity to submit to the API.
   * If the user selected an entity from search, use it.
   * Otherwise, construct a synthetic entity from the free-text target value.
   *
   * @returns SelectedEntity ready for the API, or null if no target is set
   */
  const resolveEntity = useCallback((): SelectedEntity | null => {
    if (selectedEntity) return selectedEntity;
    if (!selectedArea || !targetValue.trim()) return null;

    // Determine entity type based on input mode
    const typeMap: Record<AreaConfig['inputMode'], EntityType> = {
      cvr: 'company',
      bfe_or_address: 'address',
      area: 'area',
      portfolio: 'company',
    };

    return {
      id: targetValue.trim(),
      title: targetValue.trim(),
      subtitle: '',
      type: typeMap[selectedArea.inputMode],
    };
  }, [selectedEntity, selectedArea, targetValue]);

  /**
   * Submit the analysis request.
   * Opens an SSE stream from /api/analysis/run and accumulates chunks into resultText.
   */
  const handleSubmit = useCallback(async () => {
    const entity = resolveEntity();
    if (!entity || !selectedArea) return;

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
        body: JSON.stringify({ type: selectedArea.id, entity }),
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
  }, [resolveEntity, selectedArea]);

  /**
   * Reset the entire page back to the area grid, aborting any in-flight request.
   */
  const handleReset = useCallback(() => {
    abortRef.current?.abort();
    setPhase('grid');
    setSelectedArea(null);
    setTargetValue('');
    setSelectedEntity(null);
    setSearchQuery('');
    setSearchResults([]);
    setDropdownOpen(false);
    setResultText('');
    setErrorMessage('');
    setStatusMessages([]);
  }, []);

  // ── Derived values ──────────────────────────────────────────────────────────

  const isStreaming = phase === 'streaming';

  /** Returns true if the submit button should be enabled */
  const canSubmit = !!selectedArea && (!!selectedEntity || targetValue.trim().length > 0);

  /**
   * Returns the appropriate placeholder for the target input
   * based on the selected area's input mode.
   */
  const targetPlaceholder = useCallback((): string => {
    if (!selectedArea) return t('targetPlaceholder');
    if (selectedArea.inputMode === 'area') return t('targetPlaceholderArea');
    if (selectedArea.inputMode === 'portfolio') return t('targetPlaceholderPortfolio');
    return t('targetPlaceholder');
  }, [selectedArea, t]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('title')}</h1>
          {phase === 'grid' && <p className="text-sm text-slate-500 mt-1">{t('subtitle')}</p>}
        </div>
        {(phase === 'streaming' || phase === 'done') && (
          <button
            type="button"
            onClick={handleReset}
            aria-label={t('newAnalysis')}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors"
          >
            <RefreshCw size={13} />
            {t('newAnalysis')}
          </button>
        )}
      </div>

      {/* ── Phase: grid ── */}
      {phase === 'grid' && (
        <div className="space-y-4 max-w-3xl">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">
            {t('chooseArea')}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {AREAS.map((config) => {
              const { title, desc } = areaLabel(config.id);
              return (
                <AnalysisAreaCard
                  key={config.id}
                  config={config}
                  title={title}
                  desc={desc}
                  onClick={() => handleSelectArea(config)}
                />
              );
            })}
          </div>

          {/* Decorative empty-state hint below the grid */}
          <div className="mt-6 rounded-2xl border border-white/5 bg-white/3 p-6 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center shrink-0">
              <Building2 size={18} className="text-blue-400" />
            </div>
            <div>
              <div className="text-sm font-medium text-slate-300">{t('emptyHint')}</div>
              <div className="text-xs text-slate-500 mt-1">{t('emptyHintSub')}</div>
            </div>
          </div>
        </div>
      )}

      {/* ── Phase: form ── */}
      {phase === 'form' && selectedArea && (
        <div className="max-w-xl space-y-6">
          {/* Back button */}
          <button
            type="button"
            onClick={handleBack}
            className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors -mt-2"
          >
            <ArrowLeft size={15} />
            {t('backToAreas')}
          </button>

          {/* Selected area heading */}
          <div className="flex items-center gap-3">
            <div
              className={[
                'w-10 h-10 rounded-xl flex items-center justify-center shrink-0',
                selectedArea.iconBg,
              ].join(' ')}
            >
              <selectedArea.icon size={18} className={selectedArea.iconColor} />
            </div>
            <div>
              <div className="text-base font-semibold text-white">
                {areaLabel(selectedArea.id).title}
              </div>
              <div className="text-xs text-slate-400">{areaLabel(selectedArea.id).desc}</div>
            </div>
          </div>

          {/* Target input */}
          <div className="space-y-2">
            <label
              htmlFor="analysis-target"
              className="block text-xs font-medium text-slate-400 uppercase tracking-wider"
            >
              {t('targetLabel')}
            </label>

            {/* Show entity chip if an entity was resolved from search */}
            {selectedEntity ? (
              <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
                <ResultTypeIcon type={selectedEntity.type as 'address' | 'company' | 'person'} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-white truncate">
                    {selectedEntity.title}
                  </div>
                  {selectedEntity.subtitle && (
                    <div className="text-xs text-slate-500 truncate">{selectedEntity.subtitle}</div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedEntity(null);
                    setTargetValue('');
                    setTimeout(() => targetInputRef.current?.focus(), 50);
                  }}
                  aria-label={t('clearEntity')}
                  className="text-slate-500 hover:text-white transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <input
                id="analysis-target"
                ref={targetInputRef}
                type="text"
                value={targetValue}
                onChange={(e) => setTargetValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && canSubmit && handleSubmit()}
                placeholder={targetPlaceholder()}
                className={[
                  'w-full rounded-xl border border-white/10 bg-white/5',
                  'px-4 py-3 text-sm text-slate-200 placeholder:text-slate-600',
                  'focus:border-blue-500/60 focus:outline-none focus:ring-1 focus:ring-blue-500/30',
                  'transition-colors',
                ].join(' ')}
              />
            )}
          </div>

          {/* Optional entity search (only for non-area modes) */}
          {selectedArea.inputMode !== 'area' && !selectedEntity && (
            <div className="space-y-2">
              <p className="text-xs text-slate-500">{t('orSearch')}</p>
              <div className="relative">
                <div className="relative flex items-center">
                  {searchLoading ? (
                    <Loader2
                      size={15}
                      className="absolute left-3.5 text-slate-400 animate-spin pointer-events-none"
                    />
                  ) : (
                    <Search
                      size={15}
                      className="absolute left-3.5 text-slate-500 pointer-events-none"
                    />
                  )}
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => handleSearchQueryChange(e.target.value)}
                    onFocus={() => searchResults.length > 0 && setDropdownOpen(true)}
                    placeholder={t('searchPlaceholder')}
                    className={[
                      'w-full rounded-xl border border-white/10 bg-white/5',
                      'pl-10 pr-4 py-2.5 text-sm text-slate-200 placeholder:text-slate-600',
                      'focus:border-blue-500/60 focus:outline-none focus:ring-1 focus:ring-blue-500/30',
                      'transition-colors',
                    ].join(' ')}
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => handleSearchQueryChange('')}
                      aria-label={lang === 'da' ? 'Ryd søgning' : 'Clear search'}
                      className="absolute right-3.5 text-slate-500 hover:text-white transition-colors"
                    >
                      <X size={13} />
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
                        onClick={() => handleSelectSearchResult(result)}
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
                        <ChevronRight size={13} className="text-slate-600 shrink-0" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Submit button */}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={[
              'w-full rounded-xl py-3 px-4 text-sm font-semibold transition-all',
              canSubmit
                ? 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer'
                : 'bg-white/5 text-slate-600 cursor-not-allowed',
            ].join(' ')}
          >
            {t('runAnalysis')} — {areaLabel(selectedArea.id).title}
          </button>
        </div>
      )}

      {/* ── Phase: streaming / done ── */}
      {(phase === 'streaming' || phase === 'done') && selectedArea && (
        <div className="max-w-3xl space-y-4">
          {/* Header bar */}
          <div className="flex items-center gap-3">
            {isStreaming ? (
              <Loader2 size={16} className="text-blue-400 animate-spin shrink-0" />
            ) : (
              <div
                className={[
                  'w-7 h-7 rounded-lg flex items-center justify-center shrink-0',
                  selectedArea.iconBg,
                ].join(' ')}
              >
                <selectedArea.icon size={14} className={selectedArea.iconColor} />
              </div>
            )}
            <div className="min-w-0">
              <span className="text-sm font-semibold text-white">
                {isStreaming ? t('runningAnalysis') : areaLabel(selectedArea.id).title}
              </span>
              {!isStreaming && (
                <span className="text-slate-500 font-normal text-sm"> — {t('result')}</span>
              )}
              <div className="text-xs text-slate-500 truncate mt-0.5">
                {selectedEntity?.title ?? targetValue}
              </div>
            </div>
          </div>

          {/* Error panel */}
          {errorMessage && (
            <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
              <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
              <div className="flex-1 space-y-2">
                <p className="text-sm text-red-300">
                  {t('errorOccurred')}: {errorMessage}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setPhase('form');
                    setErrorMessage('');
                    setResultText('');
                    setStatusMessages([]);
                  }}
                  className="text-xs text-red-400 hover:text-red-300 underline underline-offset-2"
                >
                  {t('tryAgain')}
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

          {/* Streaming placeholder while no text yet */}
          {isStreaming && !resultText && !errorMessage && (
            <div className="bg-white/5 border border-white/8 rounded-2xl p-6">
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <Loader2 size={14} className="animate-spin text-blue-400 shrink-0" />
                <span>{statusMessages[statusMessages.length - 1] ?? t('fetchingData')}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
