/**
 * OmraadeProfilSektion — viser nøgletal for kommunen fra Danmarks Statistik.
 *
 * BIZZ-947: Henter befolkning, gennemsnitsindkomst og boligtal fra
 * /api/statistik/omraade?kommunekode=XXX. Vises som kompakte kort i
 * ejendomssidens Overblik-tab.
 *
 * @param kommunekode - 3-4 cifret kommunekode (fra DAWA-adresse)
 */

'use client';

import { useEffect, useState } from 'react';
import { BarChart3, Users, Wallet, Home } from 'lucide-react';
import type { OmraadeProfilData } from '@/app/api/statistik/omraade/route';

interface Props {
  /** Kommunekode fra DAWA (fx "0167") */
  kommunekode: string | null;
  /** UI-sprog */
  lang: 'da' | 'en';
}

/**
 * Kompakt områdeprofil-sektion med nøgletal fra Danmarks Statistik.
 */
export default function OmraadeProfilSektion({ kommunekode, lang }: Props) {
  const da = lang === 'da';
  const [data, setData] = useState<OmraadeProfilData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!kommunekode) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/statistik/omraade?kommunekode=${encodeURIComponent(kommunekode)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setData(d as OmraadeProfilData);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kommunekode]);

  if (!kommunekode || loading || !data) return null;
  if (!data.befolkning && !data.gnsIndkomst && !data.antalBoliger) return null;

  /** Formater tal med tusindtal-separator. */
  const fmt = (n: number | null) => (n != null ? n.toLocaleString('da-DK') : '—');

  return (
    <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
      <h3 className="text-white font-semibold text-sm flex items-center gap-2 mb-3">
        <BarChart3 size={14} className="text-indigo-400" />
        {da ? 'Områdeprofil' : 'Area profile'}
        {data.kommunenavn && (
          <span className="text-slate-400 font-normal text-xs">— {data.kommunenavn}</span>
        )}
      </h3>
      {/* BIZZ-997: Kompakte label/værdi-par — matcher matrikel-kasse-layoutet */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
        {data.befolkning != null && (
          <>
            <span className="text-slate-500 text-xs flex items-center gap-1">
              <Users size={10} className="text-blue-400" />
              {da ? 'Befolkning' : 'Population'}
              {data.befolkningKvartal && (
                <span className="text-slate-600 text-[9px]">({data.befolkningKvartal})</span>
              )}
            </span>
            <span className="text-white text-xs font-medium text-right">
              {fmt(data.befolkning)}
            </span>
          </>
        )}
        {data.gnsIndkomst != null && (
          <>
            <span className="text-slate-500 text-xs flex items-center gap-1">
              <Wallet size={10} className="text-emerald-400" />
              {da ? 'Gns. indkomst' : 'Avg. income'}
              {data.indkomstAar && (
                <span className="text-slate-600 text-[9px]">({data.indkomstAar})</span>
              )}
            </span>
            <span className="text-white text-xs font-medium text-right">
              {fmt(data.gnsIndkomst)} kr
            </span>
          </>
        )}
        {data.antalBoliger != null && (
          <>
            <span className="text-slate-500 text-xs flex items-center gap-1">
              <Home size={10} className="text-amber-400" />
              {da ? 'Boliger' : 'Dwellings'}
              {data.boligAar && (
                <span className="text-slate-600 text-[9px]">({data.boligAar})</span>
              )}
            </span>
            <span className="text-white text-xs font-medium text-right">
              {fmt(data.antalBoliger)}
            </span>
          </>
        )}
      </div>
      <p className="text-slate-600 text-[9px] mt-2 text-right">
        {da ? 'Kilde: Danmarks Statistik' : 'Source: Statistics Denmark'}
      </p>
    </section>
  );
}
