/**
 * ServitutterSektion — strukturerede servitutter grupperet efter type.
 *
 * BIZZ-1501: Viser servitutter fra tinglysning_servitutter med
 * farvekodning og gruppering.
 *
 * @module app/components/ejendomme/ServitutterSektion
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Shield, ChevronDown, ChevronRight } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

interface Servitut {
  type: string | null;
  beskrivelse: string | null;
  tinglysningsdato: string | null;
}

/** Farvekodning per servitut-type. */
const TYPE_COLORS: Record<string, string> = {
  fredning: 'text-red-400 bg-red-500/10 border-red-500/20',
  forbud: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  adgangsret: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  koeberet: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  default: 'text-slate-400 bg-slate-500/10 border-slate-500/20',
};

/**
 * Returner farve-klasse for en servitut-type.
 */
function getTypeColor(type: string | null): string {
  if (!type) return TYPE_COLORS.default;
  const lower = type.toLowerCase();
  for (const [key, color] of Object.entries(TYPE_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return TYPE_COLORS.default;
}

interface Props {
  /** BFE-nummer for ejendommen. */
  bfe: number;
  /** Sprogkode. */
  lang: string;
}

/**
 * Viser strukturerede servitutter grupperet efter type.
 */
export default function ServitutterSektion({ bfe, lang }: Props): React.ReactElement | null {
  const da = lang === 'da';
  const [rows, setRows] = useState<Servitut[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data } = await supabase
        .from('tinglysning_servitutter')
        .select('type, beskrivelse, tinglysningsdato')
        .eq('bfe_nummer', bfe)
        .order('tinglysningsdato', { ascending: false });
      if (data && data.length > 0) setRows(data as Servitut[]);
    } catch {
      /* non-critical */
    }
    setLoading(false);
  }, [bfe]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || rows.length === 0) return null;

  // Gruppér efter type
  const groups = new Map<string, Servitut[]>();
  for (const s of rows) {
    const key = s.type ?? (da ? 'Ukendt type' : 'Unknown type');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  return (
    <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl p-4 space-y-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-blue-400" aria-hidden />
          <h3 className="text-white font-semibold text-sm">
            {da ? 'Servitutter / Byrder' : 'Easements / Encumbrances'}
          </h3>
          <span className="text-xs text-slate-500">({rows.length})</span>
        </div>
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-slate-400" aria-hidden />
        ) : (
          <ChevronRight className="w-4 h-4 text-slate-400" aria-hidden />
        )}
      </button>
      {expanded && (
        <div className="space-y-2">
          {Array.from(groups.entries()).map(([type, items]) => (
            <div key={type}>
              <div
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-medium mb-1 ${getTypeColor(type)}`}
              >
                {type}
                <span className="text-slate-500">({items.length})</span>
              </div>
              <div className="space-y-1 ml-2">
                {items.map((s, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className="text-slate-500 whitespace-nowrap">
                      {s.tinglysningsdato
                        ? new Date(s.tinglysningsdato).toLocaleDateString('da-DK')
                        : '—'}
                    </span>
                    <span className="text-slate-300">
                      {s.beskrivelse?.slice(0, 200) ?? '(ingen beskrivelse)'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
