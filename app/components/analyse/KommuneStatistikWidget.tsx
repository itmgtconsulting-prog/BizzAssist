/**
 * KommuneStatistikWidget — viser aggregeret kommunestatistik fra materialized views.
 *
 * BIZZ-920: Krydsanalyse dashboard UI-komponent. Henter data fra
 * /api/v2/analyse/kommune og viser nøgletal for et valgt postnummer/kommune.
 *
 * @param kommunekode - 3-4 cifret kommunekode
 * @param lang - UI-sprog
 */

'use client';

import { useEffect, useState } from 'react';
import { BarChart3, MapPin, Loader2, AlertCircle } from 'lucide-react';

interface KommuneData {
  kommunekode: string;
  kommunenavn: string;
  antal_adresser: number;
  dar_synced_at: string | null;
}

interface Props {
  /** Kommune-kode at vise statistik for */
  kommunekode: string;
  /** UI-sprog */
  lang: 'da' | 'en';
}

/**
 * Kompakt widget der viser kommune-statistik fra materialized view.
 */
export default function KommuneStatistikWidget({ kommunekode, lang }: Props) {
  const da = lang === 'da';
  const [data, setData] = useState<KommuneData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!kommunekode) return;
    let cancelled = false;
    setLoading(true);
    setError(false);

    fetch(`/api/v2/analyse/kommune?kommunekode=${encodeURIComponent(kommunekode)}`)
      .then((r) => (r.ok ? (r.json() as Promise<KommuneData>) : null))
      .then((d) => {
        if (cancelled) return;
        if (d) {
          setData(d);
        } else {
          setError(true);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [kommunekode]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-500 text-xs py-2">
        <Loader2 size={12} className="animate-spin" />
        {da ? 'Henter kommunestatistik...' : 'Loading municipality stats...'}
      </div>
    );
  }

  if (error || !data) return null;

  return (
    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
      <h3 className="text-white font-semibold text-sm flex items-center gap-2 mb-3">
        <BarChart3 size={14} className="text-cyan-400" />
        {da ? 'Kommunestatistik' : 'Municipality Statistics'}
      </h3>
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-900/50 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 uppercase tracking-wider">
            {da ? 'Kommune' : 'Municipality'}
          </p>
          <p className="text-white text-sm font-bold flex items-center gap-1.5 mt-1">
            <MapPin size={12} className="text-slate-400" />
            {data.kommunenavn ?? kommunekode}
          </p>
        </div>
        <div className="bg-slate-900/50 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 uppercase tracking-wider">
            {da ? 'Adresser' : 'Addresses'}
          </p>
          <p className="text-white text-sm font-bold mt-1">
            {data.antal_adresser?.toLocaleString('da-DK') ?? '—'}
          </p>
        </div>
      </div>
      {data.dar_synced_at && (
        <p className="text-[9px] text-slate-600 mt-2 flex items-center gap-1">
          <AlertCircle size={8} />
          {da ? 'Opdateret' : 'Updated'}: {new Date(data.dar_synced_at).toLocaleDateString('da-DK')}
        </p>
      )}
    </div>
  );
}
