/**
 * VurderingSammenligning — benchmark mod postnummer.
 *
 * BIZZ-958: Viser ejendommens vurdering i kontekst med gennemsnit,
 * percentil og min/max for postnummeret.
 *
 * @param postnr - Postnummer
 * @param ejendomsvaerdi - Ejendommens ejendomsværdi
 * @param grundvaerdi - Ejendommens grundværdi
 * @param areal - Ejendommens areal i m²
 */

'use client';

import { useEffect, useState } from 'react';
import { BarChart3, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { formatDKK } from '@/app/lib/mock/ejendomme';
import type { VurderingSammenligningData } from '@/app/api/vurdering-sammenligning/route';

interface Props {
  postnr: string | null;
  ejendomsvaerdi: number | null;
  grundvaerdi: number | null;
  areal: number | null;
  lang: 'da' | 'en';
}

/**
 * Percentil-gauge komponent.
 */
function PercentilGauge({ pct, label }: { pct: number; label: string }) {
  const color = pct > 75 ? 'text-red-400' : pct > 50 ? 'text-amber-400' : 'text-emerald-400';
  const icon =
    pct > 75 ? (
      <TrendingUp size={12} />
    ) : pct < 25 ? (
      <TrendingDown size={12} />
    ) : (
      <Minus size={12} />
    );

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 rounded-full bg-slate-700/50 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            pct > 75 ? 'bg-red-500' : pct > 50 ? 'bg-amber-500' : 'bg-emerald-500'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-xs font-medium ${color} flex items-center gap-1`}>
        {icon} {pct}% · {label}
      </span>
    </div>
  );
}

/**
 * Vurdering sammenligning sektion.
 */
export default function VurderingSammenligning({
  postnr,
  ejendomsvaerdi,
  grundvaerdi,
  areal,
  lang,
}: Props) {
  const da = lang === 'da';
  const [data, setData] = useState<VurderingSammenligningData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!postnr) return;
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ postnr });
    if (ejendomsvaerdi != null) params.set('ejendomsvaerdi', String(ejendomsvaerdi));
    if (grundvaerdi != null) params.set('grundvaerdi', String(grundvaerdi));
    if (areal != null) params.set('areal', String(areal));

    fetch(`/api/vurdering-sammenligning?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setData(d as VurderingSammenligningData);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [postnr, ejendomsvaerdi, grundvaerdi, areal]);

  if (!postnr || loading || !data || data.antalEjendomme === 0) return null;

  return (
    <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
      {/* BIZZ-1017: Tydeliggjort overskrift + datakilde */}
      <h3 className="text-white font-semibold text-sm flex items-center gap-2 mb-1">
        <BarChart3 size={14} className="text-purple-400" />
        {da
          ? `Foreløbig vurdering — postnummer ${postnr}`
          : `Preliminary valuation — postal area ${postnr}`}
      </h3>
      {/* BIZZ-1053: Øget kontrast fra text-slate-600 → text-slate-400 */}
      <p className="text-[10px] text-slate-400 mb-3">
        {da
          ? `Baseret på ${data.antalEjendomme} foreløbige ejendomsvurderinger i postnummer ${postnr} (kilde: Vurderingsstyrelsen). Endelige vurderinger kan afvige.`
          : `Based on ${data.antalEjendomme} preliminary property valuations in postal area ${postnr} (source: Danish Valuation Agency). Final valuations may differ.`}
      </p>

      <div className="space-y-4">
        {/* Ejendomsværdi sammenligning */}
        {data.ejendomsvaerdi && (
          <div>
            <p className="text-slate-400 text-xs mb-1.5">
              {da ? 'Ejendomsværdi' : 'Property value'}
            </p>
            <div className="grid grid-cols-3 gap-2 mb-2">
              <div className="bg-slate-900/50 rounded-lg p-2 text-center">
                <p className="text-[10px] text-slate-500">{da ? 'Din' : 'Yours'}</p>
                <p className="text-white text-sm font-bold">
                  {data.ejendomsvaerdi.dinVaerdi != null
                    ? formatDKK(data.ejendomsvaerdi.dinVaerdi)
                    : '—'}
                </p>
              </div>
              <div className="bg-slate-900/50 rounded-lg p-2 text-center">
                <p className="text-[10px] text-slate-500">{da ? 'Gennemsnit' : 'Average'}</p>
                <p className="text-slate-300 text-sm font-medium">
                  {formatDKK(data.ejendomsvaerdi.gennemsnit)}
                </p>
              </div>
              <div className="bg-slate-900/50 rounded-lg p-2 text-center">
                <p className="text-[10px] text-slate-500">{da ? 'Median' : 'Median'}</p>
                <p className="text-slate-300 text-sm font-medium">
                  {formatDKK(data.ejendomsvaerdi.median)}
                </p>
              </div>
            </div>
            {data.ejendomsvaerdi.percentil != null && (
              <PercentilGauge
                pct={data.ejendomsvaerdi.percentil}
                label={
                  da
                    ? `Top ${100 - data.ejendomsvaerdi.percentil}%`
                    : `Top ${100 - data.ejendomsvaerdi.percentil}%`
                }
              />
            )}
          </div>
        )}

        {/* Grundværdi pr. m² sammenligning */}
        {data.grundvaerdiPrM2 && (
          <div>
            <p className="text-slate-400 text-xs mb-1.5">
              {da ? 'Grundværdi pr. m²' : 'Land value per m²'}
            </p>
            <div className="grid grid-cols-3 gap-2 mb-2">
              <div className="bg-slate-900/50 rounded-lg p-2 text-center">
                <p className="text-[10px] text-slate-500">{da ? 'Din' : 'Yours'}</p>
                <p className="text-white text-sm font-bold">
                  {data.grundvaerdiPrM2.dinVaerdi != null
                    ? `${data.grundvaerdiPrM2.dinVaerdi.toLocaleString('da-DK')} kr`
                    : '—'}
                </p>
              </div>
              <div className="bg-slate-900/50 rounded-lg p-2 text-center">
                <p className="text-[10px] text-slate-500">{da ? 'Gennemsnit' : 'Average'}</p>
                <p className="text-slate-300 text-sm font-medium">
                  {data.grundvaerdiPrM2.gennemsnit.toLocaleString('da-DK')} kr
                </p>
              </div>
              <div className="bg-slate-900/50 rounded-lg p-2 text-center">
                <p className="text-[10px] text-slate-500">{da ? 'Median' : 'Median'}</p>
                <p className="text-slate-300 text-sm font-medium">
                  {data.grundvaerdiPrM2.median.toLocaleString('da-DK')} kr
                </p>
              </div>
            </div>
            {data.grundvaerdiPrM2.percentil != null && (
              <PercentilGauge
                pct={data.grundvaerdiPrM2.percentil}
                label={
                  da
                    ? `Top ${100 - data.grundvaerdiPrM2.percentil}%`
                    : `Top ${100 - data.grundvaerdiPrM2.percentil}%`
                }
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}
