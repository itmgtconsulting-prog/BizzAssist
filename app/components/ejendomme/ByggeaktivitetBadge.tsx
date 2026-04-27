/**
 * ByggeaktivitetBadge — fuldført byggeri fra DST BYGV22.
 *
 * BIZZ-1027: Viser antal fuldførte parcelhuse i området.
 *
 * @param kommunekode - 4-cifret kommunekode
 * @param lang - 'da' | 'en'
 */

'use client';

import { useEffect, useState } from 'react';
import { Hammer } from 'lucide-react';
import type { ByggeaktivitetData } from '@/app/api/byggeaktivitet/route';

interface Props {
  kommunekode: string | null;
  lang: 'da' | 'en';
}

/**
 * Kompakt badge med byggeaktivitet.
 */
export default function ByggeaktivitetBadge({ kommunekode, lang }: Props) {
  const da = lang === 'da';
  const [data, setData] = useState<ByggeaktivitetData | null>(null);

  useEffect(() => {
    if (!kommunekode) return;
    let cancelled = false;
    fetch(`/api/byggeaktivitet?kommunekode=${kommunekode}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && !d.fejl) setData(d as ByggeaktivitetData);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [kommunekode]);

  if (!data || data.antalBoliger === 0) return null;

  return (
    <div className="bg-slate-800/40 rounded-xl p-4 mt-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Hammer className="w-4 h-4 text-amber-400" />
          <h3 className="text-sm font-medium text-slate-300">
            {da ? 'Byggeaktivitet' : 'Construction Activity'}
          </h3>
        </div>
        <span className="text-xs text-slate-500">{data.kvartal}</span>
      </div>
      <div className="flex items-baseline gap-2 mt-2">
        <span className="text-xl font-bold text-white">{data.antalBoliger}</span>
        <span className="text-xs text-slate-500">
          {da ? 'fuldførte parcelhuse' : 'completed houses'}
        </span>
      </div>
      <p className="text-[10px] text-slate-600 mt-1">
        {data.omraade} · {da ? 'Kilde: DST BYGV22' : 'Source: DST BYGV22'}
      </p>
    </div>
  );
}
