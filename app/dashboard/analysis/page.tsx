'use client';

/**
 * AI Analyse-side — strukturerede AI-drevne analysetyper.
 *
 * Tilbyder fire analysetyper som brugeren kan vælge imellem:
 *  1. Due Diligence  — Grundig gennemgang af virksomhed eller ejendom
 *  2. Konkurrentanalyse — Sammenligning af virksomheder i samme branche
 *  3. Investeringsscreening — Find ejendomme/virksomheder der matcher kriterier
 *  4. Markedsanalyse — Ejendomsmarked i et geografisk område
 *
 * Side-flow:
 *  1. Vis 4 analysetypekort (2x2 grid)
 *  2. Bruger klikker → formular til input for den valgte type
 *  3. Bruger sender → kalder /api/analysis/run med streaming SSE
 *  4. Viser streaming markdown output i resultpanel
 *  5. "Ny analyse" knap for at starte forfra
 */

import { useState, useRef, useCallback } from 'react';
import {
  ClipboardCheck,
  BarChart3,
  Target,
  TrendingUp,
  ArrowLeft,
  Loader2,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Union of all supported analysis type identifiers */
type AnalysisType = 'due_diligence' | 'konkurrent' | 'investering' | 'marked';

/** Input field definition for a given analysis type */
interface InputField {
  /** Field key used in the input record sent to the API */
  key: string;
  /** Human-readable label shown above the input */
  label: string;
  /** Placeholder text for the input element */
  placeholder: string;
  /** Whether the field spans multiple lines (textarea vs. input) */
  multiline?: boolean;
}

/** Configuration for a single analysis type card */
interface AnalysisTypeConfig {
  /** Unique identifier */
  id: AnalysisType;
  /** Display title (Danish) */
  titleDa: string;
  /** Display title (English) */
  titleEn: string;
  /** Short description (Danish) */
  descDa: string;
  /** Short description (English) */
  descEn: string;
  /** Tailwind colour classes for icon background and icon text */
  iconColor: string;
  iconBg: string;
  /** Lucide icon component */
  icon: React.ElementType;
  /** Form fields shown when this type is selected */
  fields: InputField[];
}

// ─── Analysis type definitions ────────────────────────────────────────────────

/** All four analysis type configurations */
const ANALYSIS_TYPES: AnalysisTypeConfig[] = [
  {
    id: 'due_diligence',
    titleDa: 'Due Diligence',
    titleEn: 'Due Diligence',
    descDa: 'Gennemgå en virksomhed eller ejendom grundigt',
    descEn: 'Thorough review of a company or property',
    icon: ClipboardCheck,
    iconColor: 'text-emerald-400',
    iconBg: 'bg-emerald-500/10',
    fields: [
      {
        key: 'CVR- eller BFE-nummer',
        label: 'CVR- eller BFE-nummer',
        placeholder: 'F.eks. 12345678 (CVR) eller 5708897 (BFE)',
      },
      {
        key: 'Virksomhed eller ejendom',
        label: 'Virksomhed / ejendom (valgfrit)',
        placeholder: 'F.eks. "Novo Nordisk A/S" eller "Vesterbrogade 10, København"',
      },
      {
        key: 'Fokusområder',
        label: 'Fokusområder (valgfrit)',
        placeholder: 'F.eks. "likviditet og ejerskabsstruktur"',
        multiline: true,
      },
    ],
  },
  {
    id: 'konkurrent',
    titleDa: 'Konkurrentanalyse',
    titleEn: 'Competitor Analysis',
    descDa: 'Sammenlign virksomheder i samme branche',
    descEn: 'Compare companies in the same industry',
    icon: BarChart3,
    iconColor: 'text-blue-400',
    iconBg: 'bg-blue-500/10',
    fields: [
      {
        key: 'CVR-nummer',
        label: 'CVR-nummer på din virksomhed',
        placeholder: 'F.eks. 12345678',
      },
      {
        key: 'Branche',
        label: 'Branche / industri',
        placeholder: 'F.eks. "softwareudvikling", "byggeri", "detailhandel"',
      },
      {
        key: 'Geografisk fokus',
        label: 'Geografisk fokus (valgfrit)',
        placeholder: 'F.eks. "Danmark", "Aarhus", "Skandinavien"',
      },
      {
        key: 'Konkurrenter',
        label: 'Kendte konkurrenter (valgfrit)',
        placeholder: 'F.eks. CVR eller navne på konkurrenter',
        multiline: true,
      },
    ],
  },
  {
    id: 'investering',
    titleDa: 'Investeringsscreening',
    titleEn: 'Investment Screening',
    descDa: 'Find ejendomme eller virksomheder der matcher kriterier',
    descEn: 'Find properties or companies matching your criteria',
    icon: Target,
    iconColor: 'text-purple-400',
    iconBg: 'bg-purple-500/10',
    fields: [
      {
        key: 'Søgekriterier',
        label: 'Beskriv hvad du søger',
        placeholder:
          'F.eks. "industribygninger i Aarhus under 10 mio." eller "profitable IT-virksomheder i Jylland"',
        multiline: true,
      },
      {
        key: 'Budget',
        label: 'Budget / prisinterval (valgfrit)',
        placeholder: 'F.eks. "5-15 mio. DKK"',
      },
      {
        key: 'Tidsperspektiv',
        label: 'Investeringshorisont (valgfrit)',
        placeholder: 'F.eks. "5 år", "langsigtet", "kortsigtet flip"',
      },
    ],
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
    fields: [
      {
        key: 'Kommune eller postnummer',
        label: 'Kommune eller postnummer',
        placeholder: 'F.eks. "Aarhus Kommune" eller "8000"',
      },
      {
        key: 'Ejendomstype',
        label: 'Ejendomstype (valgfrit)',
        placeholder: 'F.eks. "erhverv", "bolig", "industri", "alle"',
      },
      {
        key: 'Specifikt fokus',
        label: 'Specifikt fokus (valgfrit)',
        placeholder: 'F.eks. "prisudvikling de seneste 5 år", "udlejningspotentiale"',
        multiline: true,
      },
    ],
  },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Props for the AnalysisTypeCard component */
interface AnalysisTypeCardProps {
  /** Analysis type configuration */
  config: AnalysisTypeConfig;
  /** Whether this card is currently selected */
  selected: boolean;
  /** Language for bilingual display */
  lang: 'da' | 'en';
  /** Click handler */
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
        'w-full text-left rounded-2xl border p-5 transition-all duration-150',
        'bg-white/5 hover:bg-white/8',
        selected
          ? 'border-blue-500 ring-1 ring-blue-500/40'
          : 'border-white/8 hover:border-blue-500/40',
      ].join(' ')}
    >
      <div className="flex items-start gap-4">
        <div
          className={[
            'w-11 h-11 rounded-xl flex items-center justify-center shrink-0',
            config.iconBg,
          ].join(' ')}
        >
          <Icon size={20} className={config.iconColor} />
        </div>
        <div className="min-w-0">
          <div className="font-semibold text-white text-sm">{title}</div>
          <div className="text-slate-400 text-xs mt-1 leading-snug">{desc}</div>
        </div>
      </div>
    </button>
  );
}

