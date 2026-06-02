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

import { useState, useCallback, useEffect, useRef } from 'react';
import { Search, ChevronRight, Sparkles, Clock, ArrowLeft, MapPin, Loader2 } from 'lucide-react';
import Link from 'next/link';
import type { UnifiedSearchResult } from '@/app/api/search/route';
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

/** Output-format valg */
type OutputFormat = 'chat' | 'docx' | 'pdf';

const OUTPUT_FORMATS: Array<{ id: OutputFormat; label: string }> = [
  { id: 'chat', label: 'Vis i chat' },
  { id: 'docx', label: 'Word (.docx)' },
  { id: 'pdf', label: 'PDF' },
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
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('chat');
  const [loading, setLoading] = useState(false);
  const [recentEjendomme, setRecentEjendomme] = useState<
    Array<{ bfe: number; adresse: string; dawaId?: string }>
  >([]);

  /** Autocomplete søge-state */
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UnifiedSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

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
   * Debounced autocomplete-søgning mod /api/search filtreret til adresser.
   */
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 2) {
      setSearchResults([]);
      setDropdownOpen(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(value.trim())}`);
        if (res.ok) {
          const data: UnifiedSearchResult[] = await res.json();
          const addressResults = data.filter((r) => r.type === 'address');
          setSearchResults(addressResults);
          setDropdownOpen(addressResults.length > 0);
        }
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
  }, []);

  /**
   * Vælg en adresse fra autocomplete — auto-udfyld BFE + adresse.
   *
   * @param result - Valgt søgeresultat
   */
  const selectAddress = useCallback((result: UnifiedSearchResult) => {
    setBfe(result.id);
    setAdresse(result.title);
    setSearchQuery(result.title);
    setDropdownOpen(false);
    setSearchResults([]);
  }, []);

  /** Luk dropdown ved klik udenfor */
  useEffect(() => {
    /** @param e - Mouse event */
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
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

    // Byg prompt med output-format som PRIMÆR instruktion (ikke ekstra kontekst)
    let outputInstruktion = '';
    if (outputFormat === 'docx' || outputFormat === 'pdf') {
      outputInstruktion = `

VIGTIGT — WORD-DOKUMENT ER PÅKRÆVET:
Når annoncen er skrevet og vist i chatten, SKAL du derefter kalde generate_document tool med:
- format: "docx"
- mode: "scratch"
- title: "${adresse} — Boligannonce"
- scratch: { sections: [{ heading: adressen, body: annonceteksten }, { heading: "Ejendomsdata", body: BBR-data som tekst }, { heading: "Disclaimer", body: "Oplysningerne er hentet fra BBR og offentlige registre." }] }
Du SKAL kalde generate_document — brugeren har eksplicit bedt om Word-output.`;
    }

    const prompt = buildAnalysePrompt(modul, target, ekstra + outputInstruktion);
    // BIZZ-1260: Kort brugervenlig tekst i chat-boblen
    const displayText = `Boligannonce — ${adresse} (${tone})`;
    window.dispatchEvent(
      new CustomEvent('bizz:ai-open-with-prompt', { detail: { prompt, displayText } })
    );

    setTimeout(() => setLoading(false), 500);
  }, [bfe, adresse, tone, outputFormat]);

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

        {/* BIZZ-1250: Autocomplete ejendomssøgning */}
        <div className="relative" ref={dropdownRef}>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              onFocus={() => {
                if (searchResults.length > 0) setDropdownOpen(true);
              }}
              placeholder="Søg på adresse, vejnavn eller postnummer..."
              className="w-full pl-9 pr-10 py-2.5 bg-slate-800 border border-slate-700/60 rounded-lg text-sm text-white outline-none focus:border-blue-500/60"
            />
            {searchLoading && (
              <Loader2
                size={14}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-400 animate-spin"
              />
            )}
          </div>
          {dropdownOpen && searchResults.length > 0 && (
            <div className="absolute z-50 w-full mt-1 bg-slate-800 border border-slate-700/60 rounded-lg shadow-xl max-h-64 overflow-y-auto">
              {searchResults.map((result) => (
                <button
                  key={result.id}
                  type="button"
                  onClick={() => selectAddress(result)}
                  className="w-full text-left px-3 py-2.5 hover:bg-slate-700/50 transition-colors flex items-start gap-3 border-b border-slate-700/30 last:border-b-0"
                >
                  <MapPin size={14} className="text-emerald-400 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-white truncate">{result.title}</div>
                    <div className="text-xs text-slate-400 truncate">{result.subtitle}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Valgt ejendom indikator */}
        {bfe && (
          <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
            <MapPin size={12} />
            <span className="font-medium">{adresse || `BFE ${bfe}`}</span>
            <button
              type="button"
              onClick={() => {
                setBfe('');
                setAdresse('');
                setSearchQuery('');
              }}
              className="ml-auto text-slate-400 hover:text-white"
              aria-label="Ryd valg"
            >
              &times;
            </button>
          </div>
        )}

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

        {/* Output-format vælger */}
        <div>
          <p className="text-slate-400 text-xs mb-2">Output-format:</p>
          <div className="flex gap-2 flex-wrap">
            {OUTPUT_FORMATS.map((f) => (
              <button
                key={f.id}
                onClick={() => setOutputFormat(f.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  outputFormat === f.id
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    : 'bg-slate-800 text-slate-400 border border-slate-700/40 hover:text-slate-300'
                }`}
              >
                {f.label}
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

        <p className="text-slate-400 text-[10px]">
          Annoncen genereres i AI Chat med BBR-data, vurdering og energimærke som kontekst.
        </p>
      </div>
    </div>
  );
}
