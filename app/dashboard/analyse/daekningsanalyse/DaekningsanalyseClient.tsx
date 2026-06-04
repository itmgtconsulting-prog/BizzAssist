/**
 * DaekningsanalyseClient — upload kundeadresser, vis dækning pr. matrikel.
 *
 * BIZZ-1991: Upload Excel/CSV → DAWA-resolution → heatmap + tabel.
 * BIZZ-1993: Upload-zone med drag-and-drop.
 * BIZZ-1995: Mapbox heatmap med rød/gul/grøn.
 * BIZZ-1996: Dækningstabel med sortering og flag.
 * BIZZ-1999: Konfigurerbare markedsandels-tærskler.
 *
 * @module app/dashboard/analyse/daekningsanalyse/DaekningsanalyseClient
 */

'use client';

import { useState, useCallback, useRef, useMemo } from 'react';
import {
  Upload,
  FileSpreadsheet,
  X,
  Loader2,
  Download,
  MapPin,
  ChevronUp,
  ChevronDown,
  AlertTriangle,
  CheckCircle2,
  MinusCircle,
  Filter,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { useLanguage } from '@/app/context/LanguageContext';

// ─── Lazy Mapbox ────────────────────────────────────────────────────────────

const DaekningsMap = dynamic(() => import('./DaekningsMap'), { ssr: false });

// ─── Types ──────────────────────────────────────────────────────────────────

/** Result per matrikel from the resolve API */
interface MatrikelResult {
  matrikelnr: string;
  ejerlavskode: number;
  ejerlav: string;
  totalEnheder: number;
  kundeAntal: number;
  daekningPct: number;
  koordinat: { lat: number; lng: number } | null;
  adresserLabel: string;
  ejerforening?: string | null;
  ejerforeningCvr?: string | null;
}

type SortKey = 'matrikelnr' | 'adresserLabel' | 'totalEnheder' | 'kundeAntal' | 'daekningPct';
type SortDir = 'asc' | 'desc';
type StatusFilter = 'all' | 'red' | 'yellow' | 'green';

/**
 * Classify coverage relative to expected market share.
 *
 * @param pct - Actual coverage percentage (0-100)
 * @param expected - Expected market share percentage
 * @returns 'red' | 'yellow' | 'green'
 */
function classifyCoverage(pct: number, expected: number): 'red' | 'yellow' | 'green' {
  if (expected <= 0) return 'green';
  const ratio = pct / expected;
  if (ratio < 0.5) return 'red';
  if (ratio < 0.8) return 'yellow';
  return 'green';
}

/** Status badge colors */
const STATUS_STYLES = {
  red: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/30' },
  yellow: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/30' },
  green: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/30' },
} as const;

const STATUS_LABELS = {
  red: { da: 'Mulig konkurrence', en: 'Possible competition' },
  yellow: { da: 'Under forventet', en: 'Below expected' },
  green: { da: 'Normal dækning', en: 'Normal coverage' },
} as const;

/**
 * DaekningsanalyseClient — main component for coverage analysis module.
 *
 * @returns Upload zone → results (map + table)
 */
export default function DaekningsanalyseClient() {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const fileRef = useRef<HTMLInputElement>(null);

  // Upload state
  const [file, setFile] = useState<File | null>(null);
  const [parsedAddresses, setParsedAddresses] = useState<string[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);

  // Analysis state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<MatrikelResult[]>([]);
  const [analysed, setAnalysed] = useState(false);

  // Threshold config (BIZZ-1999)
  const [expectedShare, setExpectedShare] = useState(45);

  // Table sorting
  const [sortKey, setSortKey] = useState<SortKey>('daekningPct');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  // Dragging state
  const [dragging, setDragging] = useState(false);

  /**
   * Parse uploaded Excel/CSV file and extract addresses.
   *
   * @param f - File to parse
   */
  const parseFile = useCallback(
    async (f: File) => {
      setFile(f);
      setParseError(null);
      setParsedAddresses([]);
      setResults([]);
      setAnalysed(false);

      try {
        const ExcelJS = (await import('exceljs')).default;
        const wb = new ExcelJS.Workbook();

        if (f.name.endsWith('.csv')) {
          const text = await f.text();
          // Simple CSV parse — split on newlines, skip header
          const lines = text.split(/\r?\n/).filter((l) => l.trim());
          const addrs = lines
            .slice(1)
            .map((l) => l.replace(/^"/, '').replace(/"$/, '').trim())
            .filter(Boolean);
          setParsedAddresses(addrs);
        } else {
          const buf = await f.arrayBuffer();
          await wb.xlsx.load(buf);
          const ws = wb.worksheets[0];
          if (!ws) throw new Error('Ingen ark fundet i filen');

          const addrs: string[] = [];
          ws.eachRow((row, rowNum) => {
            if (rowNum === 1) return; // Skip header
            const val = row.getCell(1).text?.trim();
            if (val) addrs.push(val);
          });
          setParsedAddresses(addrs);
        }
      } catch (err) {
        setParseError(
          da
            ? `Kunne ikke læse filen: ${err instanceof Error ? err.message : 'Ukendt fejl'}`
            : `Could not read file: ${err instanceof Error ? err.message : 'Unknown error'}`
        );
      }
    },
    [da]
  );

  /** Handle file drop */
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files[0];
      if (f) parseFile(f);
    },
    [parseFile]
  );

  /** Handle file input change */
  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) parseFile(f);
    },
    [parseFile]
  );

  /** Run the analysis — send addresses to resolve API */
  const runAnalysis = useCallback(async () => {
    if (parsedAddresses.length === 0) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/analyse/daekningsanalyse/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adresser: parsedAddresses }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
      }
      const data: MatrikelResult[] = await res.json();
      setResults(data);
      setAnalysed(true);
    } catch (err) {
      setError(
        da
          ? `Analyse fejlede: ${err instanceof Error ? err.message : 'Ukendt fejl'}`
          : `Analysis failed: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
    } finally {
      setLoading(false);
    }
  }, [parsedAddresses, da]);

  /** Reset everything */
  const reset = useCallback(() => {
    setFile(null);
    setParsedAddresses([]);
    setParseError(null);
    setResults([]);
    setAnalysed(false);
    setError(null);
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  /** Classified results with status */
  const classified = useMemo(
    () =>
      results.map((r) => ({
        ...r,
        status: classifyCoverage(r.daekningPct, expectedShare),
      })),
    [results, expectedShare]
  );

  /** Filtered + sorted results */
  const sortedResults = useMemo(() => {
    let items =
      statusFilter === 'all' ? classified : classified.filter((r) => r.status === statusFilter);

    items = [...items].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      return sortDir === 'asc'
        ? String(av).localeCompare(String(bv), 'da')
        : String(bv).localeCompare(String(av), 'da');
    });
    return items;
  }, [classified, sortKey, sortDir, statusFilter]);

  /** Toggle sort on column click */
  const toggleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDir(key === 'daekningPct' ? 'asc' : 'desc');
      }
    },
    [sortKey]
  );

  /** Export to Excel (BIZZ-1997) */
  const exportExcel = useCallback(async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();

    // Sheet 1: Overview
    const ws1 = wb.addWorksheet(da ? 'Oversigt' : 'Overview');
    ws1.columns = [
      { header: 'Matrikelnr', key: 'mat', width: 15 },
      { header: da ? 'Adresse(r)' : 'Address(es)', key: 'addr', width: 40 },
      { header: da ? 'Ejerforening' : "Owners' association", key: 'ejf', width: 30 },
      { header: da ? 'Total enheder' : 'Total units', key: 'total', width: 14 },
      { header: da ? 'Kunder' : 'Customers', key: 'kunder', width: 10 },
      { header: da ? 'Dækning %' : 'Coverage %', key: 'pct', width: 12 },
      { header: 'Status', key: 'status', width: 20 },
    ];
    ws1.getRow(1).font = { bold: true };
    for (const r of classified) {
      ws1.addRow({
        mat: r.matrikelnr,
        addr: r.adresserLabel,
        ejf: r.ejerforening || '',
        total: r.totalEnheder,
        kunder: r.kundeAntal,
        pct: Math.round(r.daekningPct),
        status: STATUS_LABELS[r.status][lang],
      });
    }

    // Sheet 2: Details
    const ws2 = wb.addWorksheet(da ? 'Detaljer' : 'Details');
    ws2.columns = [{ header: da ? 'Kundeadresse' : 'Customer address', key: 'addr', width: 55 }];
    ws2.getRow(1).font = { bold: true };
    for (const a of parsedAddresses) {
      ws2.addRow({ addr: a });
    }

    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `daekningsanalyse-${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }, [classified, parsedAddresses, da, lang]);

  /** Summary counts */
  const redCount = classified.filter((r) => r.status === 'red').length;
  const yellowCount = classified.filter((r) => r.status === 'yellow').length;
  const greenCount = classified.filter((r) => r.status === 'green').length;

  /** Sort icon */
  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return null;
    return sortDir === 'asc' ? (
      <ChevronUp size={12} className="inline ml-0.5" />
    ) : (
      <ChevronDown size={12} className="inline ml-0.5" />
    );
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">
          {da ? 'Dækningsanalyse' : 'Coverage Analysis'}
        </h1>
        <p className="text-slate-400 text-sm mt-1">
          {da
            ? 'Upload kundeadresser (Excel/CSV) og se din dækning pr. matrikel og ejerforening.'
            : "Upload customer addresses (Excel/CSV) and see your coverage per cadastre and owners' association."}
        </p>
      </div>

      {/* Threshold config (BIZZ-1999) */}
      <div className="bg-[#1e293b] border border-white/10 rounded-xl p-4">
        <label className="flex items-center gap-3">
          <span className="text-sm text-slate-300 whitespace-nowrap">
            {da ? 'Forventet markedsandel:' : 'Expected market share:'}
          </span>
          <input
            type="range"
            min={5}
            max={80}
            value={expectedShare}
            onChange={(e) => setExpectedShare(Number(e.target.value))}
            className="flex-1 accent-blue-500"
          />
          <span className="text-sm font-bold text-white w-12 text-right">{expectedShare}%</span>
        </label>
        <p className="text-xs text-slate-400 mt-1.5">
          {da
            ? `Rød: <${Math.round(expectedShare * 0.5)}% · Gul: ${Math.round(expectedShare * 0.5)}-${Math.round(expectedShare * 0.8)}% · Grøn: >${Math.round(expectedShare * 0.8)}%`
            : `Red: <${Math.round(expectedShare * 0.5)}% · Yellow: ${Math.round(expectedShare * 0.5)}-${Math.round(expectedShare * 0.8)}% · Green: >${Math.round(expectedShare * 0.8)}%`}
        </p>
      </div>

      {/* Upload zone */}
      {!analysed && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
            dragging
              ? 'border-blue-500 bg-blue-500/5'
              : 'border-white/10 hover:border-white/20 bg-white/[0.02]'
          }`}
        >
          {file ? (
            <div className="space-y-4">
              <div className="flex items-center justify-center gap-2 text-white">
                <FileSpreadsheet size={20} className="text-emerald-400" />
                <span className="font-medium">{file.name}</span>
                <button
                  type="button"
                  onClick={reset}
                  className="text-slate-400 hover:text-white ml-2"
                  aria-label={da ? 'Fjern fil' : 'Remove file'}
                >
                  <X size={16} />
                </button>
              </div>

              {parseError && <p className="text-red-400 text-sm">{parseError}</p>}

              {parsedAddresses.length > 0 && (
                <>
                  <p className="text-slate-400 text-sm">
                    {da
                      ? `${parsedAddresses.length} adresser fundet i filen`
                      : `${parsedAddresses.length} addresses found in file`}
                  </p>
                  {/* Preview first 5 */}
                  <div className="bg-white/5 rounded-lg p-3 max-w-md mx-auto">
                    {parsedAddresses.slice(0, 5).map((a, i) => (
                      <p key={i} className="text-xs text-slate-300 truncate">
                        {a}
                      </p>
                    ))}
                    {parsedAddresses.length > 5 && (
                      <p className="text-xs text-slate-400 mt-1">
                        + {parsedAddresses.length - 5} {da ? 'mere' : 'more'}…
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={runAnalysis}
                    disabled={loading}
                    className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold py-2.5 px-6 rounded-xl transition-colors inline-flex items-center gap-2"
                  >
                    {loading ? (
                      <>
                        <Loader2 size={16} className="animate-spin" />
                        {da ? 'Analyserer…' : 'Analysing…'}
                      </>
                    ) : (
                      <>
                        <MapPin size={16} />
                        {da ? 'Start analyse' : 'Run analysis'}
                      </>
                    )}
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <Upload size={32} className="text-slate-400 mx-auto" />
              <p className="text-white font-medium">
                {da
                  ? 'Træk en fil hertil eller klik for at vælge'
                  : 'Drop a file here or click to select'}
              </p>
              <p className="text-slate-400 text-xs">Excel (.xlsx) eller CSV</p>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="bg-white/10 hover:bg-white/15 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors"
              >
                {da ? 'Vælg fil' : 'Choose file'}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.csv"
                onChange={onFileChange}
                className="hidden"
              />
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3">
          <AlertTriangle size={16} className="text-red-400 shrink-0 mt-0.5" />
          <p className="text-red-300 text-sm">{error}</p>
        </div>
      )}

      {/* Results */}
      {analysed && results.length > 0 && (
        <>
          {/* Summary badges */}
          <div className="flex items-center gap-4 flex-wrap">
            <button
              type="button"
              onClick={reset}
              className="text-sm text-slate-400 hover:text-white transition-colors"
            >
              {da ? '← Ny analyse' : '← New analysis'}
            </button>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-red-500/10 text-red-400">
                <AlertTriangle size={10} /> {redCount}
              </span>
              <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-amber-500/10 text-amber-400">
                <MinusCircle size={10} /> {yellowCount}
              </span>
              <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-emerald-500/10 text-emerald-400">
                <CheckCircle2 size={10} /> {greenCount}
              </span>
            </div>
            <button
              type="button"
              onClick={exportExcel}
              className="ml-auto inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 px-3 py-1.5 rounded-lg transition-colors"
            >
              <Download size={12} /> Excel
            </button>
          </div>

          {/* Map (BIZZ-1995) */}
          <div
            className="bg-[#1e293b] border border-white/10 rounded-xl overflow-hidden"
            style={{ height: 400 }}
          >
            <DaekningsMap results={classified} />
          </div>

          {/* Table filter */}
          <div className="flex items-center gap-2">
            <Filter size={14} className="text-slate-400" />
            {(['all', 'red', 'yellow', 'green'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setStatusFilter(f)}
                className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                  statusFilter === f
                    ? 'bg-blue-600 text-white'
                    : 'bg-white/5 text-slate-400 hover:text-white'
                }`}
              >
                {f === 'all' ? (da ? 'Alle' : 'All') : STATUS_LABELS[f][lang]}
              </button>
            ))}
          </div>

          {/* Table (BIZZ-1996) */}
          <div className="bg-[#1e293b] border border-white/10 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10">
                  {(
                    [
                      ['matrikelnr', da ? 'Matrikel' : 'Cadastre'],
                      ['adresserLabel', da ? 'Adresse(r)' : 'Address(es)'],
                      ['totalEnheder', da ? 'Total' : 'Total'],
                      ['kundeAntal', da ? 'Kunder' : 'Customers'],
                      ['daekningPct', da ? 'Dækning' : 'Coverage'],
                    ] as [SortKey, string][]
                  ).map(([key, label]) => (
                    <th
                      key={key}
                      onClick={() => toggleSort(key)}
                      className="text-left text-xs text-slate-400 font-medium px-4 py-3 cursor-pointer hover:text-white transition-colors select-none"
                    >
                      {label}
                      <SortIcon col={key} />
                    </th>
                  ))}
                  <th className="text-left text-xs text-slate-400 font-medium px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {sortedResults.map((r) => {
                  const st = STATUS_STYLES[r.status];
                  return (
                    <tr
                      key={r.matrikelnr + r.ejerlavskode}
                      className="border-b border-white/5 hover:bg-white/[0.02]"
                    >
                      <td className="px-4 py-3 text-white font-mono text-xs">{r.matrikelnr}</td>
                      <td className="px-4 py-3 text-slate-300 text-xs max-w-xs truncate">
                        {r.adresserLabel}
                        {r.ejerforening && (
                          <span className="block text-slate-400 text-[10px] mt-0.5">
                            {r.ejerforening}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-white text-xs tabular-nums">
                        {r.totalEnheder}
                      </td>
                      <td className="px-4 py-3 text-white text-xs tabular-nums">{r.kundeAntal}</td>
                      <td className="px-4 py-3 text-white text-xs font-bold tabular-nums">
                        {Math.round(r.daekningPct)}%
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full ${st.bg} ${st.text} border ${st.border}`}
                        >
                          {r.status === 'red' && <AlertTriangle size={9} />}
                          {r.status === 'yellow' && <MinusCircle size={9} />}
                          {r.status === 'green' && <CheckCircle2 size={9} />}
                          {STATUS_LABELS[r.status][lang]}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {analysed && results.length === 0 && !error && (
        <div className="text-center py-12 text-slate-400">
          <MapPin size={32} className="mx-auto mb-3 opacity-50" />
          <p className="text-sm">
            {da
              ? 'Ingen matrikler fundet for de uploadede adresser.'
              : 'No cadastres found for the uploaded addresses.'}
          </p>
        </div>
      )}
    </div>
  );
}