/** Props for a single form field row */
interface FormFieldProps {
  field: InputField;
  value: string;
  onChange: (value: string) => void;
}

/**
 * Renders a labelled input or textarea for an analysis form field.
 *
 * @param props - FormFieldProps
 */
function FormField({ field, value, onChange }: FormFieldProps) {
  const id = `field-${field.key.replace(/\s+/g, '-').toLowerCase()}`;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-300">
        {field.label}
      </label>
      {field.multiline ? (
        <textarea
          id={id}
          rows={3}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className={[
            'w-full rounded-xl border border-white/10 bg-white/5',
            'px-4 py-3 text-sm text-slate-200 placeholder:text-slate-600',
            'focus:border-blue-500/60 focus:outline-none focus:ring-1 focus:ring-blue-500/30',
            'resize-none transition-colors',
          ].join(' ')}
        />
      ) : (
        <input
          id={id}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className={[
            'w-full rounded-xl border border-white/10 bg-white/5',
            'px-4 py-3 text-sm text-slate-200 placeholder:text-slate-600',
            'focus:border-blue-500/60 focus:outline-none focus:ring-1 focus:ring-blue-500/30',
            'transition-colors',
          ].join(' ')}
        />
      )}
    </div>
  );
}

/** Props for the MarkdownResult display panel */
interface MarkdownResultProps {
  /** Raw markdown text streamed from the API */
  text: string;
  /** Whether streaming is still in progress */
  streaming: boolean;
}

