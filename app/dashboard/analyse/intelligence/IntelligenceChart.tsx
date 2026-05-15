/**
 * IntelligenceChart — Auto-detect chart for Data Intelligence results.
 *
 * Analyserer kolonnetyper og vælger automatisk den bedste chart-type:
 *   - Bar chart: kategori + tal (fx branche → antal)
 *   - Pie chart: kategori + tal med <= 10 rækker
 *   - Line chart: dato/tid + tal (fx måned → antal)
 *
 * Lazy-loaded via next/dynamic med ssr: false.
 *
 * @module app/dashboard/analyse/intelligence/IntelligenceChart
 */

'use client';

import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  CartesianGrid,
  Legend,
} from 'recharts';

interface Props {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

type ChartType = 'bar' | 'pie' | 'line' | 'none';

/** Emerald-baserede farver til pie/bar charts. */
const COLORS = [
  '#10b981',
  '#06b6d4',
  '#8b5cf6',
  '#f59e0b',
  '#ef4444',
  '#ec4899',
  '#6366f1',
  '#14b8a6',
  '#f97316',
  '#84cc16',
  '#a855f7',
  '#22d3ee',
  '#e11d48',
  '#0ea5e9',
  '#d946ef',
];

/** Dansk talformatering til tooltip. */
function formatNumber(v: unknown): string {
  if (typeof v === 'number') return v.toLocaleString('da-DK');
  return String(v ?? '');
}

/**
 * Detect om en kolonne er numerisk baseret på de første rækker.
 */
function isNumeric(rows: Array<Record<string, unknown>>, col: string): boolean {
  let numCount = 0;
  const sample = rows.slice(0, 20);
  for (const row of sample) {
    const v = row[col];
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') numCount++;
  }
  return numCount > sample.length * 0.5;
}

/**
 * Detect om en kolonne indeholder dato/tid-værdier.
 */
function isTemporal(rows: Array<Record<string, unknown>>, col: string): boolean {
  const sample = rows.slice(0, 10);
  let dateCount = 0;
  for (const row of sample) {
    const v = String(row[col] ?? '');
    if (/^\d{4}-\d{2}(-\d{2})?/.test(v)) dateCount++;
  }
  return dateCount > sample.length * 0.5;
}

/**
 * Auto-detect den bedste chart-type baseret på kolonne-typer.
 */
function detectChartType(
  columns: string[],
  rows: Array<Record<string, unknown>>
): { type: ChartType; labelCol: string; valueCol: string } {
  if (columns.length < 2 || rows.length === 0) {
    return { type: 'none', labelCol: '', valueCol: '' };
  }

  // Find label og value kolonner
  const numericCols = columns.filter((c) => isNumeric(rows, c));
  const nonNumericCols = columns.filter((c) => !isNumeric(rows, c));

  if (numericCols.length === 0 || nonNumericCols.length === 0) {
    // Hvis alle er numeriske, brug første som label
    if (numericCols.length >= 2) {
      return { type: 'bar', labelCol: numericCols[0], valueCol: numericCols[1] };
    }
    return { type: 'none', labelCol: '', valueCol: '' };
  }

  const labelCol = nonNumericCols[0];
  const valueCol = numericCols[0];

  // Dato-kolonne → line chart
  if (isTemporal(rows, labelCol)) {
    return { type: 'line', labelCol, valueCol };
  }

  // Få rækker → pie chart
  if (rows.length <= 10 && rows.length >= 2) {
    return { type: 'pie', labelCol, valueCol };
  }

  // Default → bar chart
  return { type: 'bar', labelCol, valueCol };
}

/**
 * Custom tooltip-komponent til Recharts.
 */
function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; name: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm shadow-lg">
      <p className="text-slate-300 font-medium">{label}</p>
      {payload.map((entry, i) => (
        <p key={i} className="text-emerald-300">
          {entry.name}: {formatNumber(entry.value)}
        </p>
      ))}
    </div>
  );
}

/**
 * IntelligenceChart — auto-detected chart for query results.
 */
export default function IntelligenceChart({ columns, rows }: Props): React.ReactElement | null {
  const { type, labelCol, valueCol } = useMemo(
    () => detectChartType(columns, rows),
    [columns, rows]
  );

  /** Chart data med numerisk cast. */
  const chartData = useMemo(() => {
    const maxRows = type === 'pie' ? 10 : 30;
    return rows.slice(0, maxRows).map((row) => ({
      label: String(row[labelCol] ?? ''),
      value: Number(row[valueCol]) || 0,
    }));
  }, [rows, labelCol, valueCol, type]);

  if (type === 'none' || chartData.length === 0) return null;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <ResponsiveContainer width="100%" height={320}>
        {type === 'pie' ? (
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              outerRadius={120}
              dataKey="value"
              nameKey="label"
              label={({ label, percent }) =>
                `${String(label).slice(0, 20)} (${(percent * 100).toFixed(0)}%)`
              }
              labelLine={false}
            >
              {chartData.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} formatter={(v: number) => formatNumber(v)} />
            <Legend
              formatter={(value: string) => <span className="text-slate-300 text-xs">{value}</span>}
            />
          </PieChart>
        ) : type === 'line' ? (
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis dataKey="label" stroke="#94a3b8" fontSize={11} tick={{ fill: '#94a3b8' }} />
            <YAxis
              stroke="#94a3b8"
              fontSize={11}
              tick={{ fill: '#94a3b8' }}
              tickFormatter={(v: number) => formatNumber(v)}
            />
            <Tooltip content={<CustomTooltip />} />
            <Line
              type="monotone"
              dataKey="value"
              stroke="#10b981"
              strokeWidth={2}
              dot={{ fill: '#10b981', r: 4 }}
              name={valueCol}
            />
          </LineChart>
        ) : (
          <BarChart data={chartData} layout="vertical" margin={{ left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
            <XAxis
              type="number"
              stroke="#94a3b8"
              fontSize={11}
              tick={{ fill: '#94a3b8' }}
              tickFormatter={(v: number) => formatNumber(v)}
            />
            <YAxis
              type="category"
              dataKey="label"
              stroke="#94a3b8"
              fontSize={11}
              width={150}
              tick={{ fill: '#94a3b8' }}
              tickFormatter={(v: string) => (v.length > 25 ? v.slice(0, 22) + '…' : v)}
            />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="value" fill="#10b981" radius={[0, 4, 4, 0]} name={valueCol} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
