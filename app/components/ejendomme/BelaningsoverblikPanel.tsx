/**
 * BelaningsoverblikPanel — Kompakt belåningsoverblik i Økonomi-tabben.
 *
 * Viser:
 *   - Samlet belåning (sum af hovedstol)
 *   - Belåningsgrad i % (total gæld / ejendomsværdi)
 *   - Kreditor-fordeling (top kreditorer grupperet)
 *   - Rente-profil (fast vs. variabel)
 *
 * BIZZ-1520: Nyt panel — giver hurtigt finansielt overblik uden at skifte
 * til Tinglysning-tabben. Data modtages som prop fra parent (EjendomDetaljeClient)
 * der allerede henter hæftelser via /api/tinglysning/summarisk.
 *
 * @module app/components/ejendomme/BelaningsoverblikPanel
 */

'use client';

import { Landmark } from 'lucide-react';
import type { TLHaeftelse } from '@/app/api/tinglysning/summarisk/route';

interface Props {
  /** Hæftelser fra tinglysning summarisk. */
  haeftelser: TLHaeftelse[];
  /** Aktuel ejendomsværdi fra vurdering — bruges til belåningsgrad. */
  ejendomsvaerdi: number | null;
  /** Sprogkode. */
  lang: string;
}

/**
 * Kompakt belåningsoverblik med nøgletal.
 *
 * @param props - Hæftelser, ejendomsværdi, sprog
 * @returns Panel med belåningsgrad, kreditor-fordeling og renteinfo — null hvis ingen hæftelser
 */
