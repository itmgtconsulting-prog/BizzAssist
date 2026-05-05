/**
 * EnergiWidget — viser elspot-priser for ejendommens prisområde.
 *
 * BIZZ-955: Henter gennemsnitlige elpriser fra Energinet Datahub
 * baseret på kommunekode (→ DK1/DK2 prisområde).
 *
 * @param kommunekode - 4-cifret kommunekode
 * @param lang - 'da' | 'en'
 */

'use client';

import { useEffect, useState } from 'react';
import { Zap } from 'lucide-react';
import type { EnergiData } from '@/app/api/energi/route';

interface Props {
  /** 4-cifret kommunekode */
  kommunekode: string | null;
  /** Sprogvalg */
  lang: 'da' | 'en';
}

/**
 * Kompakt energipris-badge med gennemsnitlig elpris.
 */
export default function EnergiWidget({ kommunekode, lang }: Props) {
  const da = lang === 'da';
  const [data, setData] = useState<EnergiData | null>(null);

  useEffect(() => {
    if (!kommunekode) return;
    let cancelled = false;

    fetch(`/api/energi?kommunekode=${kommunekode}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && !d.fejl) setData(d as EnergiData);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [kommunekode]);

  if (!data) return null;

  return (
    <div className="bg-slate-800/40 rounded-xl p-4 mt-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-yellow-400" />
          <h3 className="text-sm font-medium text-slate-300">
            {da ? 'Elpris' : 'Electricity Price'}
          </h3>
        </div>
        <span className="text-xs text-slate-500">{data.prisomraade}</span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="text-center">
          <p className="text-lg font-semibold text-white">{data.gennemsnit.toFixed(2)}</p>
          <p className="text-[10px] text-slate-500 uppercase">{da ? 'Gns. 30d' : 'Avg 30d'}</p>
        </div>
        <div className="text-center">
          <p className="text-lg font-semibold text-emerald-400">{data.min.toFixed(2)}</p>
          <p className="text-[10px] text-slate-500 uppercase">Min</p>
        </div>
        <div className="text-center">
          <p className="text-lg font-semibold text-rose-400">{data.max.toFixed(2)}</p>
          <p className="text-[10px] text-slate-500 uppercase">Max</p>
        </div>
      </div>
      <p className="text-[10px] text-slate-400 mt-2 text-center">{data.enhed}</p>
      {/* BIZZ-1046: Kontekst-forklaring */}
      <p className="text-[9px] text-slate-400 mt-1">
        {da
          ? `Gennemsnit, min og max elspot-pris seneste 30 dage. ${data.prisomraade === 'DK2' ? 'DK2 = Østdanmark (Sjælland, Lolland-Falster, Bornholm)' : 'DK1 = Vestdanmark (Jylland, Fyn)'}. Kilde: Energinet DataHub.`
          : `Average, min, and max spot price over last 30 days. ${data.prisomraade === 'DK2' ? 'DK2 = East Denmark (Zealand)' : 'DK1 = West Denmark (Jutland, Funen)'}. Source: Energinet DataHub.`}
      </p>
    </div>
  );
}
