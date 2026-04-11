'use client';

/**
 * Standalone chart component for property price history.
 * Extracted so recharts can be loaded in a single dynamic import
 * instead of one per exported symbol.
 *
 * @param data  - Array of { dato, pris } data points
 * @param lang  - UI language
 */

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { TooltipProps } from 'recharts';
import type { ValueType, NameType } from 'recharts/types/component/DefaultTooltipContent';

interface EjendomPrisChartProps {
  /** Sales history mapped to { dato: year string, pris: price in mio DKK } */
  data: { dato: string; pris: number }[];
  /** UI language — controls the tooltip series label */
  lang: 'da' | 'en';
}

export default function EjendomPrisChart({ data, lang }: EjendomPrisChartProps) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id="prisGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis
          dataKey="dato"
          tick={{ fill: '#64748b', fontSize: 12 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: '#64748b', fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => `${v}M`}
        />
        <Tooltip
          contentStyle={{
            background: '#0f172a',
            border: '1px solid #1e293b',
            borderRadius: '12px',
            color: '#fff',
          }}
          formatter={
            ((value: number | string) => [
              `${value} mio. DKK`,
              lang === 'da' ? 'Pris' : 'Price',
            ]) as TooltipProps<ValueType, NameType>['formatter']
          }
        />
        <Area
          type="monotone"
          dataKey="pris"
          stroke="#3b82f6"
          strokeWidth={2}
          fill="url(#prisGradient)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
