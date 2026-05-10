/**
 * Boligannonce analyse-modul — AI-genereret annonce via Chat.
 *
 * BIZZ-1239: Erstatter den separate GenerateListingModal med et
 * analyse-modul der bruger AI Chat til generering. Brugeren vælger
 * ejendom (BFE) + tone, og prompten sendes til chatten.
 *
 * @returns Analyse UI med tone-vælger
 */

'use client';

import { useState, useCallback, useEffect } from 'react';
import { Search, ChevronRight, Sparkles, Clock, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import {
  buildAnalysePrompt,
  ANALYSE_MODULER,
  type AnalyseTarget,
} from '@/app/lib/analysePromptBuilder';

/** Tone-valg */
type Tone =
  | 'luksus'
  | 'familievenlig'
  | 'investor'
  | 'erhverv'
  | 'facebook'
  | 'instagram'
  | 'linkedin';

const TONER: Array<{ id: Tone; label: string; emoji: string }> = [
  { id: 'luksus', label: 'Luksus', emoji: '✨' },
  { id: 'familievenlig', label: 'Familievenlig', emoji: '🏡' },
  { id: 'investor', label: 'Investor', emoji: '📊' },
  { id: 'erhverv', label: 'Erhverv', emoji: '🏢' },
  { id: 'facebook', label: 'Facebook', emoji: '📘' },
  { id: 'instagram', label: 'Instagram', emoji: '📸' },
  { id: 'linkedin', label: 'LinkedIn', emoji: '💼' },
];

const modul = ANALYSE_MODULER.find((m) => m.id === 'annonce')!;

/**
 * Annonce analyse-modul.
 *
 * @returns Wizard UI med tone-vælger + BFE-input
 */
export default function AnnonceClient() {
  const [bfe, setBfe] = useState('');
  const [adresse, setAdresse] = useState('');
  const [tone, setTone] = useState<Tone>('familievenlig');
  const [loading, setLoading] = useState(false);
  const [recentEjendomme, setRecentEjendomme] = useState<
    Array<{ bfe: number; adresse: string; dawaId?: string }>
  >([]);

  /** Hent seneste besøgte ejendomme fra /api/recents */
  useEffect(() => {
    fetch('/api/recents?type=ejendom&limit=3')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.entities) {
          setRecentEjendomme(
            data.entities.map((e: { id: string; label: string; bfe?: number }) => ({
              bfe: e.bfe ?? 0,
              adresse: e.label,
              dawaId: e.id,
            }))
          );
        }
      })
      .catch(() => {});
  }, []);

  /**
   * Bygger prompt med tone og sender til AI Chat.
   */
  const koerAnalyse = useCallback(() => {
    if (!bfe) return;
    setLoading(true);

    const target: AnalyseTarget = {
      type: 'ejendom',
      id: bfe,
      label: adresse || `BFE ${bfe}`,
    };

    const toneLabel = TONER.find((t) => t.id === tone)?.label ?? tone;
    const ekstra = `Tone: ${toneLabel}. Skriv annoncen i "${toneLabel}" tone.`;

    const prompt = buildAnalysePrompt(modul, target, ekstra);
    window.dispatchEvent(new CustomEvent('bizz:ai-open-with-prompt', { detail: { prompt } }));

    setTimeout(() => setLoading(false), 500);
  }, [bfe, adresse, tone]);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* BIZZ-1246: Tilbage-link */}
      <Link
        href="/dashboard/analyse"
        className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white text-sm transition-colors"
      >
        <ArrowLeft size={14} />
        Analyse
      </Link>

      {/* Header */}
      <div>
        <h1 className="text-white text-2xl font-bold flex items-center gap-2">
          <Sparkles size={24} className="text-emerald-400" />
          Boligannonce
        </h1>
        <p className="text-slate-400 text-sm mt-1">
          AI-genereret boligannonce med tone-vælger og BBR-data
        </p>
      </div>

      <div className="bg-slate-800/30 border border-slate-700/40 rounded-2xl p-6 space-y-4">
        <h2 className="text-white font-semibold text-sm">Vælg ejendom og tone</h2>

        {/* Foreslåede ejendomme (seneste besøgte) */}
        {recentEjendomme.length > 0 && !bfe && (
          <div>
            <p className="text-slate-400 text-xs mb-2 flex items-center gap-1">
              <Clock size={12} /> Seneste ejendomme:
            </p>
            <div className="flex gap-2 flex-wrap">
              {recentEjendomme.map((e) => (
                <button
                  key={e.bfe}
                  onClick={() => {
                    setBfe(String(e.bfe));
                    setAdresse(e.adresse);
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs bg-slate-800 text-slate-300 border border-slate-700/40 hover:border-blue-500/40 hover:text-blue-300 transition-all truncate max-w-[220px]"
                >
                  {e.adresse}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* BFE + adresse */}
        <div className="flex gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={bfe}
              onChange={(e) => setBfe(e.target.value)}
              placeholder="BFE-nummer (fx 2081243)"
              className="w-full pl-9 pr-3 py-2.5 bg-slate-800 border border-slate-700/60 rounded-lg text-sm text-white outline-none focus:border-blue-500/60"
            />
          </div>
          <input
            type="text"
            value={adresse}
            onChange={(e) => setAdresse(e.target.value)}
            placeholder="Adresse (valgfrit)"
            className="w-64 px-3 py-2.5 bg-slate-800 border border-slate-700/60 rounded-lg text-sm text-white outline-none focus:border-blue-500/60"
          />
        </div>

        {/* Tone-vælger */}
        <div>
          <p className="text-slate-400 text-xs mb-2">Annonce-tone:</p>
          <div className="flex gap-2 flex-wrap">
            {TONER.map((t) => (
              <button
                key={t.id}
                onClick={() => setTone(t.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                  tone === t.id
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    : 'bg-slate-800 text-slate-400 border border-slate-700/40 hover:text-slate-300'
                }`}
              >
                <span>{t.emoji}</span>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Kør */}
        <button
          onClick={koerAnalyse}
          disabled={!bfe || loading}
          className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
        >
          {loading ? 'Starter...' : 'Generér annonce'}
          <ChevronRight size={14} />
        </button>

        <p className="text-slate-600 text-[10px]">
          Annoncen genereres i AI Chat med BBR-data, vurdering og energimærke som kontekst.
        </p>
      </div>
    </div>
  );
}
