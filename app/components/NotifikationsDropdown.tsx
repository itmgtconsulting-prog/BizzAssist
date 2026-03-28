'use client';

/**
 * Notifikations-dropdown — vises som bell-ikon i dashboard topbar.
 *
 * Viser:
 *   - Antal ulæste notifikationer som badge
 *   - Liste over fulgte ejendomme med ændringsnotifikationer
 *   - "Marker alle som læst" og link til fulgte ejendomme
 *
 * Datakilde:
 *   - Primært: Supabase via /api/notifications + /api/tracked (når auth er aktiv)
 *   - Fallback: localStorage via trackedEjendomme.ts (dev / offline)
 *
 * Hybridtilgang: prøver Supabase først, falder tilbage til localStorage
 * hvis brugeren ikke er logget ind. Supabase-data har højere prioritet.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellOff, Building2, CheckCheck, ChevronRight, X } from 'lucide-react';
import {
  hentTrackedEjendomme,
  hentNotifikationer,
  antalUlaesteNotifikationer,
  markerAlleSomLaest,
  markerSomLaest,
  untrackEjendom,
  type TrackedEjendom,
  type EjendomNotifikation,
} from '@/app/lib/trackedEjendomme';

/** Props for NotifikationsDropdown */
interface NotifikationsDropdownProps {
  /** Sprog — 'da' eller 'en' */
  lang: 'da' | 'en';
}

/**
 * Bell-ikon med dropdown der viser fulgte ejendomme og notifikationer.
 * Click-away lukker dropdown. Badge viser antal ulæste.
 *
 * @param props - Sprog-prop fra layout
 */
