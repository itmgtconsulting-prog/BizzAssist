/**
 * GenerateFinanceReportModal — AI-genereret finansieringsrapport (BIZZ-1557).
 *
 * Viser modal eller inline-panel med tone-vælger (realkredit/bankrådgiver/memo),
 * streamer Claude-output via /api/ai/generate-finance-report SSE-endpoint,
 * kopiér-knap og AI-disclaimer.
 *
 * BIZZ-1589: Tilføjet `mode='panel'` variant så komponenten kan inline-renderes
 * fra analyse-modulet (uden modal-overlay). 'modal' (default) bevares for
 * ejendoms-detalje-sider hvor der ER en "basis skærm" der skal være bagved.
 *
 * Følger samme mønster som GenerateListingModal (BIZZ-1179).
 *
 * @module app/components/ejendomme/GenerateFinanceReportModal
 */

'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { X, Copy, Check, Sparkles, RefreshCw, Landmark } from 'lucide-react';
import TokenUsageBar from '@/app/components/TokenUsageBar';

/** Rapport-tone */
type FinanceTone = 'realkredit' | 'bankraadgiver' | 'memo';

interface Props {
  /** BFE-nummer for ejendommen */
  bfe: number;
  /** Fuld adressestreng */
  adresse: string;
  /** Sprog (kun da i denne version) */
  lang: 'da' | 'en';
  /** Styrer synlighed (kun relevant for mode='modal') */
  open: boolean;
  /** Callback ved lukning (kun relevant for mode='modal') */
  onClose: () => void;
  /**
   * BIZZ-1589: Visnings-mode. 'modal' (default) viser fixed-overlay dialog;
   * 'panel' inline-renderer indholdet uden overlay og uden luk-knap.
   */
  mode?: 'modal' | 'panel';
}

/** Tone-labels */
const TONE_LABELS: Record<FinanceTone, { da: string; en: string; emoji: string }> = {
  realkredit: { da: 'Realkredit', en: 'Mortgage credit', emoji: '🏦' },
  bankraadgiver: { da: 'Bankrådgiver', en: 'Bank advisor', emoji: '💼' },
  memo: { da: 'Internt memo', en: 'Internal memo', emoji: '📋' },
};

/**
 * Modal-komponent. Bruger SSE til at streame AI-genereret rapport.
 *
 * @param props - bfe, adresse, lang, open, onClose
 * @returns React-element eller null
 */
