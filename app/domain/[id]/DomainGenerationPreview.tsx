/**
 * DomainGenerationPreview — 3. fixed side-panel der åbner til venstre for
 * det eksisterende højre-panel når en AI-generation starter fra
 * workspace-chatten.
 *
 * BIZZ-803:
 *   * Polling mod GET /api/domain/:id/generation/:genId indtil
 *     status=completed|failed.
 *   * Viser download-link til den genererede .docx/.pdf.
 *   * Feedback-input → "iterate" ved at kalde generate-endpointet igen
 *     med samme template + sag + et udvidet prompt der inkluderer
 *     forrige output og brugerens rettelser.
 *   * "Gem på sagen" kopierer outputtet til domain_case_doc så den
 *     dukker op i sagens dokumenter.
 *
 * Parent ejer `generationId` og `onClose` — komponenten er "dumb" ift.
 * navigation.
 *
 * @module app/domain/[id]/DomainGenerationPreview
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import {
  FileText,
  X,
  Loader2,
  Download,
  CheckCircle2,
  RefreshCw,
  Paperclip,
  Sparkles,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

interface GenerationStatus {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  output_path: string | null;
  error_message: string | null;
  template_id: string;
  case_id: string;
  claude_tokens: number;
  completed_at: string | null;
}

interface Props {
  domainId: string;
  generationId: string;
  /** Width in px — published via CSS var by parent so main content reserves room. */
  widthPx: number;
  /** Left offset — keeps preview flush with the right AI panel's left edge. */
  rightOffsetPx: number;
  /** Top offset — dashboard topbar clearance. */
  topOffsetPx: number;
  /** When user submits feedback, parent calls generate again and swaps the id. */
  onIterate: (feedback: string, previousGenerationId: string) => void;
  onClose: () => void;
}

/**
 * Renders the generation preview panel. Polls every 2s until the
 * generation reaches a terminal state.
 */
