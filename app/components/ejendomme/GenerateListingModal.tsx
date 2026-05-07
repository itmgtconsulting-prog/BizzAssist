/**
 * GenerateListingModal — Modal til AI-drevet boligannonce-generering.
 *
 * BIZZ-1179: Viser en modal med tone-vælger, streaming-output, kopiér-knap
 * og AI-disclaimer. Bruger /api/ai/generate-listing SSE-endpoint.
 *
 * @param bfe      - BFE-nummer for ejendommen
 * @param adresse  - Fuld adressestreng
 * @param lang     - Sprog (da/en)
 * @param open     - Styrer synlighed
 * @param onClose  - Callback ved lukning
 */

'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { X, Copy, Check, Sparkles, RefreshCw } from 'lucide-react';

/** Tone-valg for annoncen */
type ListingTone = 'luksus' | 'familievenlig' | 'investor' | 'erhverv';

interface Props {
  /** BFE-nummer for ejendommen */
  bfe: number;
  /** Fuld adressestreng */
  adresse: string;
  /** Sprog */
  lang: 'da' | 'en';
  /** Styrer synlighed */
  open: boolean;
  /** Callback ved lukning */
  onClose: () => void;
  /** Postnummer — bruges til Boliga sammenlignelige salg (BIZZ-1180) */
  postnummer?: number;
  /** Boligareal i m² (BIZZ-1180) */
  areal?: number;
}

/** Tone-labels (da/en) */
const TONE_LABELS: Record<ListingTone, { da: string; en: string; emoji: string }> = {
  luksus: { da: 'Luksus', en: 'Luxury', emoji: '✨' },
  familievenlig: { da: 'Familievenlig', en: 'Family-friendly', emoji: '🏡' },
  investor: { da: 'Investor', en: 'Investor', emoji: '📊' },
  erhverv: { da: 'Erhverv', en: 'Commercial', emoji: '🏢' },
};

/**
 * GenerateListingModal — AI annoncegenerator.
 *
 * @param props - Se Props interface
 * @returns Modal dialog JSX
 */
export default function GenerateListingModal({
  bfe,
  adresse,
  lang,
  open,
  onClose,
  postnummer,
  areal,
}: Props) {
  const da = lang === 'da';
  const [tone, setTone] = useState<ListingTone>('familievenlig');
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  /** Ryd state ved lukning */
  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      setLoading(false);
    }
  }, [open]);

  /**
   * Starter SSE-stream til /api/ai/generate-listing.
   * Akkumulerer tekst-chunks i output-state.
   */
  const generate = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setOutput('');
    setError(null);
    setLoading(true);
    setCopied(false);

    try {
      const res = await fetch('/api/ai/generate-listing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bfe, adresse, tone, postnummer, areal }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? (da ? 'Fejl ved generering' : 'Generation failed'));
        setLoading(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setError(da ? 'Ingen stream modtaget' : 'No stream received');
        setLoading(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') continue;

          try {
            const parsed = JSON.parse(payload);
            if (parsed.t) {
              setOutput((prev) => prev + parsed.t);
            }
            if (parsed.error) {
              setError(parsed.error);
            }
          } catch {
            /* skip malformed chunks */
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(da ? 'Netværksfejl' : 'Network error');
      }
    } finally {
      setLoading(false);
    }
  }, [bfe, adresse, tone, da]);

  /**
   * Kopierer annoncetekst til clipboard.
   */
  const copyToClipboard = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }, [output]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="generate-listing-title"
    >
      <div className="bg-slate-900 border border-slate-700/60 rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700/40">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-emerald-500/20 border border-emerald-500/30 rounded-lg flex items-center justify-center">
              <Sparkles size={16} className="text-emerald-400" />
            </div>
            <h2 id="generate-listing-title" className="text-white font-semibold text-sm">
              {da ? 'AI Boligannonce' : 'AI Property Listing'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-slate-800"
            aria-label={da ? 'Luk' : 'Close'}
          >
            <X size={18} />
          </button>
        </div>

        {/* Tone-vælger */}
        <div className="px-5 py-3 border-b border-slate-700/40">
          <p className="text-slate-400 text-xs mb-2">
            {da ? 'Vælg tone for annoncen:' : 'Select listing tone:'}
          </p>
          <div className="flex gap-2 flex-wrap">
            {(Object.keys(TONE_LABELS) as ListingTone[]).map((t) => (
              <button
                key={t}
                onClick={() => setTone(t)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  tone === t
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    : 'bg-slate-800/60 text-slate-400 border border-slate-700/40 hover:border-slate-600/60 hover:text-slate-300'
                }`}
              >
                {TONE_LABELS[t].emoji} {da ? TONE_LABELS[t].da : TONE_LABELS[t].en}
              </button>
            ))}
          </div>
        </div>

        {/* Output / generér */}
        <div className="flex-1 overflow-y-auto px-5 py-4 min-h-[200px]">
          {!output && !loading && !error && (
            <div className="flex flex-col items-center justify-center h-full gap-3 py-8">
              <p className="text-slate-500 text-sm text-center max-w-xs">
                {da
                  ? `Generér en professionel boligannonce for ${adresse}`
                  : `Generate a professional listing for ${adresse}`}
              </p>
              <button
                onClick={generate}
                className="bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2 rounded-xl text-sm font-medium transition-colors flex items-center gap-2"
              >
                <Sparkles size={14} />
                {da ? 'Generér annonce' : 'Generate listing'}
              </button>
            </div>
          )}

          {loading && !output && (
            <div className="flex items-center justify-center h-full py-8">
              <div className="flex items-center gap-2 text-emerald-400 text-sm">
                <RefreshCw size={14} className="animate-spin" />
                {da ? 'Genererer annonce...' : 'Generating listing...'}
              </div>
            </div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-red-300 text-sm">
              {error}
            </div>
          )}

          {output && (
            <div
              ref={outputRef}
              className="prose prose-invert prose-sm max-w-none text-slate-200 leading-relaxed whitespace-pre-wrap"
            >
              {output}
              {loading && (
                <span className="inline-block w-1.5 h-4 bg-emerald-400 animate-pulse ml-0.5 align-text-bottom" />
              )}
            </div>
          )}
        </div>

        {/* Footer — kopiér + regenerér + disclaimer */}
        <div className="px-5 py-3 border-t border-slate-700/40 space-y-2">
          {output && !loading && (
            <div className="flex gap-2">
              <button
                onClick={copyToClipboard}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800/60 text-slate-300 border border-slate-700/40 hover:border-slate-600/60 hover:text-white transition-all"
              >
                {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                {copied ? (da ? 'Kopieret!' : 'Copied!') : da ? 'Kopiér tekst' : 'Copy text'}
              </button>
              <button
                onClick={generate}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800/60 text-slate-300 border border-slate-700/40 hover:border-slate-600/60 hover:text-white transition-all"
              >
                <RefreshCw size={13} />
                {da ? 'Generér ny' : 'Regenerate'}
              </button>
            </div>
          )}
          <p className="text-slate-600 text-[10px]">
            {da
              ? 'AI-genereret forslag — gennemgå og tilpas teksten før brug.'
              : 'AI-generated suggestion — review and adapt the text before use.'}
          </p>
        </div>
      </div>
    </div>
  );
}
