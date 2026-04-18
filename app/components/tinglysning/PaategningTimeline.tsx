'use client';

/**
 * PaategningTimeline — BIZZ-522.
 *
 * Viser revisionshistorik (påtegninger) for et tinglyst dokument som en
 * kompakt timeline. Henter data lazy ved første expansion så listen ikke
 * rammer e-TL per dokument på side-load.
 *
 * Bruges i Tinglysning-tab'en ved siden af hvert dokument med dokumentId —
 * fx pantebreve i bilbog/andelsbog/fast ejendom. Én knap pr. dokument:
 * "Vis revisionshistorik" folder timelinen ud.
 */

import { useCallback, useState } from 'react';
import { Download, Clock, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import type { PaategningRevision } from '@/app/api/tinglysning/paategning/route';

interface Props {
  /** Dokument-UUID — brugen som query til /api/tinglysning/paategning */
  dokumentId: string;
  /** Valgfrit fallback-label hvis historikken endnu ikke er hentet */
  label?: string;
  /** Sprog for labels */
  lang: 'da' | 'en';
}

/**
 * Inline-ekspander der henter og viser revisionshistorik for ét dokument.
 */
export default function PaategningTimeline({ dokumentId, label, lang }: Props) {
  const da = lang === 'da';
  const [open, setOpen] = useState(false);
  const [revisioner, setRevisioner] = useState<PaategningRevision[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (!next || revisioner !== null || loading) return;

    setLoading(true);
    setFejl(null);
    try {
      const res = await fetch(`/api/tinglysning/paategning?uuid=${encodeURIComponent(dokumentId)}`);
      const json = await res.json();
      if (!res.ok) {
        setFejl(json.error ?? (da ? 'Kunne ikke hente historik' : 'Could not load history'));
        return;
      }
      if (json.fejl) {
        setFejl(json.fejl);
        return;
      }
      setRevisioner((json.revisioner ?? []) as PaategningRevision[]);
    } catch {
      setFejl(da ? 'Kunne ikke hente historik' : 'Could not load history');
    } finally {
      setLoading(false);
    }
  }, [open, revisioner, loading, dokumentId, da]);

  return (
    <div className="inline-block w-full">
      <button
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-1 text-[10px] text-slate-400 hover:text-slate-200 transition-colors"
        aria-expanded={open}
      >
        {loading ? (
          <Loader2 size={10} className="animate-spin" />
        ) : open ? (
          <ChevronDown size={10} />
        ) : (
          <ChevronRight size={10} />
        )}
        <Clock size={10} />
        {label ?? (da ? 'Vis revisionshistorik' : 'Show revision history')}
      </button>

      {open && (
        <div className="mt-2 ml-4 border-l border-slate-700/40 pl-3">
          {fejl && <div className="text-[10px] text-red-400">{fejl}</div>}
          {!fejl && revisioner !== null && revisioner.length === 0 && (
            <div className="text-[10px] text-slate-500 italic">
              {da ? 'Ingen registrerede påtegninger' : 'No registered amendments'}
            </div>
          )}
          {revisioner !== null && revisioner.length > 0 && (
            <ol className="space-y-1.5">
              {revisioner.map((r, i) => (
                <li
                  key={`${dokumentId}-rev-${r.nummer ?? i}`}
                  className="flex flex-wrap items-baseline gap-x-2 text-[10px] text-slate-400"
                >
                  {r.dato && <span className="text-slate-500 font-mono">{r.dato}</span>}
                  <span className="text-slate-200">{r.type}</span>
                  {r.nummer != null && <span className="text-slate-600">#{r.nummer}</span>}
                  {r.beskrivelse && <span className="text-slate-400">— {r.beskrivelse}</span>}
                  {r.anmelderNavn && <span className="text-slate-600">({r.anmelderNavn})</span>}
                  {r.dokumentId && (
                    <a
                      href={`/api/tinglysning/dokument?uuid=${r.dokumentId}`}
                      download
                      className="inline-flex items-center gap-0.5 text-blue-400 hover:text-blue-300"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Download size={9} /> PDF
                    </a>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
