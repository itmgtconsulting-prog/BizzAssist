'use client';

/**
 * Standalone chart component for financial data (regnskabstal).
 * Extracted so recharts can be loaded in a single dynamic import
 * instead of one per exported symbol.
 *
 * @param chartData  - Data points keyed by row ID and year
 * @param chartRows  - Set of selected row IDs to render as lines
 * @param alleRows   - Metadata for each row (label, isPercent)
 * @param fmtShort   - Axis tick formatter (e.g. 1.2m, 500k)
 * @param colors     - Colour palette for the lines
 */

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

/** Minimal row descriptor needed for chart rendering */
interface ChartRow {
  id: string;
  label: string;
  isPercent?: boolean;
}

interface RegnskabChartProps {
  chartData: Record<string, number | string | null>[];
  chartRows: Set<string>;
  alleRows: ChartRow[];
  fmtShort: (val: number) => string;
  colors: readonly string[];
}

export default function RegnskabChart({
  chartData,
  chartRows,
  alleRows,
  fmtShort,
  colors,
}: RegnskabChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
        <XAxis
          dataKey="aar"
          tick={{ fill: '#94a3b8', fontSize: 11 }}
          axisLine={{ stroke: '#475569' }}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: '#94a3b8', fontSize: 11 }}
          axisLine={{ stroke: '#475569' }}
          tickLine={false}
          tickFormatter={fmtShort}
          width={55}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '8px',
            fontSize: '12px',
          }}
          labelStyle={{ color: '#94a3b8' }}
          formatter={(value: unknown, name: unknown) => {
            const numVal = typeof value === 'number' ? value : 0;
            const nameStr = String(name ?? '');
            const row = alleRows.find((r) => r.id === nameStr);
            const label = row?.label ?? nameStr;
            const formatted = row?.isPercent
              ? `${numVal}%`
              : (numVal?.toLocaleString('da-DK') ?? '—');
            return [formatted, label] as [string, string];
          }}
        />
        {Array.from(chartRows).map((id, idx) => (
          <Line
            key={id}
            type="monotone"
            dataKey={id}
            stroke={colors[idx % colors.length]}
            strokeWidth={2}
            dot={{ r: 4, fill: colors[idx % colors.length] }}
            activeDot={{ r: 6 }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
