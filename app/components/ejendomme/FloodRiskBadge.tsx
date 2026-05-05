/**
 * FloodRiskBadge — viser oversvømmelsesrisiko for en ejendom.
 *
 * BIZZ-948: Henter punkt-specifik risiko fra /api/flood og viser
 * en farvekoderet badge (grøn=lav, amber=medium, rød=høj).
 *
 * @param lat - Breddegrad
 * @param lng - Længdegrad
 * @param lang - UI-sprog
 */

'use client';

import { useEffect, useState } from 'react';
import { Droplets } from 'lucide-react';
import type { FloodRiskData } from '@/app/api/flood/route';

interface Props {
  /** Breddegrad (WGS84) */
  lat: number | null;
  /** Længdegrad (WGS84) */
  lng: number | null;
  /** UI-sprog */
  lang: 'da' | 'en';
}

/** Risiko-niveau → visuelt tema */
const riskConfig = {
  lav: {
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/20',
    text: 'text-emerald-400',
    labelDa: 'Lav risiko',
    labelEn: 'Low risk',
  },
  medium: {
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/20',
    text: 'text-amber-400',
    labelDa: 'Middel risiko',
    labelEn: 'Medium risk',
  },
  hoej: {
    bg: 'bg-red-500/10',
    border: 'border-red-500/20',
    text: 'text-red-400',
    labelDa: 'Høj risiko',
    labelEn: 'High risk',
  },
} as const;

/**
 * Kompakt badge der viser oversvømmelsesrisiko.
 */
export default function FloodRiskBadge({ lat, lng, lang }: Props) {
  const da = lang === 'da';
  const [data, setData] = useState<FloodRiskData | null>(null);

  useEffect(() => {
    if (lat == null || lng == null) return;
    let cancelled = false;
    fetch(`/api/flood?lat=${lat}&lng=${lng}`)
      .then((r) => (r.ok ? (r.json() as Promise<FloodRiskData>) : null))
      .then((d) => {
        if (!cancelled && d) setData(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [lat, lng]);

  if (!data) return null;

  const cfg = riskConfig[data.risikoNiveau];

  const tooltip = [
    data.havvand1m ? (da ? 'Havvand +1m zone' : 'Sea level +1m zone') : null,
    data.skybrud ? (da ? 'Skybrud bluespot' : 'Cloudburst bluespot') : null,
  ]
    .filter(Boolean)
    .join(' + ');

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${cfg.bg} ${cfg.border} ${cfg.text}`}
      title={
        tooltip
          ? `${da ? 'Oversvømmelsesrisiko' : 'Flood risk'}: ${tooltip}`
          : da
            ? 'Ingen oversvømmelsesrisiko identificeret'
            : 'No flood risk identified'
      }
    >
      <Droplets size={11} />
      {da ? cfg.labelDa : cfg.labelEn}
    </span>
  );
}
