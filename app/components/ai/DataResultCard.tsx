/**
 * DataResultCard — renderer DI-resultater inline i AI Chat.
 *
 * BIZZ-1699: Viser data_intelligence tool-resultater som:
 *   - Tabel (sortérbar, max 20 rækker, "vis alle" knap)
 *   - Stort nøgletal (chart_type=number)
 *   - Placeholder for graf (chart_type=bar/line/pie — Recharts deferred)
 *
 * @module app/components/ai/DataResultCard
 */

'use client';

import { useState, useMemo } from 'react';
import { Table2, Download, ChevronDown, BarChart3 } from 'lucide-react';

interface DataResultCardProps {
  /** Kolonne-navne */
  columns: string[];
  /** Data-rækker (array af arrays) */
  rows: unknown[][];
  /** Totalt antal rækker (kan være > rows.length hvis afkortet) */
  rowCount: number;
  /** Visualiseringstype */
  chartType?: 'table' | 'bar' | 'line' | 'pie' | 'number';
  /** Om data er afkortet */
  afkortet?: boolean;
}

/**
 * Formatér en celle-værdi til visning.
 */
/**
 * BIZZ-1766: Formatér en celle-værdi med da-DK locale og enhed baseret på kolonnenavn.
 */
function formatCell(val: unknown, colName?: string): string {
  if (val == null) return '–';
  if (typeof val === 'number') {
    const col = (colName ?? '').toLowerCase();
    // Detect currency columns
    const isCurrency =
      col.includes('koebesum') ||
      col.includes('pris') ||
      col.includes('vaerdi') ||
      col.includes('grundskyld') ||
      col.includes('omsaetning') ||
      col.includes('dkk') ||
      col.includes('hovedstol') ||
      col.includes('beloeb');
    // Detect percentage columns
    const isPct =
      col.includes('pct') ||
      col.includes('rate') ||
      col.includes('andel') ||
      col.includes('procent');
    // Detect area columns
    const isArea = col.includes('areal') || col.includes('m2');

    const formatted = val.toLocaleString('da-DK', {
      maximumFractionDigits: Number.isInteger(val) ? 0 : 2,
    });

    if (isCurrency) return `${formatted} kr`;
    if (isPct) return `${formatted}%`;
    if (isArea) return `${formatted} m²`;
    return formatted;
  }
  return String(val);
}

/**
 * Humanisér kolonnenavn: snake_case → Title Case.
 */
function humanizeCol(col: string): string {
  return col
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/Bfe/g, 'BFE')
    .replace(/Cvr/g, 'CVR')
    .replace(/Dkk/g, 'DKK');
}

/**
 * Eksporter data som CSV og trigger download.
 */
function downloadCSV(columns: string[], rows: unknown[][]): void {
  const header = columns.join(';');
  const body = rows.map((r) => r.map((c) => (c == null ? '' : String(c))).join(';')).join('\n');
  const csv = '\uFEFF' + header + '\n' + body; // BOM for Excel
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bizzassist-data.csv';
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * DataResultCard — renderer DI-resultater inline i AI Chat.
 */
export default function DataResultCard({
  columns,
  rows,
  rowCount,
  chartType = 'table',
  afkortet = false,
}: DataResultCardProps) {
  const [showAll, setShowAll] = useState(false);
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortAsc, setSortAsc] = useState(true);

  const visibleRows = useMemo(() => {
    const sorted = [...rows];
    if (sortCol !== null) {
      sorted.sort((a, b) => {
        const va = a[sortCol];
        const vb = b[sortCol];
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        if (typeof va === 'number' && typeof vb === 'number') {
          return sortAsc ? va - vb : vb - va;
        }
        return sortAsc
          ? String(va).localeCompare(String(vb), 'da')
          : String(vb).localeCompare(String(va), 'da');
      });
    }
    // BIZZ-1768: Vis 50 rækker som default (var 20)
    return showAll ? sorted : sorted.slice(0, 50);
  }, [rows, showAll, sortCol, sortAsc]);

  // Nøgletal-visning (enkelt tal)
  if (chartType === 'number' && rows.length === 1 && columns.length <= 2) {
    const val = rows[0][columns.length - 1];
    const label = columns.length > 1 ? String(rows[0][0] ?? columns[0]) : humanizeCol(columns[0]);
    return (
      <div className="bg-slate-800/60 border border-slate-700/40 rounded-xl p-5 my-2 text-center">
        <p className="text-3xl font-bold text-white">{formatCell(val)}</p>
        <p className="text-slate-400 text-xs mt-1">{label}</p>
      </div>
    );
  }

  // Graf-placeholder
  if (chartType && ['bar', 'line', 'pie'].includes(chartType)) {
    return (
      <div className="bg-slate-800/60 border border-slate-700/40 rounded-xl p-4 my-2">
        <div className="flex items-center gap-2 mb-3">
          <BarChart3 size={14} className="text-blue-400" />
          <span className="text-xs text-slate-400">{rowCount} rækker</span>
          <button
            onClick={() => downloadCSV(columns, rows)}
            className="ml-auto text-[10px] text-slate-500 hover:text-slate-300 flex items-center gap-1"
          >
            <Download size={10} /> CSV
          </button>
        </div>
        {/* Fallback tabel — graf-komponent tilføjes i fremtidig iteration */}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 border-b border-slate-700/40">
                {columns.map((col, i) => (
                  <th key={i} className="px-2 py-1.5 text-left font-medium">
                    {humanizeCol(col)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/20">
              {visibleRows.map((row, ri) => (
                <tr key={ri} className="hover:bg-slate-700/20">
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-2 py-1.5 text-slate-300">
                      {formatCell(cell, columns[ci])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // Standard tabel
  return (
    <div className="bg-slate-800/60 border border-slate-700/40 rounded-xl p-3 my-2">
      <div className="flex items-center gap-2 mb-2">
        <Table2 size={13} className="text-emerald-400" />
        <span className="text-[10px] text-slate-500">
          {rowCount} {rowCount === 1 ? 'række' : 'rækker'}
          {afkortet ? ' (afkortet)' : ''}
        </span>
        <button
          onClick={() => downloadCSV(columns, rows)}
          className="ml-auto text-[10px] text-slate-500 hover:text-slate-300 flex items-center gap-1"
          aria-label="Download som CSV"
        >
          <Download size={10} /> CSV
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-slate-500 border-b border-slate-700/40">
              {columns.map((col, i) => (
                <th
                  key={i}
                  className="px-2 py-1.5 text-left font-medium cursor-pointer hover:text-slate-300"
                  onClick={() => {
                    if (sortCol === i) {
                      setSortAsc(!sortAsc);
                    } else {
                      setSortCol(i);
                      setSortAsc(true);
                    }
                  }}
                >
                  <span className="flex items-center gap-1">
                    {humanizeCol(col)}
                    {sortCol === i && (
                      <ChevronDown
                        size={10}
                        className={`transition-transform ${sortAsc ? '' : 'rotate-180'}`}
                      />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/20">
            {visibleRows.map((row, ri) => (
              <tr key={ri} className="hover:bg-slate-700/20">
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className={`px-2 py-1.5 ${typeof cell === 'number' ? 'text-right text-slate-200 font-mono' : 'text-slate-300'}`}
                  >
                    {formatCell(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 20 && !showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-2 text-[10px] text-blue-400 hover:text-blue-300"
        >
          Vis alle {rows.length} rækker
        </button>
      )}
    </div>
  );
}
