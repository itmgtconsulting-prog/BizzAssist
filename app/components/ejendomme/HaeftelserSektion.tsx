/**
 * HaeftelserSektion — viser hæftelser/gæld fra tinglysning_haeftelser.
 *
 * BIZZ-1498: Struktureret visning af pantbreve med kreditor, beløb, rente.
 * Henter fra lokale tabeller (cache-first) eller live API.
 *
 * @module app/components/ejendomme/HaeftelserSektion
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Landmark, ChevronDown, ChevronRight } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

interface Haeftelse {
  type: string | null;
  kreditor_navn: string | null;
  hovedstol: number | null;
  rente_pct: number | null;
  tinglysningsdato: string | null;
}

interface Props {
  /** BFE-nummer for ejendommen. */
  bfe: number;
  /** Sprogkode. */
  lang: string;
}

/**
 * Viser hæftelser/pantbreve for en ejendom.
 */
export default function HaeftelserSektion({ bfe, lang }: Props): React.ReactElement | null {
  const da = lang === 'da';
  const [rows, setRows] = useState<Haeftelse[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data } = await supabase
        .from('tinglysning_haeftelser')
        .select('type, kreditor_navn, hovedstol, rente_pct, tinglysningsdato')
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

  const samletGaeld = rows.reduce((sum, h) => sum + (h.hovedstol ?? 0), 0);

  return (
    <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl p-4 space-y-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <Landmark className="w-4 h-4 text-amber-400" aria-hidden />
          <h3 className="text-white font-semibold text-sm">
            {da ? 'Hæftelser / Pantbreve' : 'Mortgages / Liens'}
          </h3>
          <span className="text-xs text-slate-500">({rows.length})</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-amber-400 font-medium">
            {samletGaeld > 0 ? `${samletGaeld.toLocaleString('da-DK')} DKK` : '—'}
          </span>
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-slate-400" aria-hidden />
          ) : (
            <ChevronRight className="w-4 h-4 text-slate-400" aria-hidden />
          )}
        </div>
      </button>
      {expanded && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-700/30 text-slate-500 uppercase tracking-wider">
                <th className="text-left py-2 px-2">{da ? 'Type' : 'Type'}</th>
                <th className="text-left py-2 px-2">{da ? 'Kreditor' : 'Creditor'}</th>
                <th className="text-right py-2 px-2">{da ? 'Hovedstol' : 'Principal'}</th>
                <th className="text-right py-2 px-2">{da ? 'Rente' : 'Rate'}</th>
                <th className="text-right py-2 px-2">{da ? 'Dato' : 'Date'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h, i) => (
                <tr key={i} className="border-b border-slate-800/30 hover:bg-slate-800/20">
                  <td className="py-1.5 px-2 text-slate-300">{h.type ?? '—'}</td>
                  <td className="py-1.5 px-2 text-slate-200">{h.kreditor_navn ?? '—'}</td>
                  <td className="py-1.5 px-2 text-right text-amber-300">
                    {h.hovedstol ? `${h.hovedstol.toLocaleString('da-DK')} DKK` : '—'}
                  </td>
                  <td className="py-1.5 px-2 text-right text-slate-400">
                    {h.rente_pct != null ? `${h.rente_pct}%` : '—'}
                  </td>
                  <td className="py-1.5 px-2 text-right text-slate-500">
                    {h.tinglysningsdato
                      ? new Date(h.tinglysningsdato).toLocaleDateString('da-DK')
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
