/**
 * BoligprisChart — Recharts linjediagram for prisudvikling.
 *
 * BIZZ-2034: Viser gns. pris og m²-pris over tid.
 * Lazy-loaded via next/dynamic med ssr: false.
 *
 * @module app/dashboard/analyse/boligpris/BoligprisChart
 */

'use client';

import { useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';

/** Tidsserie-datapunkt fra API. */
interface Tidsserie {
  maaned: string;
  antal_handler: number;
  avg_pris: number;
  avg_m2_pris: number;
}

interface Props {
  /** Sorteret tidsserie-array fra /api/analyse/boligpris */
  tidsserier: Tidsserie[];
}

/** Dansk talformatering til chart axis/tooltip. */
function fmtDkk(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}k`;
  return String(v);
}

/** Formatér måned fra ISO-dato til "jan 24" format. */
function fmtMonth(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('da-DK', { month: 'short', year: '2-digit' });
}

/**
 * Custom tooltip for prisudvikling.
 */
function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-800 border border-slate-600/50 rounded-lg p-3 shadow-xl text-sm">
      <p className="text-slate-300 mb-1 font-medium">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="text-slate-200" style={{ color: p.color }}>
          {p.name}: {p.value.toLocaleString('da-DK')} kr.
        </p>
      ))}
    </div>
  );
}

/**
 * BoligprisChart — dual-axis linjediagram med gns. pris og m²-pris.
 *
 * @param props - tidsserier array
 */
export default function BoligprisChart({ tidsserier }: Props): React.ReactElement {
  /** Formatér data til chart — map ISO-dato til kort label */
  const chartData = useMemo(
    () =>
      tidsserier.map((t) => ({
        ...t,
        label: fmtMonth(t.maaned),
      })),
    [tidsserier]
  );

  return (
    <ResponsiveContainer width="100%" height={350}>
      <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
        <XAxis
          dataKey="label"
          stroke="#94a3b8"
          tick={{ fill: '#94a3b8', fontSize: 12 }}
          interval="preserveStartEnd"
        />
        <YAxis
          yAxisId="pris"
          stroke="#94a3b8"
          tick={{ fill: '#94a3b8', fontSize: 12 }}
          tickFormatter={fmtDkk}
          width={70}
          label={{
            value: 'Gns. pris (kr)',
            angle: -90,
            position: 'insideLeft',
            fill: '#64748b',
            fontSize: 11,
            offset: -5,
          }}
        />
        <YAxis
          yAxisId="m2"
          orientation="right"
          stroke="#94a3b8"
          tick={{ fill: '#94a3b8', fontSize: 12 }}
          tickFormatter={fmtDkk}
          width={70}
          label={{
            value: 'm²-pris (kr/m²)',
            angle: 90,
            position: 'insideRight',
            fill: '#64748b',
            fontSize: 11,
            offset: -5,
          }}
        />
        <Tooltip content={<ChartTooltip />} />
        <Legend wrapperStyle={{ color: '#94a3b8', fontSize: 13 }} />
        <Line
          yAxisId="pris"
          type="monotone"
          dataKey="avg_pris"
          name="Gns. pris"
          stroke="#34d399"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
        <Line
          yAxisId="m2"
          type="monotone"
          dataKey="avg_m2_pris"
          name="m²-pris"
          stroke="#60a5fa"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
