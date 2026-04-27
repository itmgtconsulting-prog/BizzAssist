/**
 * EjerforeningSektion — viser ejerforening (HOA) tilknyttet en ejendom.
 *
 * BIZZ-966: Henter ejerforeningsdata fra /api/ejerforening baseret på
 * ejendommens adresse. Viser CVR-link, formand og bestyrelsesmedlemmer.
 *
 * @param vejnavn - Ejendommens vejnavn
 * @param husnr - Husnummer
 * @param postnr - Postnummer
 * @param lang - 'da' | 'en'
 */

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Users, ExternalLink } from 'lucide-react';
import type { EjerforeningData } from '@/app/api/ejerforening/route';

interface Props {
  /** Vejnavn (f.eks. "Arnold Nielsens Boulevard") */
  vejnavn: string | null;
  /** Husnummer (f.eks. "62A") */
  husnr: string | null;
  /** Postnummer (f.eks. "2650") */
  postnr: string | null;
  /** Sprogvalg */
  lang: 'da' | 'en';
}

/**
 * Viser ejerforening(er) for en ejendom. Fetcher data internt.
 * Returnerer null hvis ingen ejerforening er fundet.
 */
export default function EjerforeningSektion({ vejnavn, husnr, postnr, lang }: Props) {
  const da = lang === 'da';
  const [foreninger, setForeninger] = useState<EjerforeningData[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!vejnavn) return;
    let cancelled = false;
    setLoading(true);

    const params = new URLSearchParams({ vejnavn });
    if (husnr) params.set('husnr', husnr);
    if (postnr) params.set('postnr', postnr);

    fetch(`/api/ejerforening?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.foreninger) {
          setForeninger(d.foreninger as EjerforeningData[]);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [vejnavn, husnr, postnr]);

  if (loading) {
    return (
      <div className="bg-slate-800/40 rounded-xl p-4 mt-4 animate-pulse">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-slate-500" />
          <span className="text-slate-500 text-sm">
            {da ? 'Søger ejerforening...' : 'Searching HOA...'}
          </span>
        </div>
      </div>
    );
  }

  if (foreninger.length === 0) return null;

  return (
    <div className="bg-slate-800/40 rounded-xl p-4 mt-4">
      <div className="flex items-center gap-2 mb-3">
        <Users className="w-4 h-4 text-violet-400" />
        <h3 className="text-sm font-medium text-slate-300">
          {da ? 'Ejerforening' : 'Homeowners Association'}
        </h3>
      </div>

      <div className="space-y-3">
        {foreninger.map((f) => (
          <div key={f.cvr} className="bg-slate-900/40 rounded-lg p-3">
            {/* Navn + CVR link */}
            <div className="flex items-start justify-between gap-2 mb-2">
              <div>
                <Link
                  href={`/dashboard/companies/${String(f.cvr).padStart(8, '0')}`}
                  className="text-sm font-medium text-white hover:text-blue-400 transition-colors"
                >
                  {f.navn}
                </Link>
                <p className="text-xs text-slate-500 mt-0.5">
                  CVR {String(f.cvr).padStart(8, '0')}
                  {f.stiftet && ` · ${da ? 'Stiftet' : 'Founded'} ${f.stiftet.slice(0, 4)}`}
                </p>
              </div>
              <Link
                href={`/dashboard/companies/${String(f.cvr).padStart(8, '0')}`}
                className="text-slate-500 hover:text-blue-400 transition-colors shrink-0"
                aria-label={da ? 'Åbn virksomhedsside' : 'Open company page'}
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </Link>
            </div>

            {/* Formand */}
            {f.formand && (
              <p className="text-xs text-slate-400">
                <span className="text-slate-500">{da ? 'Formand:' : 'Chairman:'}</span> {f.formand}
              </p>
            )}

            {/* Bestyrelse */}
            {f.bestyrelse.length > 0 && (
              <div className="mt-2">
                <p className="text-xs text-slate-500 mb-1">
                  {da ? 'Bestyrelse' : 'Board'} ({f.bestyrelse.length})
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {f.bestyrelse.map((m, i) => (
                    <span
                      key={i}
                      className="text-xs bg-slate-800 text-slate-400 px-2 py-0.5 rounded"
                    >
                      {m.navn}
                      {m.rolle !== 'Bestyrelsesmedlem' && (
                        <span className="text-violet-400 ml-1">({m.rolle})</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
