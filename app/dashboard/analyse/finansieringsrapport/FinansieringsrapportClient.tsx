/**
 * Finansieringsrapport analyse-modul (BIZZ-1557).
 *
 * AI-genereret teknisk ejendomsbeskrivelse til bank/realkredit.
 * Søg en ejendom og åbn modal med tone-vælger + Claude SSE-streaming output.
 *
 * @returns Wizard UI med ejendoms-søgning + finansieringsrapport modal
 */

'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Search, Landmark, ArrowLeft, MapPin, Loader2, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import type { UnifiedSearchResult } from '@/app/api/search/route';
import GenerateFinanceReportModal from '@/app/components/ejendomme/GenerateFinanceReportModal';

/** Valgt ejendom til rapport-generering */
interface SelectedProperty {
  bfe: number;
  adresse: string;
}

/**
 * Finansieringsrapport analyse-modul.
 *
 * BIZZ-1589: Rapporten vises nu inline under input-formen (panel mode)
 * i stedet for modal-popup. Layout udnytter full content-width.
 */
export default function FinansieringsrapportClient(): React.ReactElement {
  const [selected, setSelected] = useState<SelectedProperty | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UnifiedSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  /** Debounced søgning via /api/search */
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!searchQuery || searchQuery.length < 2) {
      setSearchResults([]);
      setDropdownOpen(false);
      return;
    }
    setSearchLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`);
        if (res.ok) {
          // /api/search returnerer array af UnifiedSearchResult direkte (ikke wrapper)
          const data = (await res.json()) as
            | UnifiedSearchResult[]
            | { results?: UnifiedSearchResult[] };
          const list = Array.isArray(data) ? data : (data.results ?? []);
          // Filter til kun addresser
          setSearchResults(list.filter((r) => r.type === 'address'));
          setDropdownOpen(true);
        }
      } catch {
        /* ignore */
      } finally {
        setSearchLoading(false);
      }
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery]);

  /** Klik udenfor dropdown lukker den */
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  /** Vælg ejendom fra søgeresultat — resolver BFE via /api/ejendom/<dawaId> */
  const handleSelect = useCallback(async (result: UnifiedSearchResult) => {
    if (result.type !== 'address') return;
    setSearchQuery('');
    setSearchResults([]);
    setDropdownOpen(false);

    // Hent BFE via DAWA UUID — /api/ejendom/{id} returnerer ejendomsrelationer
    try {
      const res = await fetch(`/api/ejendom/${result.id}`);
      if (res.ok) {
        const data = await res.json();
        const bfe = data?.ejendomsrelationer?.[0]?.bfeNummer;
        if (bfe) {
          setSelected({
            bfe: Number(bfe),
            adresse: result.title,
          });
        }
      }
    } catch {
      /* swallow — TODO: vis fejl */
    }
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* BIZZ-1605: fuld bredde — max-w fjernet */}
      <main className="w-full px-6 py-8 mx-auto">
        {/* Tilbage-link */}
        <Link
          href="/dashboard/analyse"
          className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200 mb-4 transition-colors"
        >
          <ArrowLeft size={14} /> Tilbage til Analyse & Tools
        </Link>

        {/* Header */}
        <header className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-3 rounded-xl bg-emerald-500/10 text-emerald-400">
              <Landmark size={22} />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white">Teknisk ejendomsbeskrivelse</h1>
              <p className="text-slate-400 text-sm mt-1">
                AI-genereret teknisk ejendomsbeskrivelse til bank/realkredit-brug
              </p>
            </div>
          </div>
          <p className="text-slate-500 text-sm max-w-2xl">
            Søg en ejendom og generér en teknisk ejendomsbeskrivelse baseret på BBR, vurdering,
            tinglysning og servitutter. Vælg mellem tre tonarter: realkredit (formel), bankrådgiver
            (key-points) eller internt memo (kort bullets).
          </p>
        </header>

        {/* BIZZ-1605: Fuld bredde — grid layout med søgning + rapport side-by-side på desktop */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-6 w-full">
          <label
            htmlFor="property-search"
            className="block text-sm font-medium text-slate-300 mb-2"
          >
            Søg ejendom
          </label>
          <div className="relative" ref={dropdownRef}>
            <div className="flex items-center gap-2 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500/20">
              <Search size={16} className="text-slate-500" />
              <input
                id="property-search"
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Adresse, BFE-nummer eller matrikel…"
                className="flex-1 bg-transparent text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none"
                onFocus={() => searchResults.length > 0 && setDropdownOpen(true)}
              />
              {searchLoading && (
                <Loader2 size={14} className="text-slate-500 animate-spin" aria-hidden />
              )}
            </div>

            {dropdownOpen && searchResults.length > 0 && (
              <div className="absolute z-10 mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg shadow-xl max-h-80 overflow-y-auto">
                {searchResults
                  .filter((r) => r.type === 'address')
                  .map((r) => (
                    <button
                      key={r.id}
                      onClick={() => handleSelect(r)}
                      className="w-full px-3 py-2.5 text-left hover:bg-slate-800 flex items-center gap-3 border-b border-slate-800 last:border-b-0 transition-colors"
                    >
                      <MapPin size={14} className="text-emerald-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-200 truncate">{r.title}</p>
                        {r.subtitle && (
                          <p className="text-xs text-slate-500 truncate">{r.subtitle}</p>
                        )}
                      </div>
                      <ChevronRight size={14} className="text-slate-600" />
                    </button>
                  ))}
              </div>
            )}
          </div>

          {selected && (
            // BIZZ-1589: Lille opsummeringsblok der erstatter den tidligere
            // "Generér rapport"-knap — selve rapporten loader nu inline neden under.
            <div className="mt-4 p-3 bg-emerald-950/30 border border-emerald-900 rounded-lg flex items-center justify-between">
              <div className="flex items-center gap-3">
                <MapPin size={16} className="text-emerald-400" />
                <div>
                  <p className="text-sm text-emerald-200 font-medium">{selected.adresse}</p>
                  <p className="text-xs text-emerald-500">BFE {selected.bfe}</p>
                </div>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
              >
                Skift ejendom
              </button>
            </div>
          )}
        </div>

        {/* BIZZ-1589: Inline rapport-panel under input-blokken */}
        {selected && (
          <div className="mb-6">
            <GenerateFinanceReportModal
              key={selected.bfe}
              bfe={selected.bfe}
              adresse={selected.adresse}
              lang="da"
              open={true}
              onClose={() => setSelected(null)}
              mode="panel"
            />
          </div>
        )}

        {/* Info-sektion — vises kun før første rapport-generering */}
        {!selected && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full">
            <h2 className="text-sm font-semibold text-white mb-3">Hvad indeholder rapporten?</h2>
            <ul className="space-y-2 text-sm text-slate-400">
              <li>
                • <strong className="text-slate-300">Identifikation</strong> — adresse, BFE,
                kommune, zone-status
              </li>
              <li>
                • <strong className="text-slate-300">Tekniske data</strong> — opførelsesår, areal,
                materialer, energimærke, opvarmning
              </li>
              <li>
                • <strong className="text-slate-300">Vurdering &amp; skat</strong> — offentlig +
                foreløbig vurdering, grundskyld
              </li>
              <li>
                • <strong className="text-slate-300">Tinglyste forhold</strong> — hæftelser,
                ejer-andele, seneste handel
              </li>
              <li>
                • <strong className="text-slate-300">Servitutter</strong> — type + vurderings-impact
                (neutral/reducerende)
              </li>
              <li>
                • <strong className="text-slate-300">Risiko-flag</strong> — sammenfatning til banken
              </li>
            </ul>
          </div>
        )}
      </main>
    </div>
  );
}
