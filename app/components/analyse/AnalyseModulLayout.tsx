/**
 * AnalyseModulLayout — shared wizard-layout for alle analyse-moduler.
 *
 * BIZZ-1231: Viser target-vælger + "Kør analyse" knap. Bygger prompt
 * via analysePromptBuilder og sender til AI Chat panel.
 *
 * @param modul - Analyse-modul definition
 * @returns Wizard UI
 */

'use client';

import { useState, useCallback } from 'react';
import { Search, ChevronRight, Sparkles } from 'lucide-react';
import {
  buildAnalysePrompt,
  type AnalyseModul,
  type AnalyseTarget,
} from '@/app/lib/analysePromptBuilder';

interface Props {
  /** Analyse-modul definition */
  modul: AnalyseModul;
  /** Valgfrit ekstra indhold (fx fil-upload) der vises mellem target-vælger og knap */
  children?: React.ReactNode;
  /** Ekstra kontekst at inkludere i prompten (fx parsed fil-data) */
  ekstraKontekst?: string;
}

/**
 * Shared analyse-modul layout med target-vælger og AI Chat integration.
 *
 * @param props - Modul + optional children
 * @returns Layout JSX
 */
export default function AnalyseModulLayout({ modul, children, ekstraKontekst }: Props) {
  const [targetType, setTargetType] = useState<AnalyseTarget['type']>('virksomhed');
  const [targetId, setTargetId] = useState('');
  const [targetLabel, setTargetLabel] = useState('');
  const [loading, setLoading] = useState(false);

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

        {/* Type toggle */}
        <div className="flex gap-2">
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

        {/* ID + label inputs */}
        <div className="flex gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              placeholder={
                targetType === 'person'
                  ? 'EnhedsNummer'
                  : targetType === 'virksomhed'
                    ? 'CVR-nummer (8 cifre)'
                    : 'BFE-nummer'
              }
              className="w-full pl-9 pr-3 py-2.5 bg-slate-800 border border-slate-700/60 rounded-lg text-sm text-white outline-none focus:border-blue-500/60"
            />
          </div>
          <input
            type="text"
            value={targetLabel}
            onChange={(e) => setTargetLabel(e.target.value)}
            placeholder="Navn (valgfrit)"
            className="w-56 px-3 py-2.5 bg-slate-800 border border-slate-700/60 rounded-lg text-sm text-white outline-none focus:border-blue-500/60"
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
