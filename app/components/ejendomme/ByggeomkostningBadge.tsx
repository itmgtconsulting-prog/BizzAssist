/**
 * ByggeomkostningBadge — viser byggeomkostningsindeks fra DST.
 *
 * BIZZ-968: Henter BYG42 fra /api/byggeomkostninger og viser
 * seneste indeksværdi + år-over-år ændring.
 *
 * @param lang - 'da' | 'en'
 */

'use client';

import { useEffect, useState } from 'react';
import { Hammer, TrendingUp, TrendingDown } from 'lucide-react';
import type { ByggeomkostningData } from '@/app/api/byggeomkostninger/route';

interface Props {
  /** Sprogvalg */
  lang: 'da' | 'en';
}

/**
 * Kompakt badge med byggeomkostningsindeks.
 */
export default function ByggeomkostningBadge({ lang }: Props) {
  const da = lang === 'da';
  const [data, setData] = useState<ByggeomkostningData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/byggeomkostninger?type=enfamiliehus')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && !d.fejl) setData(d as ByggeomkostningData);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) return null;

  const positive = data.aendringYoY != null && data.aendringYoY > 0;

  return (
    <div className="bg-slate-800/40 rounded-xl p-4 mt-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Hammer className="w-4 h-4 text-amber-400" />
          <h3 className="text-sm font-medium text-slate-300">
            {da ? 'Byggeomkostninger' : 'Construction Costs'}
          </h3>
        </div>
        <span className="text-xs text-slate-500">{data.kvartal}</span>
      </div>

      <div className="flex items-baseline gap-3 mt-2">
        <span className="text-2xl font-bold text-white">{data.indeks}</span>
        <span className="text-xs text-slate-500">(2015 = 100)</span>
        {data.aendringYoY != null && (
          <span
            className={`flex items-center gap-0.5 text-xs font-medium ${
              positive ? 'text-rose-400' : 'text-emerald-400'
            }`}
          >
            {positive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {positive ? '+' : ''}
            {data.aendringYoY}%
          </span>
        )}
      </div>
      <p className="text-[10px] text-slate-400 mt-1">
        {data.type} · {da ? 'Kilde: DST BYG42' : 'Source: DST BYG42'}
      </p>
      {/* BIZZ-1046: Kontekst-forklaring */}
      <p className="text-[9px] text-slate-400 mt-0.5">
        {da
          ? 'Indeks for byggeomkostninger (2015 = 100). Bruges til at estimere genopførelsesværdi. Ændring er ift. samme kvartal året før.'
          : 'Construction cost index (2015 = 100). Used to estimate replacement value. Change is YoY same quarter.'}
      </p>
    </div>
  );
}