export default function GenerateFinanceReportModal(props: Props): React.ReactElement | null {
  const { bfe, adresse, lang, open, onClose, mode = 'modal' } = props;
  const [tone, setTone] = useState<FinanceTone>('realkredit');
  const [output, setOutput] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const da = lang === 'da';
  const isPanel = mode === 'panel';

  /** Annullér aktiv stream ved lukning (kun modal-mode). */
  useEffect(() => {
    if (isPanel) return;
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [open, isPanel]);

  /** Generér rapport via SSE-stream */
  const generate = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setOutput('');
    setCopied(false);

    try {
      const res = await fetch('/api/ai/generate-finance-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bfe, adresse, tone }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? `Server fejl (HTTP ${res.status})`);
        setLoading(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setError(da ? 'Stream-fejl' : 'Stream error');
        setLoading(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const data = line.replace(/^data:\s*/, '');
          if (data === '[DONE]') {
            setLoading(false);
            return;
          }
          try {
            const obj = JSON.parse(data) as { t?: string; error?: string };
            if (obj.error) {
              setError(obj.error);
              setLoading(false);
              return;
            }
            if (obj.t) setOutput((prev) => prev + obj.t);
          } catch {
            /* skip invalid */
          }
        }
      }
      setLoading(false);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Netværksfejl');
      setLoading(false);
    }
  }, [bfe, adresse, tone, da]);

  /** Kopiér output til clipboard */
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }, [output]);

  if (!isPanel && !open) return null;

  // BIZZ-1589: Indre indhold er identisk mellem modal og panel.
  const inner = (
    <div
      className={
        isPanel
          ? 'bg-slate-900 border border-slate-700 rounded-xl w-full max-h-[80vh] flex flex-col'
          : 'bg-slate-900 border border-slate-700 rounded-xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl'
      }
    >
      {/* Header */}
      <div className="flex items-center justify-between p-5 border-b border-slate-700">
        <div className="flex items-center gap-3">
          <Landmark className="w-5 h-5 text-emerald-400" aria-hidden />
          <div>
            <h2 id="finance-report-title" className="text-lg font-semibold text-white">
              {da ? 'Teknisk ejendomsbeskrivelse' : 'Technical property description'}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">{adresse}</p>
          </div>
        </div>
        {!isPanel && (
          <button
            onClick={onClose}
            aria-label={da ? 'Luk' : 'Close'}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Tone-vælger + Generér-knap */}
      <div className="p-5 border-b border-slate-700 space-y-3">
        <div>
          <p className="text-xs font-medium text-slate-400 mb-2 uppercase tracking-wide">
            {da ? 'Tone' : 'Tone'}
          </p>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(TONE_LABELS) as FinanceTone[]).map((t) => (
              <button
                key={t}
                onClick={() => setTone(t)}
                disabled={loading}
                className={`px-3 py-2 rounded-lg text-sm border transition-colors flex items-center gap-2 ${
                  tone === t
                    ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-200'
                    : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <span>{TONE_LABELS[t].emoji}</span>
                <span>{da ? TONE_LABELS[t].da : TONE_LABELS[t].en}</span>
              </button>
            ))}
          </div>
        </div>
        {/* BIZZ-1614: Token-status ved generer-knap */}
        <TokenUsageBar className="mb-2" />
        <div className="flex gap-2">
          <button
            onClick={generate}
            disabled={loading}
            className="flex-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:cursor-not-allowed rounded-lg font-medium flex items-center justify-center gap-2 text-white transition-colors"
          >
            {loading ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" aria-hidden />
                {da ? 'Genererer…' : 'Generating…'}
              </>
            ) : output ? (
              <>
                <RefreshCw className="w-4 h-4" aria-hidden />
                {da ? 'Generer igen' : 'Regenerate'}
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" aria-hidden />
                {da ? 'Generer rapport' : 'Generate report'}
              </>
            )}
          </button>
          {output && (
            <button
              onClick={handleCopy}
              disabled={loading}
              className="px-3 py-2.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-sm flex items-center gap-2 text-slate-300 transition-colors"
              aria-label={copied ? (da ? 'Kopieret' : 'Copied') : da ? 'Kopiér' : 'Copy'}
            >
              {copied ? (
                <>
                  <Check className="w-4 h-4 text-emerald-400" aria-hidden />
                  {da ? 'Kopieret' : 'Copied'}
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4" aria-hidden />
                  {da ? 'Kopiér' : 'Copy'}
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Output / fejl */}
      <div className="flex-1 overflow-y-auto p-5">
        {error && (
          <div className="bg-red-950/30 border border-red-900 rounded-lg p-4 text-sm text-red-200">
            {error}
          </div>
        )}
        {!output && !error && !loading && (
          <div className="text-center text-slate-500 py-12">
            <Landmark className="w-12 h-12 mx-auto mb-3 text-slate-700" aria-hidden />
            <p className="text-sm">
              {da
                ? 'Vælg en tone og klik "Generer rapport" for at få en AI-genereret finansieringsbeskrivelse baseret på BBR, vurdering og tinglysning.'
                : 'Select a tone and click "Generate report" to get an AI-generated finance description based on BBR, valuation and registry data.'}
            </p>
          </div>
        )}
        {output && (
          <div className="prose prose-invert prose-sm max-w-none whitespace-pre-wrap font-mono text-slate-200 text-sm leading-relaxed">
            {output}
            {loading && <span className="inline-block w-2 h-4 bg-emerald-400 animate-pulse ml-1" />}
          </div>
        )}
      </div>

      {/* Disclaimer */}
      <div className="p-3 border-t border-slate-700 bg-slate-950/50">
        <p className="text-[10px] text-slate-500 text-center">
          {da
            ? 'AI-genereret indhold. Verificér altid mod kildedata. Erstatter ikke en valuar-vurdering.'
            : 'AI-generated content. Always verify against source data. Does not replace a professional valuation.'}
        </p>
      </div>
    </div>
  );

  if (isPanel) {
    return inner;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="finance-report-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {inner}
    </div>
  );
}
