/**
 * ForsikringGapClient — 3-trins wizard for forsikrings-gap-analyse.
 *
 * BIZZ-1223: Trin 1 = vælg kunde, Trin 2 = upload policer (CSV),
 * Trin 3 = gap-rapport med aktiver, gaps og risiko-scoring.
 *
 * @returns Wizard UI
 */

'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import Link from 'next/link';
import {
  Shield,
  Upload,
  ArrowLeft,
  Search,
  ChevronRight,
  ChevronLeft,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  FileSpreadsheet,
  Building2,
  User,
  Loader2,
} from 'lucide-react';
import type { UnifiedSearchResult } from '@/app/api/search/route';
import { parseCsv, type ParsedPolice } from '@/app/lib/parsePoliceFile';
import type { GapAnalyseResult } from '@/app/api/analyse/forsikring-gap/route';

/** Wizard step */
type Step = 1 | 2 | 3;

/**
 * Forsikrings-gap-analyse wizard.
 *
 * @returns Wizard JSX
 */
export default function ForsikringGapClient() {
  const [step, setStep] = useState<Step>(1);

  // Step 1: Kunde
  const [kundeType, setKundeType] = useState<'person' | 'virksomhed'>('person');
  const [kundeId, setKundeId] = useState('');
  const [kundeLabel, setKundeLabel] = useState('');

  /** BIZZ-1251: Autocomplete søge-state */
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UnifiedSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Step 2: Policer
  const [policer, setPolicer] = useState<ParsedPolice[]>([]);
  const [parseFejl, setParseFejl] = useState<Array<{ linje: number; besked: string }>>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Step 3: Resultat
  const [result, setResult] = useState<GapAnalyseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Håndterer fil-upload og parser CSV.
   */
  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const parsed = parseCsv(text);
      setPolicer(parsed.policer);
      setParseFejl(parsed.fejl);
    };
    reader.readAsText(file, 'utf-8');
  }, []);

  /**
   * BIZZ-1251: Debounced autocomplete-søgning filtreret til person+company.
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
          const filtered = data.filter((r) => r.type === 'company' || r.type === 'person');
          setSearchResults(filtered);
          setDropdownOpen(filtered.length > 0);
        }
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
  }, []);

  /**
   * BIZZ-1251: Vælg kunde fra autocomplete.
   *
   * @param result - Valgt søgeresultat
   */
  const selectKunde = useCallback((result: UnifiedSearchResult) => {
    setKundeType(result.type === 'company' ? 'virksomhed' : 'person');
    setKundeId(result.id);
    setKundeLabel(result.title);
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
   * Kører gap-analyse mod backend.
   */
  const runAnalyse = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/analyse/forsikring-gap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kundeType, kundeId, policer }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? 'Analyse fejlede');
        return;
      }
      const data = (await res.json()) as GapAnalyseResult;
      setResult(data);
      setStep(3);
    } catch {
      setError('Netværksfejl');
    } finally {
      setLoading(false);
    }
  }, [kundeType, kundeId, policer]);

  /** Risiko-farve */
  const risikoFarve = (score: string) => {
    if (score === 'hoej') return 'text-red-400 bg-red-500/15 border-red-500/30';
    if (score === 'middel') return 'text-amber-400 bg-amber-500/15 border-amber-500/30';
    return 'text-emerald-400 bg-emerald-500/15 border-emerald-500/30';
  };

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
          <Shield size={24} className="text-blue-400" />
          Forsikrings-gap-analyse
        </h1>
        <p className="text-slate-400 text-sm mt-1">
          Identificér dækningsgab i kundens forsikringsportefølje
        </p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 text-xs">
        {[1, 2, 3].map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center font-bold ${
                step >= s
                  ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                  : 'bg-slate-800 text-slate-500 border border-slate-700/40'
              }`}
            >
              {s}
            </div>
            <span className={step >= s ? 'text-slate-300' : 'text-slate-600'}>
              {s === 1 ? 'Vælg kunde' : s === 2 ? 'Upload policer' : 'Gap-rapport'}
            </span>
            {s < 3 && <ChevronRight size={14} className="text-slate-600" />}
          </div>
        ))}
      </div>

      {/* Step 1: Vælg kunde */}
      {step === 1 && (
        <div className="bg-slate-800/30 border border-slate-700/40 rounded-2xl p-6 space-y-4">
          <h2 className="text-white font-semibold text-sm">Trin 1: Vælg kunde</h2>

          {/* BIZZ-1251: Autocomplete-søgning */}
          <div className="relative" ref={dropdownRef}>
            <div className="relative">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                onFocus={() => {
                  if (searchResults.length > 0) setDropdownOpen(true);
                }}
                placeholder="Søg efter person eller virksomhed..."
                className="w-full pl-9 pr-10 py-2.5 bg-slate-800 border border-slate-700/60 rounded-lg text-sm text-white outline-none focus:border-blue-500/60"
              />
              {searchLoading && (
                <Loader2
                  size={14}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-blue-400 animate-spin"
                />
              )}
            </div>
            {dropdownOpen &&
              searchResults.length > 0 &&
              (() => {
                const persons = searchResults.filter((r) => r.type === 'person');
                const companies = searchResults.filter((r) => r.type === 'company');
                return (
                  <div className="absolute z-50 w-full mt-1 bg-slate-800 border border-slate-700/60 rounded-lg shadow-xl max-h-72 overflow-y-auto">
                    {persons.length > 0 && (
                      <>
                        <div className="px-3 py-1.5 flex items-center gap-1.5 bg-slate-900/60 border-b border-slate-700/30 sticky top-0">
                          <User size={11} className="text-purple-400" />
                          <span className="text-[10px] font-semibold text-purple-300 uppercase tracking-wider">
                            Personer
                          </span>
                        </div>
                        {persons.map((result) => (
                          <button
                            key={`person-${result.id}`}
                            type="button"
                            onClick={() => selectKunde(result)}
                            className="w-full text-left px-3 py-2.5 hover:bg-slate-700/50 transition-colors flex items-start gap-3 border-b border-slate-700/20 last:border-b-0"
                          >
                            <User size={14} className="text-purple-400 mt-0.5 shrink-0" />
                            <div className="min-w-0 flex-1">
                              <div className="text-sm text-white truncate">{result.title}</div>
                              <div className="text-xs text-slate-400 truncate">
                                {result.subtitle}
                              </div>
                            </div>
                          </button>
                        ))}
                      </>
                    )}
                    {companies.length > 0 && (
                      <>
                        <div className="px-3 py-1.5 flex items-center gap-1.5 bg-slate-900/60 border-b border-slate-700/30 sticky top-0">
                          <Building2 size={11} className="text-blue-400" />
                          <span className="text-[10px] font-semibold text-blue-300 uppercase tracking-wider">
                            Virksomheder
                          </span>
                        </div>
                        {companies.map((result) => (
                          <button
                            key={`company-${result.id}`}
                            type="button"
                            onClick={() => selectKunde(result)}
                            className="w-full text-left px-3 py-2.5 hover:bg-slate-700/50 transition-colors flex items-start gap-3 border-b border-slate-700/20 last:border-b-0"
                          >
                            <Building2 size={14} className="text-blue-400 mt-0.5 shrink-0" />
                            <div className="min-w-0 flex-1">
                              <div className="text-sm text-white truncate">{result.title}</div>
                              <div className="text-xs text-slate-400 truncate">
                                {result.subtitle}
                              </div>
                            </div>
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                );
              })()}
          </div>

          {/* Valgt kunde indikator */}
          {kundeId && (
            <div className="flex items-center gap-2 text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2">
              {kundeType === 'virksomhed' ? <Building2 size={12} /> : <User size={12} />}
              <span className="font-medium">
                {kundeLabel || kundeId} ({kundeType === 'virksomhed' ? 'CVR' : 'EnhedsNr'} {kundeId}
                )
              </span>
              <button
                type="button"
                onClick={() => {
                  setKundeId('');
                  setKundeLabel('');
                  setSearchQuery('');
                }}
                className="ml-auto text-slate-400 hover:text-white"
                aria-label="Ryd valg"
              >
                &times;
              </button>
            </div>
          )}

          <button
            onClick={() => setStep(2)}
            disabled={!kundeId}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          >
            Næste <ChevronRight size={14} />
          </button>
        </div>
      )}

      {/* Step 2: Upload policer */}
      {step === 2 && (
        <div className="bg-slate-800/30 border border-slate-700/40 rounded-2xl p-6 space-y-4">
          <h2 className="text-white font-semibold text-sm">Trin 2: Upload policeliste</h2>
          <p className="text-slate-400 text-xs">
            Upload en CSV-fil med kolonner: Type, Dækning, Selskab, Objekt (semikolon eller
            komma-separeret)
          </p>

          {/* Drop zone */}
          <div
            onClick={() => fileRef.current?.click()}
            className="border-2 border-dashed border-slate-600/60 rounded-xl p-8 text-center cursor-pointer hover:border-blue-500/40 transition-colors"
          >
            <Upload size={24} className="mx-auto text-slate-500 mb-2" />
            <p className="text-slate-400 text-sm">
              {fileName ? (
                <span className="text-blue-300 flex items-center justify-center gap-2">
                  <FileSpreadsheet size={14} /> {fileName}
                </span>
              ) : (
                'Klik for at vælge CSV-fil'
              )}
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt"
              onChange={handleFileUpload}
              className="hidden"
            />
          </div>

          {/* Parse results */}
          {policer.length > 0 && (
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 text-emerald-300 text-xs">
              <CheckCircle2 size={14} className="inline mr-1" />
              {policer.length} policer indlæst
            </div>
          )}
          {parseFejl.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-amber-300 text-xs">
              <AlertTriangle size={14} className="inline mr-1" />
              {parseFejl.length} fejl:{' '}
              {parseFejl.map((f) => `Linje ${f.linje}: ${f.besked}`).join(', ')}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => setStep(1)}
              className="bg-slate-700 hover:bg-slate-600 text-slate-300 px-4 py-2 rounded-lg text-sm flex items-center gap-1"
            >
              <ChevronLeft size={14} /> Tilbage
            </button>
            <button
              onClick={runAnalyse}
              disabled={policer.length === 0 || loading}
              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              {loading ? 'Analyserer...' : 'Kør analyse'}
              <ChevronRight size={14} />
            </button>
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-red-300 text-xs">
              {error}
            </div>
          )}
        </div>
      )}

      {/* Step 3: Gap-rapport */}
      {step === 3 && result && (
        <div className="space-y-4">
          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Aktiver fundet', val: result.summary.totalAktiver, color: 'blue' },
              { label: 'Forsikrede', val: result.summary.forsikrede, color: 'emerald' },
              { label: 'Uforsikrede', val: result.summary.uforsikrede, color: 'red' },
              { label: 'Underforsikrede', val: result.summary.underforsikrede, color: 'amber' },
            ].map((c) => (
              <div
                key={c.label}
                className={`bg-${c.color}-500/10 border border-${c.color}-500/30 rounded-xl p-4 text-center`}
              >
                <p className={`text-${c.color}-300 text-2xl font-bold`}>{c.val}</p>
                <p className="text-slate-400 text-xs mt-1">{c.label}</p>
              </div>
            ))}
          </div>

          {/* Gaps table */}
          {result.gaps.length > 0 && (
            <div className="bg-slate-800/30 border border-slate-700/40 rounded-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-700/40">
                <h3 className="text-white font-semibold text-sm flex items-center gap-2">
                  <AlertTriangle size={14} className="text-amber-400" />
                  Identificerede gaps ({result.gaps.length})
                </h3>
              </div>
              <div className="divide-y divide-slate-700/30">
                {result.gaps.map((gap, i) => (
                  <div key={i} className="px-5 py-3 flex items-start gap-3">
                    <span
                      className={`shrink-0 px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${risikoFarve(gap.risikoScore)}`}
                    >
                      {gap.risikoScore === 'hoej'
                        ? 'Høj'
                        : gap.risikoScore === 'middel'
                          ? 'Middel'
                          : 'Lav'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-medium">{gap.aktiv.label}</p>
                      <p className="text-slate-400 text-xs mt-0.5">{gap.besked}</p>
                    </div>
                    {gap.gapType === 'uforsikret' && (
                      <XCircle size={16} className="text-red-400 shrink-0" />
                    )}
                    {gap.gapType === 'underforsikret' && (
                      <AlertTriangle size={16} className="text-amber-400 shrink-0" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Aktiver tabel */}
          <div className="bg-slate-800/30 border border-slate-700/40 rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-700/40">
              <h3 className="text-white font-semibold text-sm">
                Alle aktiver ({result.aktiver.length})
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500 border-b border-slate-700/30">
                    <th className="px-4 py-2 text-left font-medium">Type</th>
                    <th className="px-4 py-2 text-left font-medium">Aktiv</th>
                    <th className="px-4 py-2 text-right font-medium">Værdi</th>
                    <th className="px-4 py-2 text-left font-medium">Dækning</th>
                    <th className="px-4 py-2 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/20">
                  {result.aktiver.map((aktiv, i) => (
                    <tr key={i} className="hover:bg-slate-700/10">
                      <td className="px-4 py-2 text-slate-400">{aktiv.type}</td>
                      <td className="px-4 py-2 text-slate-200">{aktiv.label}</td>
                      <td className="px-4 py-2 text-right text-slate-300">
                        {aktiv.vaerdi ? `${aktiv.vaerdi.toLocaleString('da-DK')} DKK` : '—'}
                      </td>
                      <td className="px-4 py-2 text-slate-400">
                        {aktiv.matchetPolice
                          ? `${aktiv.matchetPolice.rawType} (${aktiv.matchetPolice.daekningssum?.toLocaleString('da-DK') ?? '?'} DKK)`
                          : '—'}
                      </td>
                      <td className="px-4 py-2">
                        {aktiv.matchetPolice ? (
                          <span className="text-emerald-400">Dækket</span>
                        ) : (
                          <span className="text-red-400">Uforsikret</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* BIZZ-1227: Eksport-knapper */}
          <div className="flex gap-2">
            <button
              onClick={() => {
                // Byg prompt med gap-data og send til AI chat for rapport-generering
                const gapLines = result.gaps
                  .map(
                    (g) =>
                      `- ${g.aktiv.label}: ${g.gapType} (risiko: ${g.risikoScore}). ${g.besked}`
                  )
                  .join('\n');
                const prompt = `Generér en professionel forsikrings-gap-rapport som Word-dokument for ${kundeLabel || kundeId}.

Resumé: ${result.summary.totalAktiver} aktiver fundet, ${result.summary.forsikrede} forsikrede, ${result.summary.uforsikrede} uforsikrede, ${result.summary.underforsikrede} underforsikrede.

Identificerede gaps:
${gapLines}

Inkludér: forside med kundenavn og dato, resumé-sektion, aktiv-oversigt som tabel (type, adresse, værdi, status), detaljer per gap med anbefaling, og risiko-profil. Format: Word (docx).`;

                window.dispatchEvent(
                  new CustomEvent('bizz:ai-open-with-prompt', {
                    detail: { prompt, displayText: 'Generér forsikrings-gap rapport (Word)' },
                  })
                );
              }}
              className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2"
            >
              <FileSpreadsheet size={14} />
              Generér rapport (Word)
            </button>
            <button
              onClick={() => {
                setStep(1);
                setResult(null);
              }}
              className="bg-slate-700 hover:bg-slate-600 text-slate-300 px-4 py-2 rounded-lg text-sm flex items-center gap-1"
            >
              <ChevronLeft size={14} /> Ny analyse
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
