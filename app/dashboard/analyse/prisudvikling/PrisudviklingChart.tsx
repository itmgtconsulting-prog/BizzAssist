/**
 * PrisudviklingChart — Recharts line chart for prishistorik.
 *
 * BIZZ-1464: Viser kontant købesum over tid med valgfri
 * kommune-gennemsnit m²-pris som sammenligning.
 *
 * Lazy-loaded via next/dynamic med ssr: false.
 *
 * @module app/dashboard/analyse/prisudvikling/PrisudviklingChart
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
  BarChart,
  Bar,
} from 'recharts';

interface PrisRow {
  overtagelsesdato: string | null;
  ejer_navn: string | null;
  kontant_koebesum: number | null;
  i_alt_koebesum: number | null;
  m2_pris: number | null;
}

interface KommuneGns {
  kvartal: string;
  gns_m2_pris: number;
  antal: number;
}

interface Props {
  prishistorik: PrisRow[];
  kommuneGennemsnit: KommuneGns[] | null;
}

/** Dansk talformatering. */
function fmtDkk(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)} mio`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}t`;
  return v.toLocaleString('da-DK');
}

/**
 * Custom tooltip.
 */
function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm shadow-lg">
      <p className="text-slate-300 font-medium mb-1">{label}</p>
      {payload.map((entry, i) => (
        <p key={i} style={{ color: entry.color }}>
          {entry.name}: {entry.value?.toLocaleString('da-DK')} kr
        </p>
      ))}
    </div>
  );
}

/**
 * Prisudvikling chart med linje for købesum + valgfri m²-pris bar.
 */
export default function PrisudviklingChart({
  prishistorik,
  kommuneGennemsnit,
}: Props): React.ReactElement | null {
  /** Prisdata for line chart. */
  const chartData = useMemo(() => {
    return prishistorik
      .filter((r) => r.overtagelsesdato)
      .map((r) => ({
        dato: r.overtagelsesdato!.slice(0, 10),
        købesum: r.kontant_koebesum ?? r.i_alt_koebesum ?? undefined,
        m2_pris: r.m2_pris ?? undefined,
        ejer: r.ejer_navn ?? '',
      }));
  }, [prishistorik]);

  const hasPrices = chartData.some((d) => d.købesum);
  const hasM2 = chartData.some((d) => d.m2_pris);

  if (chartData.length === 0) return null;

  return (
    <div className="space-y-4">
      {/* Købesum over tid */}
      {hasPrices && (
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-slate-300 mb-3">Købesum over tid</h3>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="dato" stroke="#94a3b8" fontSize={11} tick={{ fill: '#94a3b8' }} />
              <YAxis
                stroke="#94a3b8"
                fontSize={11}
                tick={{ fill: '#94a3b8' }}
                tickFormatter={(v: number) => fmtDkk(v)}
              />
              <Tooltip content={<ChartTooltip />} />
              <Legend
                formatter={(value: string) => (
                  <span className="text-slate-300 text-xs">{value}</span>
                )}
              />
              <Line
                type="monotone"
                dataKey="købesum"
                stroke="#10b981"
                strokeWidth={2}
                dot={{ fill: '#10b981', r: 5 }}
                name="Købesum (DKK)"
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* M²-pris sammenligning */}
      {hasM2 && (
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-slate-300 mb-3">
            M²-pris
            {kommuneGennemsnit && kommuneGennemsnit.length > 0 && ' vs kommune-gennemsnit'}
          </h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData.filter((d) => d.m2_pris)}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="dato" stroke="#94a3b8" fontSize={11} tick={{ fill: '#94a3b8' }} />
              <YAxis
                stroke="#94a3b8"
                fontSize={11}
                tick={{ fill: '#94a3b8' }}
                tickFormatter={(v: number) => `${fmtDkk(v)}/m²`}
              />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="m2_pris" fill="#06b6d4" radius={[4, 4, 0, 0]} name="M²-pris (DKK/m²)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