export function DomainGenerationPreview({
  domainId,
  generationId,
  widthPx,
  rightOffsetPx,
  topOffsetPx,
  onIterate,
  onClose,
}: Props) {
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [gen, setGen] = useState<GenerationStatus | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [attached, setAttached] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll generation status
  useEffect(() => {
    setGen(null);
    setPreviewText(null);
    setAttached(false);
    setAttachError(null);

    const fetchStatus = async () => {
      try {
        const r = await fetch(`/api/domain/${domainId}/generation/${generationId}`);
        if (!r.ok) return;
        const json = (await r.json()) as GenerationStatus;
        setGen(json);
        if (json.status === 'completed' || json.status === 'failed') {
          if (pollTimer.current) clearInterval(pollTimer.current);
          pollTimer.current = null;
        }
      } catch {
        /* noop — polling retries */
      }
    };
    void fetchStatus();
    pollTimer.current = setInterval(fetchStatus, 2000);

    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = null;
    };
  }, [domainId, generationId]);

  // When completed, fetch a lightweight text preview of the generated doc
  useEffect(() => {
    if (!gen || gen.status !== 'completed' || !gen.output_path) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/domain/${domainId}/generation/${generationId}/preview`);
        if (!r.ok) return;
        const j = (await r.json()) as { text?: string };
        if (!cancelled && j.text) setPreviewText(j.text);
      } catch {
        /* preview is optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [domainId, generationId, gen]);

  const downloadHref = `/api/domain/${domainId}/generation/${generationId}/download`;

  const submitFeedback = () => {
    const text = feedback.trim();
    if (!text || !gen || gen.status !== 'completed') return;
    onIterate(text, generationId);
    setFeedback('');
  };

  const attachToCase = async () => {
    if (!gen || gen.status !== 'completed') return;
    setAttaching(true);
    setAttachError(null);
    try {
      const r = await fetch(`/api/domain/${domainId}/generation/${generationId}/attach-to-case`, {
        method: 'POST',
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({ error: 'Ukendt' }));
        setAttachError(j.error ?? (da ? 'Kunne ikke gemme' : 'Could not save'));
        return;
      }
      setAttached(true);
    } finally {
      setAttaching(false);
    }
  };

  const isRunning = !gen || gen.status === 'pending' || gen.status === 'running';
  const isFailed = gen?.status === 'failed';

  return (
    <div
      className="fixed bottom-0 z-30 bg-slate-950 border-l border-r border-slate-700/40 flex flex-col shadow-2xl"
      style={{
        top: `${topOffsetPx}px`,
        right: `${rightOffsetPx}px`,
        width: `${widthPx}px`,
      }}
    >
      <div className="px-3 py-2 border-b border-slate-700/40 bg-slate-900/50 flex items-center gap-2">
        <Sparkles size={13} className="text-amber-400" />
        <p className="text-xs font-semibold text-slate-300 flex-1">
          {da ? 'Genereret dokument' : 'Generated document'}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label={da ? 'Luk preview' : 'Close preview'}
          className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
        >
          <X size={12} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {isRunning && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Loader2 size={28} className="animate-spin text-amber-400 mb-3" />
            <p className="text-xs text-slate-400">
              {da ? 'AI genererer dokument…' : 'AI is generating…'}
            </p>
            <p className="text-[10px] text-slate-500 mt-1">
              {da ? 'Typisk 20-60 sekunder' : 'Usually 20-60 seconds'}
            </p>
          </div>
        )}

        {isFailed && (
          <div className="bg-rose-900/20 border border-rose-700/40 rounded-md p-3">
            <p className="text-xs font-semibold text-rose-300 mb-1">
              {da ? 'Generation fejlede' : 'Generation failed'}
            </p>
            <p className="text-[11px] text-rose-200 whitespace-pre-wrap">
              {gen?.error_message ?? (da ? 'Ukendt fejl' : 'Unknown error')}
            </p>
          </div>
        )}

        {gen?.status === 'completed' && (
          <>
            <div className="flex items-center gap-2">
              <FileText size={14} className="text-emerald-400" />
              <p className="text-xs font-semibold text-slate-200 flex-1 truncate">
                {gen.output_path?.split('/').pop() ?? 'output.docx'}
              </p>
              <a
                href={downloadHref}
                download
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-[10px]"
              >
                <Download size={10} />
                {da ? 'Hent' : 'Download'}
              </a>
            </div>

            {previewText ? (
              <div className="bg-slate-900/40 border border-slate-700/40 rounded-md p-3 max-h-96 overflow-y-auto">
                <p className="text-[11px] text-slate-300 whitespace-pre-wrap leading-relaxed">
                  {previewText}
                </p>
              </div>
            ) : (
              <p className="text-[11px] text-slate-500">
                {da
                  ? 'Preview kan ikke vises — brug download-knappen.'
                  : 'Preview unavailable — use the download button.'}
              </p>
            )}

            {/* BIZZ-803: feedback + iterate */}
            <div className="space-y-2 pt-1 border-t border-slate-800">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">
                {da ? 'Feedback til AI' : 'Feedback to AI'}
              </p>
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                rows={3}
                placeholder={
                  da
                    ? 'fx: "Fjern afsnit 3 og brug kundens fulde firmanavn i overskriften"'
                    : 'e.g. "Remove section 3 and use the customer\'s full company name in the title"'
                }
                className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs resize-y"
              />
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={attachToCase}
                  disabled={attaching || attached}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-600/30 hover:bg-emerald-600/50 disabled:opacity-50 border border-emerald-500/40 text-emerald-200 text-[11px] font-medium transition-colors"
                >
                  {attaching ? (
                    <Loader2 size={10} className="animate-spin" />
                  ) : (
                    <CheckCircle2 size={10} />
                  )}
                  {attached
                    ? da
                      ? 'Gemt på sagen ✓'
                      : 'Saved ✓'
                    : da
                      ? 'Godkend og gem'
                      : 'Approve and save'}
                </button>
                <button
                  type="button"
                  onClick={submitFeedback}
                  disabled={!feedback.trim()}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-[11px] font-medium"
                >
                  <RefreshCw size={10} />
                  {da ? 'Ny version' : 'New version'}
                </button>
              </div>
              {attachError && <p className="text-[10px] text-rose-300">{attachError}</p>}
              {attached && (
                <p className="text-[10px] text-emerald-300 flex items-center gap-1">
                  <Paperclip size={10} />
                  {da ? 'Tilgængeligt under sagens dokumenter' : 'Available under case documents'}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
