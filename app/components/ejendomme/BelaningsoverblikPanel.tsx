/**
 * BelaningsoverblikPanel — Kompakt belåningsoverblik i Økonomi-tabben.
 *
 * Viser:
 *   - Samlet belåning (sum af hovedstol fra tinglysning_haeftelser)
 *   - Belåningsgrad i % (total gæld / ejendomsværdi)
 *   - Kreditor-fordeling (top kreditorer grupperet)
 *   - Rente-gennemsnit
 *
 * BIZZ-1520: Nyt panel — giver hurtigt finansielt overblik uden at skifte
 * til Tinglysning-tabben. Henter fra tinglysning_haeftelser (cache-first).
 *
 * @module app/components/ejendomme/BelaningsoverblikPanel
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Landmark } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

interface Haeftelse {
  type: string | null;
  kreditor_navn: string | null;
  hovedstol: number | null;
  restgaeld: number | null;
  rente_pct: number | null;
  tinglysningsdato: string | null;
}

interface Props {
  /** BFE-nummer for ejendommen. */
  bfe: number;
  /** Aktuel ejendomsværdi fra vurdering — bruges til belåningsgrad. */
  ejendomsvaerdi: number | null;
  /** Sprogkode. */
  lang: string;
}

/**
 * Kompakt belåningsoverblik med nøgletal.
 *
 * @param props - BFE, ejendomsværdi, sprog
 * @returns Panel med belåningsgrad, kreditor-fordeling og renteinfo
 */
export default function BelaningsoverblikPanel({
  bfe,
  ejendomsvaerdi,
  lang,
}: Props): React.ReactElement | null {
  const da = lang === 'da';
  const [rows, setRows] = useState<Haeftelse[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data } = await supabase
        .from('tinglysning_haeftelser')
        .select('type, kreditor_navn, hovedstol, restgaeld, rente_pct, tinglysningsdato')
        .eq('bfe_nummer', bfe)
        .order('tinglysningsdato', { ascending: false });
      if (data && data.length > 0) setRows(data as Haeftelse[]);
    } catch {
      /* non-critical */
    }
    setLoading(false);
  }, [bfe]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || rows.length === 0) return null;

  // ── Beregninger ──
  const samletHovedstol = rows.reduce((sum, h) => sum + (h.hovedstol ?? 0), 0);
  const samletRestgaeld = rows.reduce((sum, h) => sum + (h.restgaeld ?? 0), 0);
  // Brug restgæld hvis tilgængelig, ellers hovedstol
  const effektivGaeld = samletRestgaeld > 0 ? samletRestgaeld : samletHovedstol;

  // Belåningsgrad
  const belaningsgrad =
    ejendomsvaerdi && ejendomsvaerdi > 0
      ? Math.round((effektivGaeld / ejendomsvaerdi) * 100)
      : null;

  // Kreditor-gruppering (top 3)
  const kreditorMap = new Map<string, number>();
  for (const h of rows) {
    const navn = h.kreditor_navn ?? (da ? 'Ukendt' : 'Unknown');
    kreditorMap.set(navn, (kreditorMap.get(navn) ?? 0) + (h.hovedstol ?? 0));
  }
  const sortedKreditorer = Array.from(kreditorMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  // Rente-gennemsnit (kun for rækker med rente)
  const medRente = rows.filter((h) => h.rente_pct != null && h.rente_pct > 0);
  const gnsRente =
    medRente.length > 0
      ? medRente.reduce((sum, h) => sum + (h.rente_pct ?? 0), 0) / medRente.length
      : null;

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
          ({rows.length} {da ? 'pantbreve' : 'mortgages'})
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
            {effektivGaeld > 0 ? `${effektivGaeld.toLocaleString('da-DK')} kr.` : '—'}
          </p>
          {samletRestgaeld > 0 && samletRestgaeld !== samletHovedstol && (
            <p className="text-slate-500 text-[10px] mt-0.5">
              {da ? 'Hovedstol:' : 'Principal:'} {samletHovedstol.toLocaleString('da-DK')} kr.
            </p>
          )}
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

        {/* Antal pantbreve */}
        <div className="bg-slate-800/40 border border-slate-700/40 rounded-lg p-3">
          <p className="text-slate-500 text-[10px] uppercase">{da ? 'Pantbreve' : 'Mortgages'}</p>
          <p className="text-white text-sm font-bold">{rows.length}</p>
          {rows[0]?.tinglysningsdato && (
            <p className="text-slate-500 text-[10px] mt-0.5">
              {da ? 'Seneste:' : 'Latest:'}{' '}
              {new Date(rows[0].tinglysningsdato).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
                year: 'numeric',
                month: 'short',
              })}
            </p>
          )}
        </div>

        {/* Gns. rente */}
        <div className="bg-slate-800/40 border border-slate-700/40 rounded-lg p-3">
          <p className="text-slate-500 text-[10px] uppercase">{da ? 'Gns. rente' : 'Avg. rate'}</p>
          <p className="text-white text-sm font-bold tabular-nums">
            {gnsRente != null ? `${gnsRente.toFixed(2)}%` : '—'}
          </p>
          {medRente.length > 0 && medRente.length < rows.length && (
            <p className="text-slate-500 text-[10px] mt-0.5">
              ({medRente.length}/{rows.length} {da ? 'med rente' : 'with rate'})
            </p>
          )}
        </div>
      </div>

      {/* Kreditor-fordeling */}
      {sortedKreditorer.length > 0 && samletHovedstol > 0 && (
        <div className="space-y-2">
          <p className="text-slate-400 text-xs font-medium">
            {da ? 'Kreditor-fordeling' : 'Creditor distribution'}
          </p>
          <div className="space-y-1.5">
            {sortedKreditorer.map(([navn, beloeb]) => {
              const pct = Math.round((beloeb / samletHovedstol) * 100);
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
