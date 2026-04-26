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
      <div className="grid grid-cols-3 gap-3">
        {data.befolkning != null && (
          <div className="bg-slate-900/50 rounded-lg p-3 text-center">
            <Users size={14} className="text-blue-400 mx-auto mb-1" />
            <p className="text-white text-lg font-bold">{fmt(data.befolkning)}</p>
            <p className="text-slate-500 text-[10px]">
              {da ? 'Befolkning' : 'Population'}
              {data.befolkningKvartal && (
                <span className="block text-slate-600">{data.befolkningKvartal}</span>
              )}
            </p>
          </div>
        )}
        {data.gnsIndkomst != null && (
          <div className="bg-slate-900/50 rounded-lg p-3 text-center">
            <Wallet size={14} className="text-emerald-400 mx-auto mb-1" />
            <p className="text-white text-lg font-bold">{fmt(data.gnsIndkomst)}</p>
            <p className="text-slate-500 text-[10px]">
              {da ? 'Gns. indkomst (kr)' : 'Avg. income (DKK)'}
              {data.indkomstAar && <span className="block text-slate-600">{data.indkomstAar}</span>}
            </p>
          </div>
        )}
        {data.antalBoliger != null && (
          <div className="bg-slate-900/50 rounded-lg p-3 text-center">
            <Home size={14} className="text-amber-400 mx-auto mb-1" />
            <p className="text-white text-lg font-bold">{fmt(data.antalBoliger)}</p>
            <p className="text-slate-500 text-[10px]">
              {da ? 'Boliger' : 'Dwellings'}
              {data.boligAar && <span className="block text-slate-600">{data.boligAar}</span>}
            </p>
          </div>
        )}
      </div>
      <p className="text-slate-600 text-[9px] mt-2 text-right">
        {da ? 'Kilde: Danmarks Statistik' : 'Source: Statistics Denmark'}
      </p>
    </section>
  );
}