/**
 * Renders streamed markdown output as structured HTML.
 * Uses simple line-by-line parsing: ## headings, ** bold, bullet lists.
 * Avoids dangerouslySetInnerHTML — all rendering is done in React.
 *
 * @param props - MarkdownResultProps
 */
function MarkdownResult({ text, streaming }: MarkdownResultProps) {
  const lines = text.split('\n');

  return (
    <div className="prose prose-invert prose-sm max-w-none space-y-2">
      {lines.map((line, i) => {
        // ## Heading 2
        if (line.startsWith('## ')) {
          return (
            <h2
              key={i}
              className="text-base font-bold text-white mt-6 mb-2 first:mt-0 border-b border-white/10 pb-1"
            >
              {line.slice(3)}
            </h2>
          );
        }
        // ### Heading 3
        if (line.startsWith('### ')) {
          return (
            <h3 key={i} className="text-sm font-semibold text-slate-200 mt-4 mb-1">
              {line.slice(4)}
            </h3>
          );
        }
        // # Heading 1
        if (line.startsWith('# ')) {
          return (
            <h1 key={i} className="text-lg font-bold text-white mt-4 mb-2">
              {line.slice(2)}
            </h1>
          );
        }
        // Bullet list items
        if (line.startsWith('- ') || line.startsWith('* ')) {
          return (
            <div key={i} className="flex gap-2 text-slate-300 text-sm leading-relaxed">
              <span className="text-blue-400 mt-1 shrink-0">•</span>
              <span>{renderInline(line.slice(2))}</span>
            </div>
          );
        }
        // Numbered list
        if (/^\d+\.\s/.test(line)) {
          const match = line.match(/^(\d+)\.\s(.*)$/);
          if (match) {
            return (
              <div key={i} className="flex gap-2 text-slate-300 text-sm leading-relaxed">
                <span className="text-blue-400 shrink-0 tabular-nums">{match[1]}.</span>
                <span>{renderInline(match[2])}</span>
              </div>
            );
          }
        }
        // Horizontal rule
        if (line.trim() === '---' || line.trim() === '***') {
          return <hr key={i} className="border-white/10 my-4" />;
        }
        // Empty line → spacer
        if (line.trim() === '') {
          return <div key={i} className="h-2" />;
        }
        // Normal paragraph
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
  );
}

/**
 * Renders inline markdown formatting within a text segment.
 * Supports **bold** and *italic* syntax.
 * Returns an array of React elements interleaved with plain strings.
 *
 * @param text - Raw text segment potentially containing inline markdown
 * @returns React node array suitable for rendering inside a paragraph
 */
function renderInline(text: string): React.ReactNode {
  // Split on **bold** and *italic* markers
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={i} className="text-white font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return (
        <em key={i} className="text-slate-200 italic">
          {part.slice(1, -1)}
        </em>
      );
    }
    return part;
  });
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * AI Analyse-side med fire strukturerede analysetyper.
 *
 * State machine:
 *  'select'    → viser 2x2 grid af analysetypekort
 *  'form'      → viser inputformular for den valgte type
 *  'streaming' → viser streaming markdown-resultat
 *  'done'      → viser færdigt resultat med "Ny analyse" knap
 */
