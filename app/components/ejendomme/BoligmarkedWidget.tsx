/**
 * BoligmarkedWidget — ejendomssalgspriser fra Danmarks Statistik.
 *
 * BIZZ-962: Viser gennemsnitlige salgspriser og prisudvikling
 * for ejendommens region.
 *
 * @param kommunekode - 4-cifret kommunekode
 * @param lang - 'da' | 'en'
 */

'use client';

import { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, Home } from 'lucide-react';
import type { BoligmarkedData } from '@/app/api/boligmarked/route';

interface Props {
  kommunekode: string | null;
  lang: 'da' | 'en';
}

/**
 * Boligmarked-widget med salgspriser og trend.
 */
export default function BoligmarkedWidget({ kommunekode, lang }: Props) {
  const da = lang === 'da';
  const [data, setData] = useState<BoligmarkedData | null>(null);

  useEffect(() => {
    if (!kommunekode) return;
    let cancelled = false;
    fetch(`/api/boligmarked?kommunekode=${kommunekode}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && !d.fejl) setData(d as BoligmarkedData);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [kommunekode]);

  if (!data || data.priser.length === 0) return null;

  const latest = data.priser[data.priser.length - 1];
  const positive = data.aendringYoY != null && data.aendringYoY > 0;

  return (
    <div className="bg-slate-800/40 rounded-xl p-4 mt-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Home className="w-4 h-4 text-blue-400" />
          <h3 className="text-sm font-medium text-slate-300">
            {da ? 'Boligmarked' : 'Housing Market'}
          </h3>
        </div>
        <span className="text-xs text-slate-500">{data.omraade}</span>
      </div>

      <div className="flex items-baseline gap-3 mt-1">
        <span className="text-2xl font-bold text-white">
          {(latest.prisTusindKr / 1000).toFixed(1)} mio.
        </span>
        <span className="text-xs text-slate-500">
          {da ? 'gns. salgspris' : 'avg. sale price'} ({latest.kvartal})
        </span>
        {data.aendringYoY != null && (
          <span
            className={`flex items-center gap-0.5 text-xs font-medium ${
              positive ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {positive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {positive ? '+' : ''}
            {data.aendringYoY}%
          </span>
        )}
      </div>
      <p className="text-[10px] text-slate-600 mt-1">
        {data.type} · {da ? 'Kilde: DST EJEN77' : 'Source: DST EJEN77'}
      </p>
      {/* BIZZ-1045: Kontekst */}
      <p className="text-[9px] text-slate-600 mt-0.5">
        {da
          ? `Gennemsnitlig salgspris for ${data.type.toLowerCase()} i ${data.omraade} ved almindelig fri handel.${data.aendringYoY != null ? ` Ændring er ift. samme kvartal året før.` : ''}`
          : `Average sale price for ${data.type.toLowerCase()} in ${data.omraade} in arm's-length transactions.${data.aendringYoY != null ? ' Change is YoY same quarter.' : ''}`}
      </p>
    </div>
  );
}