export default function BelaningsoverblikPanel({
  haeftelser,
  ejendomsvaerdi,
  lang,
}: Props): React.ReactElement | null {
  const da = lang === 'da';
  if (haeftelser.length === 0) return null;

  // ── Beregninger ──
  const samletBeloeb = haeftelser.reduce((sum, h) => sum + (h.beloeb ?? 0), 0);

  // Belåningsgrad
  const belaningsgrad =
    ejendomsvaerdi && ejendomsvaerdi > 0 && samletBeloeb > 0
      ? Math.round((samletBeloeb / ejendomsvaerdi) * 100)
      : null;

  // Kreditor-gruppering (top 3)
  const kreditorMap = new Map<string, number>();
  for (const h of haeftelser) {
    const navn = h.kreditor ?? h.kreditorbetegnelse ?? (da ? 'Ukendt' : 'Unknown');
    kreditorMap.set(navn, (kreditorMap.get(navn) ?? 0) + (h.beloeb ?? 0));
  }
  const sortedKreditorer = Array.from(kreditorMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  // Rente-profil
  const medRente = haeftelser.filter((h) => h.rente != null && h.rente > 0);
  const gnsRente =
    medRente.length > 0
      ? medRente.reduce((sum, h) => sum + (h.rente ?? 0), 0) / medRente.length
      : null;
  const antalFast = haeftelser.filter((h) => h.renteType?.toLowerCase() === 'fast').length;
  const antalVariabel = haeftelser.filter((h) => h.renteType?.toLowerCase() === 'variabel').length;

  // Seneste tinglysningsdato
  const sortedByDate = haeftelser
    .filter((h) => h.dato)
    .sort((a, b) => (b.dato ?? '').localeCompare(a.dato ?? ''));

  // Belåningsgrad farve
  const belaningsFarve =
    belaningsgrad == null
      ? 'text-slate-400'
      : belaningsgrad <= 60
        ? 'text-emerald-400'
        : belaningsgrad <= 80
          ? 'text-amber-400'
          : 'text-red-400';

  const belaningsBg =
    belaningsgrad == null
      ? 'bg-slate-500/10 border-slate-500/20'
      : belaningsgrad <= 60
        ? 'bg-emerald-500/10 border-emerald-500/20'
        : belaningsgrad <= 80
          ? 'bg-amber-500/10 border-amber-500/20'
          : 'bg-red-500/10 border-red-500/20';

  return (
    <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Landmark className="w-4 h-4 text-purple-400" aria-hidden />
        <h3 className="text-white font-semibold text-sm">
          {da ? 'Belåningsoverblik' : 'Mortgage overview'}
        </h3>
        <span className="text-xs text-slate-500">
          ({haeftelser.length} {da ? 'pantbreve' : 'mortgages'})
        </span>
      </div>

      {/* Nøgletal grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {/* Samlet belåning */}
        <div className="bg-slate-800/40 border border-slate-700/40 rounded-lg p-3">
          <p className="text-slate-500 text-[10px] uppercase">
            {da ? 'Samlet belåning' : 'Total debt'}
          </p>
          <p className="text-white text-sm font-bold tabular-nums">
            {samletBeloeb > 0 ? `${samletBeloeb.toLocaleString('da-DK')} kr.` : '—'}
          </p>
        </div>

        {/* Belåningsgrad */}
        <div className={`rounded-lg p-3 border ${belaningsBg}`}>
          <p className="text-slate-500 text-[10px] uppercase">
            {da ? 'Belåningsgrad' : 'LTV ratio'}
          </p>
          <p className={`text-sm font-bold tabular-nums ${belaningsFarve}`}>
            {belaningsgrad != null ? `${belaningsgrad}%` : '—'}
          </p>
          {belaningsgrad != null && (
            <p className="text-slate-500 text-[10px] mt-0.5">
              {da ? 'af ejendomsværdi' : 'of property value'}
            </p>
          )}
        </div>

        {/* Antal pantbreve + seneste dato */}
        <div className="bg-slate-800/40 border border-slate-700/40 rounded-lg p-3">
          <p className="text-slate-500 text-[10px] uppercase">{da ? 'Pantbreve' : 'Mortgages'}</p>
          <p className="text-white text-sm font-bold">{haeftelser.length}</p>
          {sortedByDate[0]?.dato && (
            <p className="text-slate-500 text-[10px] mt-0.5">
              {da ? 'Seneste:' : 'Latest:'}{' '}
              {new Date(sortedByDate[0].dato).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
                year: 'numeric',
                month: 'short',
              })}
            </p>
          )}
        </div>

        {/* Gns. rente + profil */}
        <div className="bg-slate-800/40 border border-slate-700/40 rounded-lg p-3">
          <p className="text-slate-500 text-[10px] uppercase">{da ? 'Gns. rente' : 'Avg. rate'}</p>
          <p className="text-white text-sm font-bold tabular-nums">
            {gnsRente != null ? `${gnsRente.toFixed(2)}%` : '—'}
          </p>
          {(antalFast > 0 || antalVariabel > 0) && (
            <p className="text-slate-500 text-[10px] mt-0.5">
              {antalFast > 0 && (
                <span className="text-blue-400">
                  {antalFast} {da ? 'fast' : 'fixed'}
                </span>
              )}
              {antalFast > 0 && antalVariabel > 0 && ' · '}
              {antalVariabel > 0 && (
                <span className="text-amber-400">
                  {antalVariabel} {da ? 'variabel' : 'variable'}
                </span>
              )}
            </p>
          )}
        </div>
      </div>

      {/* Kreditor-fordeling */}
      {sortedKreditorer.length > 0 && samletBeloeb > 0 && (
        <div className="space-y-2">
          <p className="text-slate-400 text-xs font-medium">
            {da ? 'Kreditor-fordeling' : 'Creditor distribution'}
          </p>
          <div className="space-y-1.5">
            {sortedKreditorer.map(([navn, beloeb]) => {
              const pct = Math.round((beloeb / samletBeloeb) * 100);
              return (
                <div key={navn} className="space-y-0.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300 truncate max-w-[200px]">{navn}</span>
                    <span className="text-slate-400 tabular-nums">
                      {beloeb.toLocaleString('da-DK')} kr. ({pct}%)
                    </span>
                  </div>
                  <div className="h-1.5 bg-slate-700/40 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-purple-500/60 rounded-full"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Disclaimer */}
      <p className="text-slate-600 text-[10px] leading-relaxed">
        {da
          ? 'Baseret på tinglyste pantebreve. Restgæld kan afvige fra faktisk saldo.'
          : 'Based on registered mortgages. Outstanding balance may differ from actual balance.'}
      </p>
    </div>
  );
}