export default function AnalysisPage() {
  const { lang } = useLanguage();

  /** Currently selected analysis type (null = none selected) */
  const [selectedType, setSelectedType] = useState<AnalysisType | null>(null);
  /** Page phase — drives which UI is shown */
  const [phase, setPhase] = useState<'select' | 'form' | 'streaming' | 'done'>('select');
  /** Form field values indexed by field key */
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  /** Streamed result text accumulated from SSE chunks */
  const [resultText, setResultText] = useState('');
  /** Error message shown in the result panel */
  const [errorMessage, setErrorMessage] = useState('');

  /** AbortController for the current fetch — allows cancellation */
  const abortRef = useRef<AbortController | null>(null);
  /** Scroll anchor for the result panel */
  const resultBottomRef = useRef<HTMLDivElement>(null);

  /** Derive the config for the currently selected type */
  const activeConfig = ANALYSIS_TYPES.find((t) => t.id === selectedType) ?? null;

  /**
   * Handle analysis type card selection.
   * Resets field values when switching to a new type.
   *
   * @param type - The analysis type that was clicked
   */
  const handleSelectType = useCallback((type: AnalysisType) => {
    setSelectedType(type);
    setFieldValues({});
    setPhase('form');
  }, []);

  /** Navigate back to the type selection grid */
  const handleBack = useCallback(() => {
    abortRef.current?.abort();
    setPhase('select');
    setSelectedType(null);
    setResultText('');
    setErrorMessage('');
  }, []);

  /** Reset everything and start a new analysis */
  const handleReset = useCallback(() => {
    abortRef.current?.abort();
    setPhase('select');
    setSelectedType(null);
    setFieldValues({});
    setResultText('');
    setErrorMessage('');
  }, []);

  /**
   * Submit the analysis form and initiate streaming.
   * Reads the SSE stream from /api/analysis/run and accumulates chunks
   * into resultText as they arrive.
   */
  const handleSubmit = useCallback(async () => {
    if (!selectedType || !activeConfig) return;

    // Require at least one non-empty field
    const hasInput = Object.values(fieldValues).some((v) => v.trim().length > 0);
    if (!hasInput) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setResultText('');
    setErrorMessage('');
    setPhase('streaming');

    try {
      const res = await fetch('/api/analysis/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: selectedType, input: fieldValues }),
        signal: AbortSignal.timeout(60000),
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
            const parsed = JSON.parse(dataLine) as { t?: string; error?: string };
            if (parsed.error) {
              setErrorMessage(parsed.error);
            } else if (parsed.t) {
              setResultText((prev) => prev + parsed.t);
              // Scroll to bottom of result as new content arrives
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
  }, [selectedType, activeConfig, fieldValues]);

  /**
   * Update a single form field's value.
   *
   * @param key   - Field key from InputField.key
   * @param value - New string value from the input element
   */
  const handleFieldChange = useCallback((key: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const isStreaming = phase === 'streaming';

  // ── Page title strings ──────────────────────────────────────────────────────
  const pageTitle = lang === 'da' ? 'AI Analyse' : 'AI Analysis';
  const pageSubtitle =
    lang === 'da'
      ? 'Vælg en analysetype for at komme i gang'
      : 'Choose an analysis type to get started';
  const backLabel = lang === 'da' ? 'Tilbage' : 'Back';
  const submitLabel = lang === 'da' ? 'Kør analyse' : 'Run analysis';
  const newAnalysisLabel = lang === 'da' ? 'Ny analyse' : 'New analysis';
  const loadingLabel = lang === 'da' ? 'Analyserer…' : 'Analysing…';
  const resultLabel = lang === 'da' ? 'Analyseresultat' : 'Analysis result';
  const errorLabel = lang === 'da' ? 'Der opstod en fejl' : 'An error occurred';
  const tryAgainLabel = lang === 'da' ? 'Prøv igen' : 'Try again';
  const inputRequiredLabel =
    lang === 'da' ? 'Udfyld mindst ét felt for at køre analysen.' : 'Fill in at least one field.';

  const hasInput = Object.values(fieldValues).some((v) => v.trim().length > 0);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-white">{pageTitle}</h1>
        {phase === 'select' && <p className="text-slate-400 mt-1">{pageSubtitle}</p>}
      </div>

      {/* ── Phase: select ── */}
      {phase === 'select' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl">
          {ANALYSIS_TYPES.map((config) => (
            <AnalysisTypeCard
              key={config.id}
              config={config}
              selected={selectedType === config.id}
              lang={lang}
              onClick={() => handleSelectType(config.id)}
            />
          ))}
        </div>
      )}

      {/* ── Phase: form ── */}
      {phase === 'form' && activeConfig && (
        <div className="max-w-xl space-y-6">
          {/* Back button + selected type header */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleBack}
              aria-label={backLabel}
              className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors"
            >
              <ArrowLeft size={16} />
              {backLabel}
            </button>
            <span className="text-slate-600">·</span>
            <span className="text-sm font-semibold text-white">
              {lang === 'da' ? activeConfig.titleDa : activeConfig.titleEn}
            </span>
          </div>

          {/* Form card */}
          <div className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-5">
            {activeConfig.fields.map((field) => (
              <FormField
                key={field.key}
                field={field}
                value={fieldValues[field.key] ?? ''}
                onChange={(v) => handleFieldChange(field.key, v)}
              />
            ))}

            {!hasInput && <p className="text-xs text-slate-500 italic">{inputRequiredLabel}</p>}

            <button
              type="button"
              onClick={handleSubmit}
              disabled={!hasInput}
              className={[
                'w-full rounded-xl py-3 px-4 text-sm font-semibold transition-all',
                hasInput
                  ? 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer'
                  : 'bg-white/5 text-slate-600 cursor-not-allowed',
              ].join(' ')}
            >
              {submitLabel}
            </button>
          </div>
        </div>
      )}

      {/* ── Phase: streaming / done ── */}
      {(phase === 'streaming' || phase === 'done') && activeConfig && (
        <div className="max-w-3xl space-y-4">
          {/* Header bar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {phase === 'streaming' ? (
                <Loader2 size={16} className="text-blue-400 animate-spin" />
              ) : (
                <div
                  className={[
                    'w-7 h-7 rounded-lg flex items-center justify-center',
                    activeConfig.iconBg,
                  ].join(' ')}
                >
                  <activeConfig.icon size={14} className={activeConfig.iconColor} />
                </div>
              )}
              <span className="text-sm font-semibold text-white">
                {phase === 'streaming'
                  ? loadingLabel
                  : lang === 'da'
                    ? activeConfig.titleDa
                    : activeConfig.titleEn}{' '}
                {phase !== 'streaming' && (
                  <span className="text-slate-500 font-normal">— {resultLabel}</span>
                )}
              </span>
            </div>

            <button
              type="button"
              onClick={handleReset}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors"
            >
              <RefreshCw size={13} />
              {newAnalysisLabel}
            </button>
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
                    setPhase('form');
                    setErrorMessage('');
                  }}
                  className="text-xs text-red-400 hover:text-red-300 underline underline-offset-2"
                >
                  {tryAgainLabel}
                </button>
              </div>
            </div>
          )}

          {/* Result text panel */}
          {(resultText || isStreaming) && (
            <div className="bg-white/5 border border-white/8 rounded-2xl p-6 overflow-y-auto max-h-[70vh]">
              <MarkdownResult text={resultText} streaming={isStreaming} />
              <div ref={resultBottomRef} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
