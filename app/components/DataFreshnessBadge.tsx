/**
 * DataFreshnessBadge — viser hvor frisk data er.
 *
 * BIZZ-919: Indikerer om data kommer fra cache eller live API,
 * og hvor gammel cached data er.
 *
 * @param fromCache - Om data kom fra cache
 * @param syncedAt - Tidspunkt for seneste sync (ISO string)
 * @param lang - UI-sprog
 */

'use client';

import { Database, Wifi } from 'lucide-react';

interface Props {
  /** Om data kom fra cache */
  fromCache: boolean;
  /** Tidspunkt for seneste cache-sync (ISO string), null = live data */
  syncedAt?: string | null;
  /** UI-sprog */
  lang: 'da' | 'en';
}

/**
 * Formaterer tidsforskel til menneskelæsbar streng.
 */
function formatAge(iso: string, da: boolean): string {
  const age = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(age / 60000);
  if (minutes < 60) return da ? `${minutes} min siden` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return da ? `${hours} timer siden` : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return da ? `${days} dage siden` : `${days} days ago`;
}

/**
 * Kompakt badge der viser data-kilde og friskhed.
 */
export default function DataFreshnessBadge({ fromCache, syncedAt, lang }: Props) {
  const da = lang === 'da';

  if (!fromCache) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20">
        <Wifi size={9} />
        {da ? 'Live data' : 'Live data'}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] text-slate-400 bg-slate-700/30 border border-slate-700/40">
      <Database size={9} />
      {syncedAt ? formatAge(syncedAt, da) : da ? 'Cached' : 'Cached'}
    </span>
  );
}
