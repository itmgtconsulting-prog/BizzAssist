/**
 * StoejBadge — viser støjniveau-badge for en ejendom.
 *
 * BIZZ-961: Henter dB-niveau fra /api/stoej og viser farvekodede badges.
 * Lav (<55dB) = grøn, Medium (55-65dB) = gul, Høj (>65dB) = rød.
 *
 * @param lat - Breddegrad
 * @param lng - Længdegrad
 */

'use client';

import { useEffect, useState } from 'react';
import { Volume2 } from 'lucide-react';

interface Props {
  lat: number | null;
  lng: number | null;
  lang: 'da' | 'en';
}

interface StoejData {
  vejstoejLdenDb: number | null;
  togstoejLdenDb: number | null;
}

/**
 * Støj-badge med farvekodning baseret på dB-niveau.
 */
export default function StoejBadge({ lat, lng, lang }: Props) {
  const da = lang === 'da';
  const [data, setData] = useState<StoejData | null>(null);

  useEffect(() => {
    if (lat == null || lng == null) return;
    let cancelled = false;
    fetch(`/api/stoej?lat=${lat}&lng=${lng}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setData(d as StoejData);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [lat, lng]);

  if (!data) return null;

  const maxDb = Math.max(data.vejstoejLdenDb ?? 0, data.togstoejLdenDb ?? 0);
  if (maxDb === 0) return null;

  const level = maxDb > 65 ? 'high' : maxDb > 55 ? 'medium' : 'low';
  const colors = {
    low: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    medium: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    high: 'bg-red-500/10 text-red-400 border-red-500/20',
  };
  const labels = {
    low: da ? 'Lav støj' : 'Low noise',
    medium: da ? 'Mellem støj' : 'Medium noise',
    high: da ? 'Høj støj' : 'High noise',
  };

  return (
    <div
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium ${colors[level]}`}
    >
      <Volume2 size={12} />
      {labels[level]} ({maxDb} dB)
      {data.vejstoejLdenDb != null && data.togstoejLdenDb != null && (
        <span className="text-slate-500 ml-1">
          {da ? 'vej' : 'road'}: {data.vejstoejLdenDb}dB, {da ? 'tog' : 'rail'}:{' '}
          {data.togstoejLdenDb}dB
        </span>
      )}
    </div>
  );
}
