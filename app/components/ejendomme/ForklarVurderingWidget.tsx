/**
 * ForklarVurderingWidget — AI-drevet forklaring af ejendomsvurdering.
 *
 * BIZZ-946: Viser en "Forklar min vurdering" knap der sender vurderingsdata
 * til Claude og streamer en letforståelig forklaring i klart dansk.
 *
 * @param vurdering - Officiel vurdering
 * @param forelobig - Nyeste foreløbig vurdering
 * @param adresse - Ejendommens adresse
 * @param lang - 'da' | 'en'
 */

'use client';

import { useState, useCallback, useRef } from 'react';
import { Sparkles, Loader2, X } from 'lucide-react';
import type { VurderingData } from '@/app/api/vurdering/route';
import type { ForelobigVurdering } from '@/app/api/vurdering-forelobig/route';

interface Props {
  /** Officiel vurdering */
  vurdering: VurderingData | null;
  /** Nyeste foreløbig vurdering */
  forelobig: ForelobigVurdering | null;
  /** Ejendommens adresse */
  adresse: string;
  /** Kommune */
  kommune: string | null;
  /** Boligareal i m² */
  boligareal: number | null;
  /** Grundareal i m² */
  grundareal: number | null;
  /** Opførelsesår */
  opfoerelsesaar: number | null;
  /** Sprogvalg */
  lang: 'da' | 'en';
}

export default function ForklarVurderingWidget({
  vurdering,
  forelobig,
  adresse,
  kommune,
  boligareal,
  grundareal,
  opfoerelsesaar,
  lang,
}: Props) {
  const da = lang === 'da';
  const [forklaring, setForklaring] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Henter AI-forklaring via /api/ai/forklar-vurdering.
   */
  const hentForklaring = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    setForklaring('');

    abortRef.current = new AbortController();

    try {
      const res = await fetch('/api/ai/forklar-vurdering', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adresse,
          ejendomsvaerdi: vurdering?.ejendomsvaerdi ?? null,
          grundvaerdi: vurdering?.grundvaerdi ?? null,
          vurderingsaar: vurdering?.aar ?? null,
          forelobigEjendomsvaerdi: forelobig?.ejendomsvaerdi ?? null,
          forelobigGrundvaerdi: forelobig?.grundvaerdi ?? null,
          forelobigGrundskyld: forelobig?.grundskyld ?? null,
          forelobigEjendomsvaerdiskat: forelobig?.ejendomsskat ?? null,
          forelobigTotalSkat: forelobig?.totalSkat ?? null,
          forelobigAar: forelobig?.vurderingsaar ?? null,
          boligareal,
          grundareal,
          opfoerelsesaar,
          kommune,
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: 'Ukendt fejl' }));
        setError((errBody as { error?: string }).error ?? `HTTP ${res.status}`);
        setLoading(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setError('Kunne ikke læse svar');
        setLoading(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let text = '';

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
            if (parsed.error) setError(parsed.error);
            if (parsed.t) {
              text += parsed.t;
              setForklaring(text);
            }
          } catch {
            /* Ignorér ugyldigt JSON */
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(da ? 'Netværksfejl — prøv igen' : 'Network error — try again');
      }
    } finally {
      setLoading(false);
    }
  }, [loading, adresse, vurdering, forelobig, boligareal, grundareal, opfoerelsesaar, kommune, da]);

  /* Intet at forklare hvis der hverken er vurdering eller foreløbig */
  if (!vurdering && !forelobig) return null;

  /* Vis kun knappen hvis forklaringen ikke er hentet endnu */
  if (!forklaring && !loading && !error) {
    return (
      <button
        type="button"
        onClick={hentForklaring}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-blue-600/20 to-purple-600/20 border border-blue-500/30 rounded-xl text-sm font-medium text-blue-300 hover:from-blue-600/30 hover:to-purple-600/30 hover:border-blue-500/50 transition-all"
      >
        <Sparkles size={16} />
        {da ? 'Forklar min vurdering med AI' : 'Explain my valuation with AI'}
      </button>
    );
  }

  return (
    <div className="bg-slate-800/30 border border-blue-500/20 rounded-xl p-4 relative">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-blue-400" />
          <span className="text-xs font-medium text-blue-300 uppercase tracking-wider">
            {da ? 'AI Forklaring' : 'AI Explanation'}
          </span>
        </div>
        {forklaring && !loading && (
          <button
            type="button"
            onClick={() => {
              setForklaring(null);
              setError(null);
            }}
            className="text-slate-600 hover:text-slate-400 transition-colors"
            aria-label={da ? 'Luk forklaring' : 'Close explanation'}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Loading */}
      {loading && !forklaring && (
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2 size={14} className="animate-spin text-blue-400" />
          {da ? 'Genererer forklaring…' : 'Generating explanation…'}
        </div>
      )}

      {/* Error */}
      {error && <p className="text-red-400 text-sm">{error}</p>}

      {/* Forklaring */}
      {forklaring && (
        <div className="text-slate-300 text-sm leading-relaxed whitespace-pre-line">
          {forklaring}
          {loading && (
            <span className="inline-block w-1.5 h-4 bg-blue-400 animate-pulse ml-0.5 align-text-bottom" />
          )}
        </div>
      )}

      {/* Disclaimer */}
      {forklaring && !loading && (
        <p className="text-slate-600 text-[10px] mt-3 border-t border-slate-700/30 pt-2">
          {da
            ? '⚠ AI-genereret forklaring — verificér altid vigtig information.'
            : '⚠ AI-generated explanation — always verify important information.'}
        </p>
      )}
    </div>
  );
}
