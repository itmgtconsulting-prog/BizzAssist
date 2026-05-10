/**
 * PivotExplorerClient — manuel data explorer med FINOS Perspective.
 *
 * BIZZ-1260: Bruger vælger tabel → kolonner → filtre → data indlæses
 * i Perspective pivot-viewer med drag-and-drop gruppering, filtrering,
 * sortering og visualiseringer (datagrid, bar, line, scatter, treemap).
 *
 * Ingen AI involveret — direkte PostgREST-kald via /api/analyse/pivot.
 *
 * @module app/dashboard/analyse/pivot/PivotExplorerClient
 */

'use client';

import { useState, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { LayoutGrid, Loader2, ChevronLeft, Plus, Trash2, Download } from 'lucide-react';
import { WHITELISTED_TABLES } from '@/app/lib/analyseQueryWhitelist';

/** BIZZ-1260: Perspective loaded dynamisk (WebAssembly kræver browser) */
const PerspectiveViewer = dynamic(() => import('@/app/components/analyse/PerspectiveViewer'), {
  ssr: false,
  loading: () => <div className="h-[600px] bg-slate-800/50 rounded-lg animate-pulse" />,
});

/** Lokalt filter-objekt for UI state */
interface FilterRow {
  id: number;
  column: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'is';
  value: string;
}

/** Operator labels til dropdown */
const OPERATOR_OPTIONS: { value: FilterRow['operator']; label: string }[] = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'gt', label: '>' },
  { value: 'lt', label: '<' },
  { value: 'gte', label: '≥' },
  { value: 'lte', label: '≤' },
  { value: 'is', label: 'er (null/true/false)' },
];

let filterId = 0;

