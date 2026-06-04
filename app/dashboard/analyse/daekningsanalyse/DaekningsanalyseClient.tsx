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

import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import {
  Upload,
  FileSpreadsheet,
  X,
  Loader2,
  Download,
  MapPin,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  MinusCircle,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { useLanguage } from '@/app/context/LanguageContext';
import { createClient } from '@/lib/supabase/client';

// ─── Lazy Mapbox ────────────────────────────────────────────────────────────

const DaekningsMap = dynamic(() => import('./DaekningsMap'), { ssr: false });

// ─── Types ──────────────────────────────────────────────────────────────────

/** Result per matrikel from the resolve API */
/** GeoJSON geometry from DAWA jordstykke */
type GeoJsonGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon;

/** Result per matrikel from the resolve API */
interface MatrikelResult {
  matrikelnr: string;
  ejerlavskode: number;
  ejerlav: string;
  totalEnheder: number;
  kundeAntal: number;
  daekningPct: number;
  koordinat: { lat: number; lng: number } | null;
  geometry: GeoJsonGeometry | null;
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
/**
 * Classify coverage based on configurable thresholds.
 *
 * @param pct - Actual coverage percentage (0-100)
 * @param redMax - Below this % = red
 * @param greenMin - Below this % = yellow, above = green
 * @returns 'red' | 'yellow' | 'green'
 */
/**
 * Classify coverage: red below redMax, green at/above greenMin,
 * yellow in between (only if there's a gap).
 *
 * @param pct - Actual coverage percentage (0-100)
 * @param redMax - Below this = red
 * @param greenMin - At or above this = green. If equal to redMax, no yellow zone.
 * @returns 'red' | 'yellow' | 'green'
 */
function classifyCoverage(
  pct: number,
  redMax: number,
  greenMin: number
): 'red' | 'yellow' | 'green' {
  if (pct < redMax) return 'red';
  if (pct >= greenMin) return 'green';
  return 'yellow';
}

/** Status badge colors */
const STATUS_STYLES = {
  red: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/30' },
  yellow: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/30' },
  green: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/30' },
} as const;

const STATUS_LABELS = {
  red: { da: 'Rød', en: 'Red' },
  yellow: { da: 'Gul', en: 'Yellow' },
  green: { da: 'Grøn', en: 'Green' },
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

  // Threshold config (BIZZ-1999) — red max and green min; yellow is the gap
  // Persisted in Supabase user_metadata.daekningsanalyse_thresholds
  const [redMax, setRedMaxState] = useState(20);
  const [greenMin, setGreenMinState] = useState(40);
  const thresholdSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Load thresholds from user_metadata on mount */
  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const prefs = user?.user_metadata?.daekningsanalyse_thresholds as
        | { redMax?: number; greenMin?: number }
        | undefined;
      if (prefs) {
        if (typeof prefs.redMax === 'number') setRedMaxState(prefs.redMax);
        if (typeof prefs.greenMin === 'number') setGreenMinState(prefs.greenMin);
      }
    })();
  }, []);

  /** Save thresholds to user_metadata (debounced 1s) */
  const persistThresholds = useCallback((red: number, green: number) => {
    if (thresholdSaveTimer.current) clearTimeout(thresholdSaveTimer.current);
    thresholdSaveTimer.current = setTimeout(() => {
      createClient().auth.updateUser({
        data: { daekningsanalyse_thresholds: { redMax: red, greenMin: green } },
      });
    }, 1000);
  }, []);

  /** Set red threshold and persist */
  const setRedMax = useCallback(
    (v: number) => {
      setRedMaxState(v);
      persistThresholds(v, greenMin);
    },
    [greenMin, persistThresholds]
  );

  /** Set green threshold and persist */
  const setGreenMin = useCallback(
    (v: number) => {
      setGreenMinState(v);
      persistThresholds(redMax, v);
    },
    [redMax, persistThresholds]
  );

  // Table sorting
  const [sortKey, setSortKey] = useState<SortKey>('daekningPct');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  // Dragging state
  const [dragging, setDragging] = useState(false);

  // Sidebar state for results view
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(750);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);

  /** Global drag handlers for sidebar resize — active only while resizing */
  useEffect(() => {
    if (!resizing) return;
    function onMove(e: MouseEvent) {
      if (!resizeStart.current) return;
      const delta = e.clientX - resizeStart.current.x;
      const newWidth = Math.min(1400, Math.max(300, resizeStart.current.width + delta));
      setSidebarWidth(newWidth);
    }
    function onUp() {
      setResizing(false);
      resizeStart.current = null;
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizing]);

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
        status: classifyCoverage(r.daekningPct, redMax, greenMin),
      })),
    [results, redMax, greenMin]
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
      { header: da ? 'Adresse(r)' : 'Address(es)', key: 'addr', width: 45 },
      { header: da ? 'Total antal adresser' : 'Total addresses', key: 'total', width: 18 },
      { header: da ? 'Antal kunder' : 'Customers', key: 'kunder', width: 14 },
      { header: da ? 'Dækning %' : 'Coverage %', key: 'pct', width: 12 },
      { header: da ? 'Ejerforening' : 'Association', key: 'ejf', width: 30 },
      { header: 'Status', key: 'status', width: 12 },
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

  // ── Full-screen map mode when results are shown ──
  if (analysed && results.length > 0) {
    return (
      <div className={`absolute inset-0 flex${resizing ? ' select-none' : ''}`}>
        {/* Sidebar — table + controls */}
        <div
          className="relative flex-shrink-0 h-full transition-all duration-200"
          style={{ width: sidebarOpen ? sidebarWidth : 0 }}
        >
          {sidebarOpen && (
            <div className="absolute inset-0 bg-[#0f172a] border-r border-white/10 flex flex-col overflow-hidden z-10">
              {/* Sidebar header */}
              <div className="px-4 pt-4 pb-2 flex-shrink-0">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-lg font-bold text-white">
                    {da ? 'Dækningsanalyse' : 'Coverage Analysis'}
                  </h2>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={reset}
                      className="text-xs text-slate-400 hover:text-white transition-colors"
                    >
                      {da ? '← Ny analyse' : '← New analysis'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSidebarOpen(false)}
                      className="text-slate-400 hover:text-white transition-colors p-1"
                      aria-label={da ? 'Skjul panel' : 'Hide panel'}
                    >
                      <ChevronLeft size={14} />
                    </button>
                  </div>
                </div>

                {/* Threshold sliders — grøn (top), rød (bottom); gul = gap */}
                <div className="bg-[#1e293b] border border-white/10 rounded-lg p-3 mb-3 space-y-2">
                  <label className="flex items-center gap-2">
                    <span className="text-xs text-emerald-400 w-8">{da ? 'Grøn' : 'Green'}</span>
                    <span className="text-[10px] text-slate-400">≥</span>
                    <input
                      type="range"
                      min={redMax}
                      max={80}
                      value={greenMin}
                      onChange={(e) => setGreenMin(Number(e.target.value))}
                      className="flex-1 accent-blue-500"
                    />
                    <span className="text-xs font-bold text-white w-10 text-right">
                      {greenMin}%
                    </span>
                  </label>
                  <label className="flex items-center gap-2">
                    <span className="text-xs text-red-400 w-8">{da ? 'Rød' : 'Red'}</span>
                    <span className="text-[10px] text-slate-400">&lt;</span>
                    <input
                      type="range"
                      min={5}
                      max={greenMin}
                      value={redMax}
                      onChange={(e) => setRedMax(Number(e.target.value))}
                      className="flex-1 accent-blue-500"
                    />
                    <span className="text-xs font-bold text-white w-10 text-right">{redMax}%</span>
                  </label>
                  <p className="text-[10px] text-slate-400">
                    {redMax === greenMin
                      ? da
                        ? `Rød: <${redMax}% · Grøn: ≥${greenMin}%`
                        : `Red: <${redMax}% · Green: ≥${greenMin}%`
                      : da
                        ? `Rød: <${redMax}% · Gul: ${redMax}-${greenMin}% · Grøn: ≥${greenMin}%`
                        : `Red: <${redMax}% · Yellow: ${redMax}-${greenMin}% · Green: ≥${greenMin}%`}
                  </p>
                </div>

                {/* Badges + filter + export */}
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-400">
                    <AlertTriangle size={9} /> {redCount}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400">
                    <MinusCircle size={9} /> {yellowCount}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400">
                    <CheckCircle2 size={9} /> {greenCount}
                  </span>
                  <div className="flex items-center gap-1 ml-auto">
                    {(['all', 'red', 'yellow', 'green'] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setStatusFilter(f)}
                        className={`text-[10px] px-1.5 py-0.5 rounded-full transition-colors ${
                          statusFilter === f
                            ? 'bg-blue-600 text-white'
                            : 'bg-white/5 text-slate-400 hover:text-white'
                        }`}
                      >
                        {f === 'all'
                          ? da
                            ? 'Alle'
                            : 'All'
                          : f === 'red'
                            ? '!'
                            : f === 'yellow'
                              ? '~'
                              : '✓'}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={exportExcel}
                      className="inline-flex items-center gap-1 text-[10px] text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 px-2 py-0.5 rounded-full transition-colors ml-1"
                    >
                      <Download size={9} /> Excel
                    </button>
                  </div>
                </div>
              </div>

              {/* Table — scrollable */}
              <div className="flex-1 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-[#0f172a] z-10">
                    <tr className="border-b border-white/10">
                      {(
                        [
                          ['matrikelnr', da ? 'Matrikel' : 'Cadastre'],
                          ['adresserLabel', da ? 'Adresse(r)' : 'Address(es)'],
                          ['totalEnheder', da ? 'Total adresser' : 'Total addr.'],
                          ['kundeAntal', da ? 'Antal kunder' : 'Customers'],
                          ['daekningPct', '%'],
                        ] as [SortKey, string][]
                      ).map(([key, label]) => (
                        <th
                          key={key}
                          onClick={() => toggleSort(key)}
                          className="text-left text-[10px] text-slate-400 font-medium px-2 py-2 cursor-pointer hover:text-white transition-colors select-none whitespace-nowrap"
                        >
                          {label}
                          <SortIcon col={key} />
                        </th>
                      ))}
                      <th className="text-left text-[10px] text-slate-400 font-medium px-2 py-2">
                        {da ? 'Ejerforening' : 'Association'}
                      </th>
                      <th className="text-left text-[10px] text-slate-400 font-medium px-2 py-2">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedResults.map((r) => {
                      const st = STATUS_STYLES[r.status];
                      return (
                        <tr
                          key={r.matrikelnr + r.ejerlavskode}
                          className="border-b border-white/5 hover:bg-white/[0.03]"
                        >
                          <td className="px-2 py-1.5 text-white font-mono">{r.matrikelnr}</td>
                          <td className="px-2 py-1.5 text-slate-300 max-w-[180px]">
                            <div className="text-xs leading-relaxed whitespace-pre-line">
                              {r.adresserLabel}
                            </div>
                          </td>
                          <td className="px-2 py-1.5 text-white tabular-nums">{r.totalEnheder}</td>
                          <td className="px-2 py-1.5 text-white tabular-nums">{r.kundeAntal}</td>
                          <td className="px-2 py-1.5 text-white font-bold tabular-nums">
                            {Math.round(r.daekningPct)}%
                          </td>
                          <td className="px-2 py-1.5 text-slate-400 text-[10px] italic">
                            {r.ejerforening || '—'}
                          </td>
                          <td className="px-2 py-1.5">
                            <span
                              className={`inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full ${st.bg} ${st.text} border ${st.border} whitespace-nowrap`}
                            >
                              {r.status === 'red' && <AlertTriangle size={7} />}
                              {r.status === 'yellow' && <MinusCircle size={7} />}
                              {r.status === 'green' && <CheckCircle2 size={7} />}
                              {STATUS_LABELS[r.status][lang]}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Sticky footer — summary bar */}
              <div className="flex-shrink-0 border-t border-white/10 px-4 py-2 bg-[#0f172a]">
                <div className="flex items-center justify-between text-[10px] text-slate-400">
                  <span>
                    {da
                      ? `Viser ${sortedResults.length} af ${classified.length} matrikler`
                      : `Showing ${sortedResults.length} of ${classified.length} cadastres`}
                  </span>
                  <span className="tabular-nums">
                    {classified.reduce((s, r) => s + r.kundeAntal, 0)} /{' '}
                    {classified.reduce((s, r) => s + r.totalEnheder, 0)} (
                    {classified.length > 0
                      ? Math.round(
                          (classified.reduce((s, r) => s + r.kundeAntal, 0) /
                            Math.max(
                              1,
                              classified.reduce((s, r) => s + r.totalEnheder, 0)
                            )) *
                            100
                        )
                      : 0}
                    % {da ? 'samlet' : 'total'})
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Resize handle + toggle */}
        {sidebarOpen && (
          <div
            className={`w-1.5 flex-shrink-0 cursor-col-resize flex items-center justify-center group transition-colors ${resizing ? 'bg-blue-500/30' : 'bg-slate-800 hover:bg-blue-500/20'}`}
            onMouseDown={(e) => {
              e.preventDefault();
              resizeStart.current = { x: e.clientX, width: sidebarWidth };
              setResizing(true);
            }}
          >
            <div
              className={`w-0.5 h-10 rounded-full transition-colors ${resizing ? 'bg-blue-400' : 'bg-slate-600 group-hover:bg-blue-400'}`}
            />
          </div>
        )}
        {!sidebarOpen && (
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="absolute top-1/2 -translate-y-1/2 left-0 z-20 bg-[#1e293b] border border-white/10 rounded-r-lg px-1 py-3 text-slate-400 hover:text-white transition-colors"
            aria-label="Vis panel"
          >
            <ChevronRight size={14} />
          </button>
        )}

        {/* Map — full remaining space */}
        <div className="flex-1 min-w-0 relative">
          <DaekningsMap results={classified} />
        </div>
      </div>
    );
  }

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

      {/* Threshold config (BIZZ-1999) — grøn (top), rød (bottom); gul = gap */}
      <div className="bg-[#1e293b] border border-white/10 rounded-xl p-4 space-y-3">
        <p className="text-sm font-medium text-white">
          {da ? 'Dækningsgrænser' : 'Coverage thresholds'}
        </p>
        <label className="flex items-center gap-3">
          <span className="text-sm text-emerald-400 w-10">{da ? 'Grøn' : 'Green'}</span>
          <span className="text-xs text-slate-400">≥</span>
          <input
            type="range"
            min={redMax}
            max={80}
            value={greenMin}
            onChange={(e) => setGreenMin(Number(e.target.value))}
            className="flex-1 accent-blue-500"
          />
          <span className="text-sm font-bold text-white w-12 text-right">{greenMin}%</span>
        </label>
        <label className="flex items-center gap-3">
          <span className="text-sm text-red-400 w-10">{da ? 'Rød' : 'Red'}</span>
          <span className="text-xs text-slate-400">&lt;</span>
          <input
            type="range"
            min={5}
            max={greenMin}
            value={redMax}
            onChange={(e) => setRedMax(Number(e.target.value))}
            className="flex-1 accent-blue-500"
          />
          <span className="text-sm font-bold text-white w-12 text-right">{redMax}%</span>
        </label>
        <p className="text-xs text-slate-400">
          {redMax === greenMin
            ? da
              ? `Rød: <${redMax}% · Grøn: ≥${greenMin}%`
              : `Red: <${redMax}% · Green: ≥${greenMin}%`
            : da
              ? `Rød: <${redMax}% · Gul: ${redMax}-${greenMin}% · Grøn: ≥${greenMin}%`
              : `Red: <${redMax}% · Yellow: ${redMax}-${greenMin}% · Green: ≥${greenMin}%`}
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
