/**
 * PlandataSektion — lokalplan detaljer for en ejendom.
 *
 * BIZZ-1025: Viser aktiv lokalplan med anvendelse, bebyggelsespct,
 * max etager og højde fra Plandata WFS.
 *
 * @param adresseId - DAWA adgangsadresse UUID
 * @param lang - 'da' | 'en'
 */

'use client';

import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import type { PlandataResponse } from '@/app/api/plandata/route';

interface Props {
  adresseId: string | null;
  lang: 'da' | 'en';
}

/**
 * Viser lokalplan-data for ejendommen.
 */
export default function PlandataSektion({ adresseId, lang }: Props) {
  const da = lang === 'da';
  const [data, setData] = useState<PlandataResponse | null>(null);

  useEffect(() => {
    if (!adresseId) return;
    let cancelled = false;

    fetch(`/api/plandata?adresseId=${adresseId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setData(d as PlandataResponse);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [adresseId]);

  if (!data || !data.planer || data.planer.length === 0) return null;

  // Vis kun lokalplaner (ikke kommuneplanrammer)
  const lokalplaner = data.planer.filter((p) => p.type === 'Lokalplan');
  if (lokalplaner.length === 0) return null;

  const lp = lokalplaner[0];

  return (
    <div className="bg-slate-800/40 rounded-xl p-4 mt-4">
      <div className="flex items-center gap-2 mb-3">
        <FileText className="w-4 h-4 text-amber-400" />
        <h3 className="text-sm font-medium text-slate-300">{da ? 'Lokalplan' : 'Local Plan'}</h3>
      </div>

      <p className="text-sm text-white font-medium mb-2">{lp.navn}</p>

      <div className="grid grid-cols-2 gap-2 text-xs">
        {lp.detaljer?.anvendelse && (
          <div>
            <span className="text-slate-500">{da ? 'Anvendelse' : 'Use'}</span>
            <p className="text-slate-300">{lp.detaljer.anvendelse}</p>
          </div>
        )}
        {lp.detaljer?.bebygpct != null && (
          <div>
            <span className="text-slate-500">{da ? 'Bebyggelsespct.' : 'Building pct.'}</span>
            <p className="text-slate-300">{lp.detaljer.bebygpct}%</p>
          </div>
        )}
        {lp.detaljer?.maxetager != null && (
          <div>
            <span className="text-slate-500">{da ? 'Max etager' : 'Max floors'}</span>
            <p className="text-slate-300">{lp.detaljer.maxetager}</p>
          </div>
        )}
        {lp.detaljer?.maxbygnhjd != null && (
          <div>
            <span className="text-slate-500">{da ? 'Max højde' : 'Max height'}</span>
            <p className="text-slate-300">{lp.detaljer.maxbygnhjd} m</p>
          </div>
        )}
      </div>

      {lp.doklink && (
        <a
          href={lp.doklink}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 text-xs hover:text-blue-300 mt-2 inline-block"
        >
          {da ? 'Se fuld lokalplan →' : 'View full plan →'}
        </a>
      )}
    </div>
  );
}