export default function NotifikationsDropdown({ lang }: NotifikationsDropdownProps) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [tracked, setTracked] = useState<TrackedEjendom[]>([]);
  const [notifs, setNotifs] = useState<EjendomNotifikation[]>([]);
  const [ulaesteCount, setUlaesteCount] = useState(0);
  const [tab, setTab] = useState<'notifikationer' | 'fulgte'>('notifikationer');

  /** Om vi har Supabase-data (logget ind) */
  const [harSupabase, setHarSupabase] = useState(false);

  /**
   * Genindlæser data — prøver Supabase først, falder tilbage til localStorage.
   * Supabase-kald er asynkrone; localStorage er synkront og bruges som fallback.
   */
  const refresh = useCallback(async () => {
    // Altid indlæs localStorage som baseline
    const lsTracked = hentTrackedEjendomme();
    const lsNotifs = hentNotifikationer();
    const lsUlaeste = antalUlaesteNotifikationer();
    setTracked(lsTracked);
    setNotifs(lsNotifs);
    setUlaesteCount(lsUlaeste);

    // Forsøg Supabase for rigtige data
    try {
      const [trackedRes, notifsRes] = await Promise.all([
        fetch('/api/tracked').then((r) => r.json()),
        fetch('/api/notifications').then((r) => r.json()),
      ]);

      // Hvis vi fik Supabase-data med indhold, brug det
      if (trackedRes.tracked?.length > 0 || notifsRes.notifications?.length > 0) {
        setHarSupabase(true);

        if (trackedRes.tracked) {
          setTracked(
            trackedRes.tracked.map((e: Record<string, unknown>) => ({
              id: e.entity_id as string,
              adresse: (e.label as string) || (e.entity_id as string),
              postnr: ((e.entity_data as Record<string, unknown>)?.postnr as string) || '',
              by: ((e.entity_data as Record<string, unknown>)?.by as string) || '',
              kommune: ((e.entity_data as Record<string, unknown>)?.kommune as string) || '',
              anvendelse:
                ((e.entity_data as Record<string, unknown>)?.anvendelse as string) || null,
              trackedSiden: new Date(e.created_at as string).getTime(),
            }))
          );
        }

        if (notifsRes.notifications) {
          setNotifs(
            notifsRes.notifications.map((n: Record<string, unknown>) => ({
              id: n.id as string,
              ejendomId: n.entity_id as string,
              adresse: n.title as string,
              type: (n.notification_type as string) || 'generel',
              besked: n.message as string,
              tidspunkt: new Date(n.created_at as string).getTime(),
              laest: n.is_read as boolean,
            }))
          );
          const unreadCount = notifsRes.notifications.filter(
            (n: Record<string, unknown>) => !n.is_read
          ).length;
          setUlaesteCount(unreadCount);
        }
      }
    } catch {
      // Supabase ikke tilgængelig — localStorage-data er allerede sat
    }
  }, []);

  // Indlæs data ved mount og når dropdown åbnes
  useEffect(() => {
    refresh();
  }, [open, refresh]);

  // Lyt efter storage-events (ændringer fra andre tabs / ejendomsdetalje)
  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener('storage', handler);
    // Custom event for intra-tab opdateringer
    window.addEventListener('ba-tracked-changed', handler);
    return () => {
      window.removeEventListener('storage', handler);
      window.removeEventListener('ba-tracked-changed', handler);
    };
  }, [refresh]);

  // Click-away
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  /** Håndter klik på en fulgt ejendom — navigér til detaljesiden */
  const handleEjendomClick = (id: string) => {
    setOpen(false);
    router.push(`/dashboard/ejendomme/${id}`);
  };

  /** Håndter klik på en notifikation */
  const handleNotifClick = (notif: EjendomNotifikation) => {
    markerSomLaest(notif.id);
    // Marker også som læst i Supabase
    if (harSupabase) {
      fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_read', id: notif.id }),
      }).catch(() => {});
    }
    refresh();
    setOpen(false);
    router.push(`/dashboard/ejendomme/${notif.ejendomId}`);
  };

  /** Stop tracking fra dropdown */
  const handleUntrack = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    untrackEjendom(id);
    // Fjern også fra Supabase
    if (harSupabase) {
      fetch(`/api/tracked?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    }
    window.dispatchEvent(new Event('ba-tracked-changed'));
    refresh();
  };

  /** Marker alle som læst */
  const handleMarkerAlle = () => {
    markerAlleSomLaest();
    // Marker også i Supabase
    if (harSupabase) {
      fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_all_read' }),
      }).catch(() => {});
    }
    refresh();
  };

  const t = {
    notifikationer: lang === 'da' ? 'Notifikationer' : 'Notifications',
    fulgte: lang === 'da' ? 'Fulgte ejendomme' : 'Tracked properties',
    ingenNotifikationer: lang === 'da' ? 'Ingen notifikationer' : 'No notifications',
    ingenFulgte:
      lang === 'da' ? 'Du følger ingen ejendomme endnu' : 'You are not tracking any properties yet',
    ingenFulgteHint:
      lang === 'da'
        ? 'Tryk "Følg" på en ejendomsside for at modtage notifikationer om ændringer.'
        : 'Click "Follow" on a property page to receive change notifications.',
    markerAlle: lang === 'da' ? 'Marker alle som læst' : 'Mark all as read',
    stopFoelg: lang === 'da' ? 'Stop følg' : 'Unfollow',
    fulgtSiden: lang === 'da' ? 'Fulgt siden' : 'Tracked since',
    notifikationerKommer:
      lang === 'da'
        ? 'Notifikationer om ændringer i BBR, vurdering og ejerskab vises her.'
        : 'Notifications about BBR, valuation and ownership changes will appear here.',
  };

  return (
    <div className="relative" ref={ref}>
      {/* Bell-knap */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-xl transition-colors"
        aria-label={t.notifikationer}
      >
        <Bell size={20} />
        {(ulaesteCount > 0 || tracked.length > 0) && (
          <span
            className={`absolute top-1.5 right-1.5 flex items-center justify-center rounded-full text-[9px] font-bold text-white transition-all ${
              ulaesteCount > 0
                ? 'min-w-[16px] h-4 px-1 bg-red-500 animate-pulse'
                : 'w-2 h-2 bg-blue-600'
            }`}
          >
            {ulaesteCount > 0 ? (ulaesteCount > 9 ? '9+' : ulaesteCount) : ''}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-11 w-80 bg-[#1e293b] border border-white/10 rounded-2xl shadow-2xl overflow-hidden z-50">
          {/* Tabs */}
          <div className="flex border-b border-white/10">
            <button
              onClick={() => setTab('notifikationer')}
              className={`flex-1 px-4 py-2.5 text-xs font-semibold transition-colors ${
                tab === 'notifikationer'
                  ? 'text-white border-b-2 border-blue-500'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {t.notifikationer}
              {ulaesteCount > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded-full text-[10px]">
                  {ulaesteCount}
                </span>
              )}
            </button>
            <button
              onClick={() => setTab('fulgte')}
              className={`flex-1 px-4 py-2.5 text-xs font-semibold transition-colors ${
                tab === 'fulgte'
                  ? 'text-white border-b-2 border-blue-500'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {t.fulgte}
              {tracked.length > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded-full text-[10px]">
                  {tracked.length}
                </span>
              )}
            </button>
          </div>

          {/* Notifikationer-tab */}
          {tab === 'notifikationer' && (
            <div className="max-h-80 overflow-y-auto">
              {notifs.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <Bell size={28} className="mx-auto mb-3 text-slate-600" />
                  <p className="text-slate-400 text-sm">{t.ingenNotifikationer}</p>
                  <p className="text-slate-500 text-xs mt-2 leading-relaxed">
                    {t.notifikationerKommer}
                  </p>
                </div>
              ) : (
                <>
                  {/* Marker alle som læst */}
                  {ulaesteCount > 0 && (
                    <button
                      onClick={handleMarkerAlle}
                      className="w-full flex items-center gap-2 px-4 py-2 text-xs text-blue-400 hover:text-blue-300 hover:bg-white/5 transition-colors"
                    >
                      <CheckCheck size={13} /> {t.markerAlle}
                    </button>
                  )}
                  {notifs.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => handleNotifClick(n)}
                      className={`w-full text-left px-4 py-3 hover:bg-white/5 transition-colors border-b border-white/5 last:border-0 ${
                        n.laest ? 'opacity-60' : ''
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        {!n.laest && (
                          <span className="mt-1.5 w-2 h-2 bg-blue-500 rounded-full flex-shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-white text-sm font-medium truncate">{n.adresse}</p>
                          <p className="text-slate-400 text-xs mt-0.5">{n.besked}</p>
                          <p className="text-slate-500 text-[10px] mt-1">
                            {new Date(n.tidspunkt).toLocaleDateString(
                              lang === 'da' ? 'da-DK' : 'en-GB',
                              {
                                day: 'numeric',
                                month: 'short',
                                hour: '2-digit',
                                minute: '2-digit',
                              }
                            )}
                          </p>
                        </div>
                      </div>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}

          {/* Fulgte ejendomme-tab */}
          {tab === 'fulgte' && (
            <div className="max-h-80 overflow-y-auto">
              {tracked.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <BellOff size={28} className="mx-auto mb-3 text-slate-600" />
                  <p className="text-slate-400 text-sm">{t.ingenFulgte}</p>
                  <p className="text-slate-500 text-xs mt-2 leading-relaxed px-2">
                    {t.ingenFulgteHint}
                  </p>
                </div>
              ) : (
                tracked.map((ej) => (
                  <div
                    key={ej.id}
                    onClick={() => handleEjendomClick(ej.id)}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors cursor-pointer border-b border-white/5 last:border-0 group"
                  >
                    <div className="w-8 h-8 bg-blue-600/20 rounded-lg flex items-center justify-center flex-shrink-0">
                      <Building2 size={14} className="text-blue-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-white text-sm font-medium truncate">{ej.adresse}</p>
                      <p className="text-slate-500 text-xs truncate">
                        {ej.postnr} {ej.by}
                        {ej.kommune ? ` · ${ej.kommune}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={(e) => handleUntrack(e, ej.id)}
                        className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                        title={t.stopFoelg}
                      >
                        <X size={13} />
                      </button>
                      <ChevronRight size={14} className="text-slate-600" />
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
