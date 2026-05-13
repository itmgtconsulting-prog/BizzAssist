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
  Users,
  Loader2,
  Briefcase,
  ArrowRight,
  X,
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

  // Step 2: Policer — multi-fil upload
  /** Uploadede filer med deres individuelle parse-resultater */
  const [uploadedFiles, setUploadedFiles] = useState<
    Array<{ name: string; policer: ParsedPolice[] }>
  >([]);
  /** Samlet liste af alle policer fra alle uploadede filer */
  const policer = uploadedFiles.flatMap((f) => f.policer);
  const [parseFejl, setParseFejl] = useState<Array<{ linje: number; besked: string }>>([]);
  const [fritekst, setFritekst] = useState('');
  const [parseLoading, setParseLoading] = useState(false);
  /** Fil der parses lige nu (vises i UI) */
  const [parsingFileName, setParsingFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // Step 3: Resultat
  const [result, setResult] = useState<GapAnalyseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Parser én fil og tilføjer resultatet til uploadedFiles.
   * CSV/TXT parses lokalt, andre formater sendes til AI.
   *
   * @param file - Fil der skal parses
   */
  const parseAndAddFile = useCallback(async (file: File) => {
    // Skip duplikater (samme filnavn allerede uploadet)
    setUploadedFiles((prev) => {
      if (prev.some((f) => f.name === file.name)) return prev;
      return prev;
    });

    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';

    // CSV/TXT: parse lokalt
    if (ext === 'csv' || ext === 'txt') {
      const text = await file.text();
      const parsed = parseCsv(text);
      if (parsed.fejl.length > 0) {
        setParseFejl((prev) => [...prev, ...parsed.fejl]);
      }
      if (parsed.policer.length > 0) {
        setUploadedFiles((prev) => {
          if (prev.some((f) => f.name === file.name)) return prev;
          return [...prev, { name: file.name, policer: parsed.policer }];
        });
      }
      return;
    }

    // PDF/DOCX/XLSX/billeder: send til AI-parsing
    setParseLoading(true);
    setParsingFileName(file.name);
    try {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(new Uint8Array(buffer).reduce((s, b) => s + String.fromCharCode(b), ''));
      const res = await fetch('/api/analyse/parse-police-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfBase64: base64, fileName: file.name }),
      });
      if (res.ok) {
        const data = await res.json();
        const parsed: ParsedPolice[] = data.policer ?? [];
        if (parsed.length > 0) {
          setUploadedFiles((prev) => {
            if (prev.some((f) => f.name === file.name)) return prev;
            return [...prev, { name: file.name, policer: parsed }];
          });
        } else {
          setParseFejl((prev) => [
            ...prev,
            { linje: 0, besked: `${file.name}: Ingen policer fundet i filen` },
          ]);
        }
      } else {
        setParseFejl((prev) => [
          ...prev,
          { linje: 0, besked: `${file.name}: Kunne ikke parse fil — prøv CSV-format` },
        ]);
      }
    } catch {
      setParseFejl((prev) => [
        ...prev,
        { linje: 0, besked: `${file.name}: Netværksfejl ved fil-parsing` },
      ]);
    } finally {
      setParseLoading(false);
      setParsingFileName(null);
    }
  }, []);

  /**
   * Håndterer fil-upload fra input — understøtter flere filer ad gangen.
   *
   * @param e - Change event fra file input
   */
  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      setParseFejl([]);
      // Parse filer sekventielt (AI-parsing kan kun håndtere én ad gangen)
      for (const file of Array.from(files)) {
        await parseAndAddFile(file);
      }
      // Reset input så samme fil kan vælges igen
      if (fileRef.current) fileRef.current.value = '';
    },
    [parseAndAddFile]
  );

  /**
   * Håndterer drag-and-drop af filer.
   *
   * @param e - Drop event
   */
  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;
      setParseFejl([]);
      for (const file of Array.from(files)) {
        await parseAndAddFile(file);
      }
    },
    [parseAndAddFile]
  );

  /**
   * Fjerner en uploadet fil og dens policer.
   *
   * @param name - Filnavn der skal fjernes
   */
  const removeFile = useCallback((name: string) => {
    setUploadedFiles((prev) => prev.filter((f) => f.name !== name));
  }, []);

  // BIZZ-1281: parseFreitekst fjernet — fritekst bruges direkte via BIZZ-1280

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
  /** BIZZ-1280: Kør analyse — sender policer-array ELLER fritekst direkte */
  const runAnalyse = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { kundeType, kundeId };
      if (policer.length > 0) {
        payload.policer = policer;
      } else if (fritekst.trim().length >= 3) {
        // Fritekst sendes direkte — backend parser via AI
        payload.fritekst = fritekst.trim();
      }
      const res = await fetch('/api/analyse/forsikring-gap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
  }, [kundeType, kundeId, policer, fritekst]);

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
        {/* BIZZ-1224: Link til batch-analyse */}
        <a
          href="/dashboard/analyse/forsikring/batch"
          className="inline-flex items-center gap-1.5 mt-2 text-xs text-blue-400 hover:text-blue-300 transition-colors"
        >
          <Users size={12} />
          Batch-analyse (1000+ kunder)
        </a>
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
                const virksomheder = searchResults.filter((r) => r.type === 'company').slice(0, 8);
                const personer = searchResults.filter((r) => r.type === 'person').slice(0, 8);

                const sections: {
                  key: string;
                  label: string;
                  headerColor: string;
                  items: UnifiedSearchResult[];
                }[] = [];
                if (virksomheder.length > 0)
                  sections.push({
                    key: 'comp',
                    label: 'VIRKSOMHEDER',
                    headerColor: 'text-blue-400',
                    items: virksomheder,
                  });
                if (personer.length > 0)
                  sections.push({
                    key: 'pers',
                    label: 'PERSONER',
                    headerColor: 'text-purple-400',
                    items: personer,
                  });

                return (
                  <div className="absolute z-50 w-full mt-1 bg-slate-900 border border-slate-700/60 rounded-2xl shadow-2xl max-h-[70vh] overflow-y-auto">
                    {sections.map((sec, si) => (
                      <div key={sec.key}>
                        <div
                          className={`px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${sec.headerColor} bg-slate-800/40 ${si > 0 ? 'border-t border-slate-700/30' : ''}`}
                        >
                          {sec.label}
                        </div>
                        {sec.items.map((r) => {
                          const isCompany = r.type === 'company';
                          const hoverBg = isCompany
                            ? 'hover:bg-blue-600/10'
                            : 'hover:bg-purple-600/10';
                          const accentColor = isCompany ? 'text-blue-400' : 'text-purple-400';
                          const iconBg = isCompany ? 'bg-blue-600/15' : 'bg-purple-600/15';
                          const arrowIdle = isCompany
                            ? 'text-slate-600 group-hover:text-blue-400'
                            : 'text-slate-600 group-hover:text-purple-400';
                          const ResultIcon = isCompany ? Briefcase : Users;

                          return (
                            <button
                              key={`${r.type}-${r.id}`}
                              type="button"
                              onClick={() => selectKunde(r)}
                              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors group ${hoverBg}`}
                            >
                              <div className={`p-1 rounded-md flex-shrink-0 ${iconBg}`}>
                                <ResultIcon size={11} className={accentColor} />
                              </div>
                              <div className="flex-1 min-w-0">
                                {isCompany ? (
                                  <>
                                    <div className="flex items-center gap-1.5">
                                      <p className="text-white text-xs font-medium truncate">
                                        {r.title}
                                      </p>
                                      {r.meta?.active && (
                                        <span
                                          className={`inline-flex items-center px-1 py-0 rounded text-[8px] font-medium flex-shrink-0 ${r.meta.active === 'true' ? 'bg-emerald-600/20 text-emerald-400' : 'bg-red-600/20 text-red-400'}`}
                                        >
                                          {r.meta.active === 'true' ? 'Aktiv' : 'Ophørt'}
                                        </span>
                                      )}
                                    </div>
                                    <p className="text-slate-400 text-[10px] truncate">
                                      CVR {r.id}
                                      {r.meta?.industry ? ` \u00b7 ${r.meta.industry}` : ''}
                                      {r.meta?.city ? ` \u00b7 ${r.meta.city}` : ''}
                                    </p>
                                  </>
                                ) : (
                                  <>
                                    <p className="text-white text-xs font-medium truncate">
                                      {r.title}
                                    </p>
                                    {r.subtitle && (
                                      <p className="text-slate-400 text-[10px] truncate">
                                        {r.subtitle}
                                      </p>
                                    )}
                                  </>
                                )}
                              </div>
                              <ArrowRight size={11} className={arrowIdle} />
                            </button>
                          );
                        })}
                      </div>
                    ))}
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
          <h2 className="text-white font-semibold text-sm">Trin 2: Angiv forsikringer</h2>
          <p className="text-slate-400 text-xs">
            Beskriv kundens forsikringer som fritekst, eller upload én eller flere filer (PDF, Word,
            Excel, CSV, billede)
          </p>

          {/* Fritekst-input */}
          <div className="space-y-2">
            <textarea
              value={fritekst}
              onChange={(e) => setFritekst(e.target.value)}
              placeholder="Beskriv kundens forsikringer her, fx:&#10;Husforsikring hos Tryg, dækning 2.500.000 kr&#10;Bilforsikring kasko hos TopDanmark, reg.nr AB12345&#10;Indboforsikring hos Alm Brand, 500.000 kr"
              rows={4}
              className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700/60 rounded-lg text-sm text-white placeholder:text-slate-500 outline-none focus:border-blue-500/60 resize-y min-h-[100px]"
            />
          </div>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-slate-700/50" />
            <span className="text-slate-500 text-xs">eller</span>
            <div className="flex-1 h-px bg-slate-700/50" />
          </div>

          {/* Drop zone — alle formater, flere filer */}
          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
              dragOver
                ? 'border-blue-500/60 bg-blue-500/5'
                : 'border-slate-600/60 hover:border-blue-500/40'
            }`}
          >
            <Upload size={24} className="mx-auto text-slate-500 mb-2" />
            <p className="text-slate-400 text-sm">
              {parseLoading ? (
                <span className="text-blue-300 flex items-center justify-center gap-2">
                  <Loader2 size={14} className="animate-spin" /> Parser {parsingFileName ?? 'fil'}
                  ...
                </span>
              ) : (
                'Klik eller træk filer hertil'
              )}
            </p>
            <p className="text-slate-600 text-[10px] mt-1">
              PDF, Word, Excel, CSV, billeder (JPG/PNG) — flere filer ad gangen
            </p>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".csv,.txt,.pdf,.docx,.doc,.xlsx,.xls,.jpg,.jpeg,.png"
              onChange={handleFileUpload}
              className="hidden"
            />
          </div>

          {/* Uploadede filer */}
          {uploadedFiles.length > 0 && (
            <div className="space-y-1.5">
              {uploadedFiles.map((f) => (
                <div
                  key={f.name}
                  className="flex items-center gap-2 bg-slate-800/60 border border-slate-700/40 rounded-lg px-3 py-2"
                >
                  <FileSpreadsheet size={14} className="text-blue-400 shrink-0" />
                  <span className="text-sm text-slate-200 truncate flex-1">{f.name}</span>
                  <span className="text-xs text-slate-500 shrink-0">
                    {f.policer.length} {f.policer.length === 1 ? 'police' : 'policer'}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFile(f.name);
                    }}
                    aria-label={`Fjern ${f.name}`}
                    className="p-1 rounded text-slate-500 hover:text-red-400 hover:bg-slate-700/40 transition-colors shrink-0"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Parse results */}
          {policer.length > 0 && (
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 text-emerald-300 text-xs">
              <CheckCircle2 size={14} className="inline mr-1" />
              {policer.length} policer indlæst fra {uploadedFiles.length}{' '}
              {uploadedFiles.length === 1 ? 'fil' : 'filer'}
            </div>
          )}
          {parseFejl.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-amber-300 text-xs">
              <AlertTriangle size={14} className="inline mr-1" />
              {parseFejl.length} fejl: {parseFejl.map((f) => f.besked).join(', ')}
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
              disabled={(policer.length === 0 && fritekst.trim().length < 3) || loading}
              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              {loading ? 'Analyserer...' : 'Kør analyse'}
              <ChevronRight size={14} />
            </button>
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 flex items-start gap-3">
              <AlertTriangle size={18} className="text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-red-300 text-sm font-medium">Analysen kunne ikke gennemføres</p>
                <p className="text-red-300/80 text-xs mt-1">{error}</p>
              </div>
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
