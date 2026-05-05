/**
 * EnergimaerkeBadge — viser energiklasse (A-G) som farvet badge.
 *
 * BIZZ-1030: Kompakt visning af ejendommens energimærke på Overblik-fanen.
 * Viser nyeste gyldige energiklasse med farvekode og gyldigheds-info.
 * Klikbar — linker til Dokumenter-fanen for fuld PDF-visning.
 *
 * @param energimaerker - Array af EnergimaerkeItem fra /api/energimaerke
 * @param lang - 'da' | 'en'
 * @param onNavigate - Callback til at skifte til Dokumenter-fanen
 */

'use client';

import { Leaf, FileText } from 'lucide-react';
import type { EnergimaerkeItem, EnergiKlasse } from '@/app/api/energimaerke/route';

interface Props {
  /** Energimærkerapporter — nyeste først */
  energimaerker: EnergimaerkeItem[] | null;
  /** true mens data hentes */
  loading: boolean;
  /** Sprogvalg */
  lang: 'da' | 'en';
  /** Callback til at navigere til Dokumenter-fanen */
  onNavigate?: () => void;
}

/** Farvekoder for energiklasser (A = grøn → G = rød) */
const KLASSE_FARVER: Record<string, { bg: string; border: string; text: string }> = {
  A2020: { bg: 'bg-green-500/20', border: 'border-green-500/50', text: 'text-green-300' },
  A2015: { bg: 'bg-green-500/20', border: 'border-green-500/50', text: 'text-green-300' },
  A: { bg: 'bg-green-500/20', border: 'border-green-500/50', text: 'text-green-300' },
  B: { bg: 'bg-lime-500/20', border: 'border-lime-500/50', text: 'text-lime-300' },
  C: { bg: 'bg-yellow-500/20', border: 'border-yellow-500/50', text: 'text-yellow-300' },
  D: { bg: 'bg-amber-500/20', border: 'border-amber-500/50', text: 'text-amber-300' },
  E: { bg: 'bg-orange-500/20', border: 'border-orange-500/50', text: 'text-orange-300' },
  F: { bg: 'bg-red-500/20', border: 'border-red-500/50', text: 'text-red-300' },
  G: { bg: 'bg-red-600/20', border: 'border-red-600/50', text: 'text-red-400' },
};

/**
 * Returnerer farve-klasser for en given energiklasse.
 *
 * @param klasse - Energiklasse (A2020, A, B, C, D, E, F, G)
 * @returns Tailwind farve-klasser
 */
function klasseStyle(klasse: EnergiKlasse): { bg: string; border: string; text: string } {
  return (
    KLASSE_FARVER[klasse] ?? {
      bg: 'bg-slate-500/20',
      border: 'border-slate-500/50',
      text: 'text-slate-300',
    }
  );
}

export default function EnergimaerkeBadge({ energimaerker, loading, lang, onNavigate }: Props) {
  const da = lang === 'da';

  if (loading) return null;
  if (!energimaerker || energimaerker.length === 0) return null;

  /* Find nyeste gyldige mærke — foretruk "Gyldig" status, ellers nyeste */
  const gyldigeMaerker = energimaerker.filter((m) => m.status === 'Gyldig');
  const nyeste = gyldigeMaerker.length > 0 ? gyldigeMaerker[0] : energimaerker[0];
  if (!nyeste.klasse) return null;

  const style = klasseStyle(nyeste.klasse);

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={onNavigate}
        className="w-full text-left bg-slate-800/30 border border-slate-700/30 rounded-xl p-3 hover:bg-slate-800/50 transition-colors group"
        title={
          da ? 'Se energimærkerapporter i Dokumenter' : 'View energy label reports in Documents'
        }
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Leaf size={14} className="text-green-400" />
            <span className="text-slate-400 text-xs font-medium uppercase tracking-wider">
              {da ? 'Energimærke' : 'Energy label'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center justify-center px-2.5 py-1 rounded-lg text-sm font-bold border ${style.bg} ${style.border} ${style.text}`}
            >
              {nyeste.klasse}
            </span>
            <FileText
              size={12}
              className="text-slate-600 group-hover:text-slate-400 transition-colors"
            />
          </div>
        </div>
        {nyeste.udloeber && (
          <p className="text-slate-600 text-[10px] mt-1">
            {da ? 'Gyldig til' : 'Valid until'} {nyeste.udloeber}
          </p>
        )}
      </button>
    </div>
  );
}