export default function PivotExplorerClient() {
  const [selectedTable, setSelectedTable] = useState('');
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Record<string, unknown>[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);

  /** Find den valgte tabels kolonnedefinitioner */
  const tableDef = WHITELISTED_TABLES.find((t) => t.table === selectedTable);

  /** Memoisér kolonner så useCallback-deps er stabile */
  const availableColumns = useMemo(
    () => (tableDef ? Object.entries(tableDef.columns) : []),
    [tableDef]
  );

  /**
   * Håndtér tabelskift — nulstil kolonner, filtre og data.
   *
   * @param table - Valgt tabelnavn
   */
  const handleTableChange = useCallback((table: string) => {
    setSelectedTable(table);
    setSelectedColumns(new Set());
    setFilters([]);
    setData(null);
    setError(null);
  }, []);

  /**
   * Toggle en kolonne i/ud af selection.
   *
   * @param col - Kolonnenavn
   */
  const toggleColumn = useCallback((col: string) => {
    setSelectedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(col)) {
        next.delete(col);
      } else {
        next.add(col);
      }
      return next;
    });
  }, []);

  /** Vælg alle kolonner */
  const selectAllColumns = useCallback(() => {
    if (!tableDef) return;
    setSelectedColumns(new Set(Object.keys(tableDef.columns)));
  }, [tableDef]);

  /** Fravælg alle kolonner */
  const deselectAllColumns = useCallback(() => {
    setSelectedColumns(new Set());
  }, []);

  /** Tilføj et nyt filter */
  const addFilter = useCallback(() => {
    if (!availableColumns.length) return;
    setFilters((prev) => [
      ...prev,
      { id: ++filterId, column: availableColumns[0][0], operator: 'eq', value: '' },
    ]);
  }, [availableColumns]);

  /** Fjern et filter */
  const removeFilter = useCallback((id: number) => {
    setFilters((prev) => prev.filter((f) => f.id !== id));
  }, []);

  /** Opdatér et filter-felt */
  const updateFilter = useCallback((id: number, field: keyof FilterRow, value: string) => {
    setFilters((prev) => prev.map((f) => (f.id === id ? { ...f, [field]: value } : f)));
  }, []);

  /**
   * Hent data fra /api/analyse/pivot og indlæs i Perspective.
   */
  const loadData = useCallback(async () => {
    if (!selectedTable) return;
    setLoading(true);
    setError(null);
    setData(null);

    try {
      const cols = selectedColumns.size > 0 ? [...selectedColumns] : undefined;
      const validFilters = filters.filter((f) => f.value.trim() !== '');

      const res = await fetch('/api/analyse/pivot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          table: selectedTable,
          columns: cols,
          filters: validFilters.map(({ column, operator, value }) => ({
            column,
            operator,
            value,
          })),
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: 'Ukendt fejl' }));
        setError((errBody as { error?: string }).error ?? `HTTP ${res.status}`);
        return;
      }

      const result = (await res.json()) as {
        rows: Record<string, unknown>[];
        totalCount: number;
      };

      if (result.rows.length === 0) {
        setError('Ingen rækker fundet med de valgte filtre');
        return;
      }

      setData(result.rows);
      setTotalCount(result.totalCount);
    } catch {
      setError('Netværksfejl — prøv igen');
    } finally {
      setLoading(false);
    }
  }, [selectedTable, selectedColumns, filters]);

  /**
   * Eksportér data som CSV-fil.
   */
  const exportCsv = useCallback(() => {
    if (!data || data.length === 0) return;
    const keys = Object.keys(data[0]);
    const header = keys.join(';');
    const rows = data.map((row) =>
      keys
        .map((k) => {
          const v = row[k];
          if (v === null || v === undefined) return '';
          const s = String(v);
          /* Escapér semikolon og linjeskift */
          return s.includes(';') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(';')
    );
    const csv = [header, ...rows].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pivot-${selectedTable.split('.').pop()}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data, selectedTable]);

  return (
    <div className="flex-1 bg-[#0a1628] p-6 space-y-6 overflow-y-auto">
      {/* ── Header ── */}
      <div>
        <Link
          href="/dashboard/analyse"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors mb-3"
        >
          <ChevronLeft size={14} />
          Analyse & Tools
        </Link>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <LayoutGrid size={20} className="text-emerald-400" />
          Pivot Analyse
        </h1>
        <p className="text-slate-400 text-sm mt-1">
          Vælg en datakilde, kolonner og filtre — udforsk data med drag-and-drop pivot-tabeller og
          grafer.
        </p>
      </div>

      {/* ── Konfiguration ── */}
      <div className="bg-slate-800/30 border border-slate-700/30 rounded-xl p-5 space-y-5">
        {/* Tabel-valg */}
        <div>
          <label
            htmlFor="pivot-table-select"
            className="block text-xs font-medium text-slate-400 mb-1.5"
          >
            Datakilde
          </label>
          <select
            id="pivot-table-select"
            value={selectedTable}
            onChange={(e) => handleTableChange(e.target.value)}
            className="w-full max-w-md px-3 py-2 bg-slate-800/60 border border-slate-700/50 rounded-lg text-white text-sm focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/25"
          >
            <option value="">Vælg tabel...</option>
            {WHITELISTED_TABLES.map((t) => (
              <option key={t.table} value={t.table}>
                {t.table.split('.')[1]} — {t.description.slice(0, 60)}
              </option>
            ))}
          </select>
        </div>

        {/* Kolonne-valg */}
        {tableDef && (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-slate-400">
                Kolonner ({selectedColumns.size}/{availableColumns.length} valgt)
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={selectAllColumns}
                  className="text-[10px] text-emerald-400 hover:text-emerald-300 transition-colors"
                >
                  Vælg alle
                </button>
                <button
                  type="button"
                  onClick={deselectAllColumns}
                  className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
                >
                  Fravælg alle
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {availableColumns.map(([col, meta]) => (
                <button
                  key={col}
                  type="button"
                  onClick={() => toggleColumn(col)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-all ${
                    selectedColumns.has(col)
                      ? 'bg-emerald-600/20 border border-emerald-500/40 text-emerald-300'
                      : 'bg-slate-800/40 border border-slate-700/30 text-slate-500 hover:text-slate-300'
                  }`}
                  title={meta.description}
                >
                  <span>{col}</span>
                  <span className="text-[9px] text-slate-600">{meta.type}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Filtre */}
        {tableDef && (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-slate-400">
                Filtre ({filters.length})
              </label>
              <button
                type="button"
                onClick={addFilter}
                className="inline-flex items-center gap-1 text-[10px] text-emerald-400 hover:text-emerald-300 transition-colors"
              >
                <Plus size={10} />
                Tilføj filter
              </button>
            </div>

            {filters.length > 0 && (
              <div className="space-y-2">
                {filters.map((f) => (
                  <div key={f.id} className="flex items-center gap-2 flex-wrap">
                    {/* Kolonne */}
                    <select
                      value={f.column}
                      onChange={(e) => updateFilter(f.id, 'column', e.target.value)}
                      aria-label="Filterkolonne"
                      className="px-2 py-1.5 bg-slate-800/60 border border-slate-700/50 rounded-lg text-white text-xs focus:outline-none focus:border-emerald-500/50"
                    >
                      {availableColumns.map(([col]) => (
                        <option key={col} value={col}>
                          {col}
                        </option>
                      ))}
                    </select>

                    {/* Operator */}
                    <select
                      value={f.operator}
                      onChange={(e) => updateFilter(f.id, 'operator', e.target.value)}
                      aria-label="Filteroperator"
                      className="px-2 py-1.5 bg-slate-800/60 border border-slate-700/50 rounded-lg text-white text-xs focus:outline-none focus:border-emerald-500/50"
                    >
                      {OPERATOR_OPTIONS.map((op) => (
                        <option key={op.value} value={op.value}>
                          {op.label}
                        </option>
                      ))}
                    </select>

                    {/* Værdi */}
                    <input
                      type="text"
                      value={f.value}
                      onChange={(e) => updateFilter(f.id, 'value', e.target.value)}
                      placeholder="Værdi..."
                      aria-label="Filterværdi"
                      className="flex-1 min-w-[120px] px-2 py-1.5 bg-slate-800/60 border border-slate-700/50 rounded-lg text-white text-xs placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50"
                    />

                    {/* Slet */}
                    <button
                      type="button"
                      onClick={() => removeFilter(f.id)}
                      aria-label="Fjern filter"
                      className="p-1.5 text-slate-500 hover:text-red-400 transition-colors"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Indlæs-knap */}
        {tableDef && (
          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={loadData}
              disabled={loading}
              className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <LayoutGrid size={14} />}
              Indlæs data
            </button>

            {data && (
              <button
                type="button"
                onClick={exportCsv}
                className="px-4 py-2 bg-slate-700/50 hover:bg-slate-700 text-slate-300 rounded-lg text-sm transition-colors flex items-center gap-2"
              >
                <Download size={14} />
                Eksportér CSV
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Error ── */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* ── Resultat-info ── */}
      {data && (
        <div className="bg-slate-800/40 border border-slate-700/30 rounded-lg px-4 py-2.5 flex items-center justify-between">
          <p className="text-slate-400 text-xs">
            {data.length.toLocaleString('da-DK')} rækker indlæst
            {totalCount > data.length && (
              <span className="text-slate-500">
                {' '}
                (af {totalCount.toLocaleString('da-DK')} totalt — maks 10.000 vist)
              </span>
            )}
          </p>
          <p className="text-slate-500 text-[10px]">
            Træk kolonner til gruppering, filtrering og sortering i pivot-tabellen nedenfor
          </p>
        </div>
      )}

      {/* ── Perspective Pivot Viewer ── */}
      {data && data.length > 0 && <PerspectiveViewer data={data} plugin="Datagrid" height={600} />}
    </div>
  );
}
