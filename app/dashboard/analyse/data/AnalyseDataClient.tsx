/**
 * AnalyseDataClient — AI Query Builder klient-komponent.
 *
 * BIZZ-1038: Bruger skriver forespørgsel på dansk → Claude genererer SQL →
 * resultatet vises som interaktiv graf (Recharts) + datatabel.
 *
 * Features:
 *  - Dansk query input med foreslåede forespørgsler
 *  - SSE streaming med status-updates
 *  - Auto-valg af graf-type (bar, line, pie, scatter, tabel)
 *  - Skifte mellem graf-typer
 *  - Datatabel med sortérbar header
 *  - SQL-visning (collapsible)
 *
 * @module app/dashboard/analyse/data/AnalyseDataClient
 */

'use client';

import { useState, useCallback, useRef } from 'react';
import {
  BarChart3,
  LineChart as LineChartIcon,
  PieChart as PieChartIcon,
  Table2,
  Search,
  Loader2,
  ChevronDown,
  ChevronRight,
  Code2,
  Sparkles,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ScatterChart,
  Scatter,
} from 'recharts';
import type { QueryResult, ColumnDef } from '@/app/api/analyse/query/route';

/** Farvepalette til grafer (dark theme venlig) */
const CHART_COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#84cc16',
  '#f97316',
  '#6366f1',
];

/** Foreslåede queries til hurtig start */
const SUGGESTED_QUERIES = [
  'Hvor mange ejendomme per kommune?',
  'Energimærkeklasse fordeling for alle ejendomme',
  'Gennemsnitligt boligareal per opførelsesår',
  'Top 20 kommuner efter antal ejendomme',
  'Ejendomme opført per årti (1900-2020)',
];

/**
 * Render interaktiv graf baseret på data og valgt graf-type.
 *
 * @param data - Array af datarækker
 * @param columns - Kolonnedefinitioner
 * @param chartType - Valgt graf-type
 */
