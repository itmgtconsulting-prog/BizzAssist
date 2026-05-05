/**
 * SyncStatusClient — admin dashboard for data pipeline health.
 *
 * BIZZ-987: Viser per-source health (BBR, CVR, DAR, VUR, EJF)
 * med farvekodede status-kort, last sync, alder, og row counts.
 * Auto-refresher hvert 60. sekund.
 *
 * @module app/dashboard/admin/sync-status/SyncStatusClient
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Database, RefreshCw, CheckCircle, AlertTriangle, XCircle, Clock } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { AdminNavTabs } from '@/app/dashboard/admin/AdminNavTabs';

/** Shape returned by /api/admin/sync-status */
interface SyncSource {
  source_name: string;
  last_sync_at: string | null;
  last_error: string | null;
  rows_synced: number | null;
  duration_ms: number | null;
  health: 'ok' | 'stale' | 'missing';
  ageHours: number;
}

/** Health → visuelt tema */
const healthConfig = {
  ok: {
    icon: CheckCircle,
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/30',
    text: 'text-emerald-400',
    labelDa: 'OK',
    labelEn: 'OK',
  },
  stale: {
    icon: AlertTriangle,
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/30',
    text: 'text-amber-400',
    labelDa: 'Forældet',
    labelEn: 'Stale',
  },
  missing: {
    icon: XCircle,
    bg: 'bg-red-500/10',
    border: 'border-red-500/30',
    text: 'text-red-400',
    labelDa: 'Mangler',
    labelEn: 'Missing',
  },
} as const;

/** Stale thresholds per source (dage) */
const thresholdDays: Record<string, number> = {
  bbr: 14,
  cvr: 2,
  dar: 60,
  vur: 60,
  ejf: 14,
};

/**
 * Formaterer alder til menneskelæsbar streng.
 */
function formatAge(hours: number, da: boolean): string {
  if (hours < 1) return da ? '< 1 time' : '< 1 hour';
  if (hours < 24) return `${hours} ${da ? 'timer' : 'hours'}`;
  const days = Math.floor(hours / 24);
  return `${days} ${da ? 'dage' : 'days'}`;
}

/**
 * Render Data Sync Status dashboard.
 */
export default function SyncStatusClient() {
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [sources, setSources] = useState<SyncSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/sync-status');
      if (res.ok) {
        const data = (await res.json()) as SyncSource[];
        setSources(data);
        setLastRefresh(new Date());
      }
    } catch {
      // Stille fejl — dashboard viser seneste data
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 60_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-white text-xl font-bold flex items-center gap-2">
          <Database size={20} className="text-blue-400" />
          {da ? 'Data Sync Status' : 'Data Sync Status'}
        </h1>
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-[10px] text-slate-500">
              {da ? 'Opdateret' : 'Updated'} {lastRefresh.toLocaleTimeString('da-DK')}
            </span>
          )}
          <button
            onClick={() => {
              setLoading(true);
              fetchStatus();
            }}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700/60 text-slate-300 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            {da ? 'Opdater' : 'Refresh'}
          </button>
        </div>
      </div>

      <AdminNavTabs activeTab="sync-status" da={da} />

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {sources.map((src) => {
          const cfg = healthConfig[src.health];
          const Icon = cfg.icon;
          const threshold = thresholdDays[src.source_name] ?? 14;

          return (
            <div key={src.source_name} className={`rounded-xl p-4 border ${cfg.bg} ${cfg.border}`}>
              {/* Header */}
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-white font-semibold text-sm uppercase tracking-wider">
                  {src.source_name}
                </h3>
                <span className={`flex items-center gap-1 text-xs font-medium ${cfg.text}`}>
                  <Icon size={14} />
                  {da ? cfg.labelDa : cfg.labelEn}
                </span>
              </div>

              {/* Stats */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500 text-xs">
                    {da ? 'Seneste sync' : 'Last sync'}
                  </span>
                  <span className="text-slate-300 text-xs font-medium">
                    {src.last_sync_at
                      ? new Date(src.last_sync_at).toLocaleString('da-DK', {
                          day: '2-digit',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : '—'}
                  </span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-500 text-xs flex items-center gap-1">
                    <Clock size={10} />
                    {da ? 'Alder' : 'Age'}
                  </span>
                  <span
                    className={`text-xs font-medium ${
                      src.health === 'ok' ? 'text-slate-300' : cfg.text
                    }`}
                  >
                    {src.last_sync_at ? formatAge(src.ageHours, da) : '—'}
                  </span>
                </div>

                {src.rows_synced != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 text-xs">
                      {da ? 'Rows synced' : 'Rows synced'}
                    </span>
                    <span className="text-slate-300 text-xs font-medium">
                      {src.rows_synced.toLocaleString('da-DK')}
                    </span>
                  </div>
                )}

                {src.duration_ms != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 text-xs">{da ? 'Varighed' : 'Duration'}</span>
                    <span className="text-slate-300 text-xs font-medium">
                      {src.duration_ms < 1000
                        ? `${src.duration_ms} ms`
                        : `${(src.duration_ms / 1000).toFixed(1)} s`}
                    </span>
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <span className="text-slate-500 text-xs">{da ? 'Threshold' : 'Threshold'}</span>
                  <span className="text-slate-400 text-xs">
                    {threshold} {da ? 'dage' : 'days'}
                  </span>
                </div>

                {src.last_error && (
                  <div className="mt-2 p-2 rounded bg-red-500/5 border border-red-500/20">
                    <p
                      className="text-red-400 text-[10px] font-mono truncate"
                      title={src.last_error}
                    >
                      {src.last_error}
                    </p>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {sources.length === 0 && !loading && (
          <div className="col-span-full text-center py-12 text-slate-500 text-sm">
            {da
              ? 'Ingen datakilder konfigureret i data_sync_status.'
              : 'No data sources configured in data_sync_status.'}
          </div>
        )}

        {loading && sources.length === 0 && (
          <div className="col-span-full flex items-center justify-center gap-2 py-12 text-slate-500 text-sm">
            <RefreshCw size={14} className="animate-spin" />
            {da ? 'Henter sync-status...' : 'Loading sync status...'}
          </div>
        )}
      </div>
    </div>
  );
}
