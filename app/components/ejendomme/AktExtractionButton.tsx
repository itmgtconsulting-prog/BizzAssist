/**
 * AktExtractionButton — AI-ekstraktion af scannede tinglysningsakter.
 *
 * BIZZ-1597: Vises ved salgshistorik i Økonomi-tabben. Bruger betaler
 * med AI-tokens. Data beriger fælles ejerskifte_historik.
 *
 * @module app/components/ejendomme/AktExtractionButton
 */

'use client';

import { useState } from 'react';
import { Sparkles } from 'lucide-react';

interface Props {
  /** BFE-nummer for ejendommen. */
  bfe: number;
  /** Akt-filnavn fra EjendomStamoplysningerHent. */
  aktNavn: string;
  /** Sprogkode. */
  lang: string;
}

/**
 * Knap til AI-ekstraktion af scannede akter.
 *
 * @param props - BFE, aktNavn, sprog
 * @returns Knap med loading-state og resultat-visning
 */
export default function AktExtractionButton({ bfe, aktNavn, lang }: Props) {
  const da = lang === 'da';
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    handler: number;
    haeftelser: number;
    servitutter: number;
    tokensUsed: number;
    fromCache: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const extract = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/tinglysning/extract-akt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bfe, aktNavn }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Fejl' }));
        setError(err.error || `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setResult({
        handler: data.handler?.length ?? 0,
        haeftelser: data.haeftelser?.length ?? 0,
        servitutter: data.servitutter?.length ?? 0,
        tokensUsed: data.tokensUsed ?? 0,
        fromCache: data.fromCache ?? false,
      });
    } catch {
      setError(da ? 'Netværksfejl' : 'Network error');
    } finally {
      setLoading(false);
    }
  };

  if (result) {
    return (
      <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4 mt-3">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="w-4 h-4 text-emerald-400" aria-hidden />
          <span className="text-white font-semibold text-sm">
            {da ? 'AI-ekstraktion fuldført' : 'AI extraction complete'}
          </span>
          {result.fromCache && (
            <span className="text-[10px] text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">
              cached
            </span>
          )}
        </div>
        <p className="text-emerald-300 text-xs">
          {da
            ? `Fandt ${result.handler} handler, ${result.haeftelser} hæftelser og ${result.servitutter} servitutter fra scannet akt.`
            : `Found ${result.handler} transactions, ${result.haeftelser} mortgages and ${result.servitutter} easements.`}
          {result.tokensUsed > 0 && !result.fromCache && (
            <span className="text-slate-500 ml-1">
              ({result.tokensUsed.toLocaleString()} tokens)
            </span>
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3">
      <button
        onClick={extract}
        disabled={loading}
        className="flex items-center gap-2 px-3 py-2 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-emerald-300 text-sm rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? (
          <>
            <div className="w-4 h-4 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
            {da ? 'Analyserer scannet akt med AI...' : 'Analyzing scanned deed with AI...'}
          </>
        ) : (
          <>
            <Sparkles className="w-4 h-4" aria-hidden />
            {da
              ? 'Berig med historisk data fra scannet akt'
              : 'Enrich with historical data from scanned deed'}
            <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-emerald-500/20 text-emerald-300 leading-none">
              AI
            </span>
          </>
        )}
      </button>
      {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
    </div>
  );
}