function DataChart({
  data,
  columns,
  chartType,
}: {
  data: Record<string, unknown>[];
  columns: ColumnDef[];
  chartType: string;
}) {
  if (data.length === 0 || columns.length === 0) return null;

  /* Bestem x-akse (første kolonne) og y-akse (anden kolonne / numerisk) */
  const xKey = columns[0].key;
  const numericCols = columns.filter((c) => c.type === 'number');
  const yKey =
    numericCols.length > 0
      ? numericCols[0].key
      : columns.length > 1
        ? columns[1].key
        : columns[0].key;

  /* Formatér data — konverter strings til numbers hvor muligt */
  const chartData = data.slice(0, 100).map((row) => {
    const formatted: Record<string, unknown> = {};
    for (const col of columns) {
      const val = row[col.key];
      formatted[col.key] = typeof val === 'string' && !isNaN(Number(val)) ? Number(val) : val;
    }
    return formatted;
  });

  const commonProps = {
    data: chartData,
    margin: { top: 10, right: 30, left: 10, bottom: 30 },
  };

  if (chartType === 'pie') {
    return (
      <ResponsiveContainer width="100%" height={350}>
        <PieChart>
          <Pie
            data={chartData}
            dataKey={yKey}
            nameKey={xKey}
            cx="50%"
            cy="50%"
            outerRadius={120}
            label={({ name, percent }: { name?: string; percent?: number }) =>
              `${name ?? ''} (${((percent ?? 0) * 100).toFixed(0)}%)`
            }
          >
            {chartData.map((_, i) => (
              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '8px',
            }}
          />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === 'scatter') {
    const yKey2 = numericCols.length > 1 ? numericCols[1].key : yKey;
    return (
      <ResponsiveContainer width="100%" height={350}>
        <ScatterChart {...commonProps}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey={xKey} tick={{ fill: '#94a3b8', fontSize: 11 }} />
          <YAxis dataKey={yKey2} tick={{ fill: '#94a3b8', fontSize: 11 }} />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '8px',
            }}
          />
          <Scatter name={yKey2} fill={CHART_COLORS[0]} />
        </ScatterChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === 'line') {
    return (
      <ResponsiveContainer width="100%" height={350}>
        <LineChart {...commonProps}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis
            dataKey={xKey}
            tick={{ fill: '#94a3b8', fontSize: 11 }}
            angle={-30}
            textAnchor="end"
          />
          <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '8px',
            }}
          />
          <Legend />
          {numericCols.map((col, i) => (
            <Line
              key={col.key}
              type="monotone"
              dataKey={col.key}
              stroke={CHART_COLORS[i % CHART_COLORS.length]}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  /* Default: bar chart */
  return (
    <ResponsiveContainer width="100%" height={350}>
      <BarChart {...commonProps}>
        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
        <XAxis
          dataKey={xKey}
          tick={{ fill: '#94a3b8', fontSize: 11 }}
          angle={-30}
          textAnchor="end"
        />
        <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} />
        <Tooltip
          contentStyle={{
            backgroundColor: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '8px',
          }}
        />
        <Legend />
        {numericCols.map((col, i) => (
          <Bar
            key={col.key}
            dataKey={col.key}
            fill={CHART_COLORS[i % CHART_COLORS.length]}
            radius={[4, 4, 0, 0]}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function AnalyseDataClient() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [statusMessages, setStatusMessages] = useState<string[]>([]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chartType, setChartType] = useState<string>('bar');
  const [showSql, setShowSql] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Sender forespørgsel til /api/analyse/query og streamer resultatet.
   */
  const executeQuery = useCallback(
    async (q: string) => {
      if (!q.trim() || loading) return;
      setLoading(true);
      setStatusMessages([]);
      setResult(null);
      setError(null);

      abortRef.current = new AbortController();

      try {
        const res = await fetch('/api/analyse/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q }),
          signal: abortRef.current.signal,
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({ error: 'Ukendt fejl' }));
          setError((errBody as { error?: string }).error ?? `HTTP ${res.status}`);
          setLoading(false);
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) {
          setError('Kunne ikke læse svar');
          setLoading(false);
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() ?? '';

          for (const event of events) {
            const dataLine = event.startsWith('data: ') ? event.slice(6).trim() : '';
            if (!dataLine || dataLine === '[DONE]') continue;

            try {
              const parsed = JSON.parse(dataLine) as {
                status?: string;
                sql?: string;
                result?: QueryResult;
                error?: string;
              };
              if (parsed.error) setError(parsed.error);
              if (parsed.status) setStatusMessages((prev) => [...prev, parsed.status!]);
              if (parsed.result) {
                setResult(parsed.result);
                setChartType(parsed.result.chartType);
              }
            } catch {
              /* Ignorér ugyldigt JSON */
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError('Netværksfejl — prøv igen');
        }
      } finally {
        setLoading(false);
      }
    },
    [loading]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    executeQuery(query);
  };

  const chartTypes = [
    { id: 'bar', icon: <BarChart3 size={14} />, label: 'Søjle' },
    { id: 'line', icon: <LineChartIcon size={14} />, label: 'Linje' },
    { id: 'pie', icon: <PieChartIcon size={14} />, label: 'Cirkel' },
    { id: 'table', icon: <Table2 size={14} />, label: 'Tabel' },
  ];

  return (
    <div className="flex-1 bg-[#0a1628] p-6 space-y-6">
      {/* ── Header ── */}
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <Sparkles size={20} className="text-emerald-400" />
          AI Query Builder
        </h1>
        <p className="text-slate-400 text-sm mt-1">
          Skriv en forespørgsel på dansk — AI genererer og kører en analyse på tværs af ejendoms- og
          virksomhedsdata.
        </p>
      </div>

      {/* ── Query input ── */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <div className="flex-1 relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="F.eks. 'Gennemsnitligt boligareal per kommune' eller 'Energimærke fordeling'..."
            className="w-full pl-10 pr-4 py-2.5 bg-slate-800/60 border border-slate-700/50 rounded-lg text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/25"
            disabled={loading}
          />
        </div>
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          Analysér
        </button>
      </form>

      {/* ── Foreslåede queries ── */}
      {!result && !loading && (
        <div className="flex flex-wrap gap-2">
          {SUGGESTED_QUERIES.map((sq) => (
            <button
              key={sq}
              onClick={() => {
                setQuery(sq);
                executeQuery(sq);
              }}
              className="px-3 py-1.5 bg-slate-800/40 border border-slate-700/30 rounded-full text-xs text-slate-400 hover:text-white hover:border-slate-600 transition-colors"
            >
              {sq}
            </button>
          ))}
        </div>
      )}

      {/* ── Status messages ── */}
      {loading && statusMessages.length > 0 && (
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2 size={14} className="animate-spin text-blue-400" />
          <span>{statusMessages[statusMessages.length - 1]}</span>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* ── Resultat ── */}
      {result && (
        <div className="space-y-4">
          {/* Summary */}
          <div className="bg-slate-800/40 border border-slate-700/30 rounded-lg p-4">
            <p className="text-slate-300 text-sm">{result.summary}</p>
            <p className="text-slate-500 text-xs mt-1">
              {result.rowCount.toLocaleString('da-DK')} rækker
            </p>
          </div>

          {/* Chart type toggle */}
          <div className="flex items-center gap-1">
            {chartTypes.map((ct) => (
              <button
                key={ct.id}
                onClick={() => setChartType(ct.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  chartType === ct.id
                    ? 'bg-blue-600/20 border border-blue-500/40 text-blue-300'
                    : 'bg-slate-800/40 border border-slate-700/30 text-slate-400 hover:text-white'
                }`}
              >
                {ct.icon}
                {ct.label}
              </button>
            ))}
          </div>

          {/* Chart */}
          {chartType !== 'table' && result.rows.length > 0 && (
            <div className="bg-slate-800/30 border border-slate-700/30 rounded-lg p-4">
              <DataChart data={result.rows} columns={result.columns} chartType={chartType} />
            </div>
          )}

          {/* Data table */}
          <div className="bg-slate-800/30 border border-slate-700/30 rounded-lg overflow-hidden">
            <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-800 z-10">
                  <tr className="text-left text-slate-500 text-xs uppercase tracking-wide border-b border-slate-700/40">
                    {result.columns.map((col) => (
                      <th key={col.key} className="px-4 py-2.5">
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.slice(0, 200).map((row, i) => (
                    <tr key={i} className="border-b border-slate-700/20 hover:bg-slate-800/40">
                      {result.columns.map((col) => (
                        <td key={col.key} className="px-4 py-2 text-slate-300">
                          {col.type === 'number'
                            ? Number(row[col.key]).toLocaleString('da-DK')
                            : String(row[col.key] ?? '—')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* SQL (collapsible) */}
          <button
            onClick={() => setShowSql(!showSql)}
            className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            {showSql ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Code2 size={12} />
            Vis SQL
          </button>
          {showSql && (
            <pre className="bg-slate-900 border border-slate-700/30 rounded-lg p-4 text-xs text-slate-400 overflow-x-auto">
              {result.sql}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
