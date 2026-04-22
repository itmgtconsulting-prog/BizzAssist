'use client';

/**
 * BIZZ-621: Cron Status Dashboard — client komponent.
 *
 * Viser live status for alle cron-jobs (schedule + seneste run + duration
 * + fejlmeddelelse). Auto-refresher hver 30. sek. for at fange nye heartbeats.
 *
 * Admin-only: /api/admin/cron-status returnerer 403 hvis bruger ikke har
 * app_metadata.isAdmin.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Clock,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Search,
} from 'lucide-react';
import { AdminNavTabs } from '../AdminNavTabs';
import { useLanguage } from '@/app/context/LanguageContext';

/** Status per cron — direct copy fra API-kontrakten */
type CronStatus = 'ok' | 'error' | 'overdue' | 'missing';

interface CronRow {
  jobName: string;
  schedule: string;
  intervalMinutes: number;
  description: string;
  lastRunAt: string | null;
  lastStatus: 'success' | 'error' | null;
  lastDurationMs: number | null;
  lastError: string | null;
  status: CronStatus;
}

interface CronStatusResponse {
  summary: { total: number; ok: number; error: number; overdue: number; missing: number };
  crons: CronRow[];
  /** BIZZ-621: Heartbeat-query fejl (fx missing table) — null hvis alt OK */
  heartbeatError?: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Formatér interval-minutter som menneske-venlig streng (fx "6h", "1d", "5m").
 */
function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  const days = Math.round(minutes / (24 * 60));
  if (days === 7) return '1w';
  return `${days}d`;
}

/**
 * Formatér "time-ago" dansk/engelsk fra ISO-timestamp til nu.
 */
function formatAgo(iso: string | null, da: boolean): string {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return da ? `${sec}s siden` : `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return da ? `${min}m siden` : `${min}m ago`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return da ? `${hour}t siden` : `${hour}h ago`;
  const day = Math.floor(hour / 24);
  return da ? `${day}d siden` : `${day}d ago`;
}

/**
 * Formatér millisekunder til menneske-venlig duration (s/ms).
 */
function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Farve + label + ikon pr. status.
 */
function statusConfig(s: CronStatus, da: boolean) {
  switch (s) {
    case 'ok':
      return {
        Icon: CheckCircle2,
        color: 'text-emerald-400',
        bg: 'bg-emerald-500/10 border-emerald-500/30',
        label: da ? 'OK' : 'OK',
      };
    case 'error':
      return {
        Icon: AlertCircle,
        color: 'text-red-400',
        bg: 'bg-red-500/10 border-red-500/30',
        label: da ? 'Fejl' : 'Error',
      };
    case 'overdue':
      return {
        Icon: AlertTriangle,
        color: 'text-amber-400',
        bg: 'bg-amber-500/10 border-amber-500/30',
        label: da ? 'Forsinket' : 'Overdue',
      };
    case 'missing':
      return {
        Icon: HelpCircle,
        color: 'text-slate-500',
        bg: 'bg-slate-700/20 border-slate-600/30',
        label: da ? 'Ingen data' : 'No data',
      };
  }
}

// ─── Komponent ──────────────────────────────────────────────────────────────

/**
 * Live status-tabel for alle cron-jobs. Auto-refresher hver 30. sek.
 *
 * @returns Admin cron-status-siden
 */
export default function CronStatusClient() {
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [data, setData] = useState<CronStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // BIZZ-739: search + status filter — aligns layout with /users + /billing
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<CronStatus | 'all'>('all');

  /**
   * Henter seneste cron-status fra API. Bruges både til første load og
   * efterfølgende auto-refresh. Signalér loading/refreshing-state separat så
   * UI'en ikke flasher ved baggrunds-opdateringer.
   */
  const fetchStatus = useCallback(
    async (isInitial = false) => {
      if (isInitial) setIsLoading(true);
      else setIsRefreshing(true);
      try {
        const res = await fetch('/api/admin/cron-status', {
          signal: AbortSignal.timeout(10000),
          cache: 'no-store',
        });
        if (!res.ok) {
          setError(da ? `HTTP ${res.status}` : `HTTP ${res.status}`);
          return;
        }
        const json = (await res.json()) as CronStatusResponse;
        setData(json);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [da]
  );

  // Initial load + 30s auto-refresh
  useEffect(() => {
    void fetchStatus(true);
    const interval = setInterval(() => void fetchStatus(false), 30_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  return (
    <div className="min-h-full bg-[#0a1020] text-white">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Back link */}
        <Link
          href="/dashboard/admin/users"
          className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white text-sm mb-6 transition-colors"
        >
          <ArrowLeft size={14} />
          {da ? 'Tilbage til admin' : 'Back to admin'}
        </Link>

        {/* Page header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
          <div>
            <h1 className="text-white text-xl font-bold">{da ? 'Cron-status' : 'Cron Status'}</h1>
            <p className="text-slate-400 text-sm mt-0.5">
              {data
                ? da
                  ? `${data.summary.ok}/${data.summary.total} OK${data.summary.error > 0 ? ` · ${data.summary.error} fejl` : ''}${data.summary.overdue > 0 ? ` · ${data.summary.overdue} forsinket` : ''}${data.summary.missing > 0 ? ` · ${data.summary.missing} uden data` : ''}`
                  : `${data.summary.ok}/${data.summary.total} OK${data.summary.error > 0 ? ` · ${data.summary.error} errors` : ''}${data.summary.overdue > 0 ? ` · ${data.summary.overdue} overdue` : ''}${data.summary.missing > 0 ? ` · ${data.summary.missing} no data` : ''}`
                : da
                  ? 'Henter status…'
                  : 'Loading status…'}
            </p>
          </div>
          <button
            onClick={() => void fetchStatus(false)}
            disabled={isRefreshing || isLoading}
            aria-label={da ? 'Opdatér' : 'Refresh'}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 border border-slate-700/50 text-slate-300 hover:text-white hover:border-slate-500 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed self-start"
          >
            <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
            {da ? 'Opdatér' : 'Refresh'}
          </button>
        </div>

        {/* Admin tab navigation — BIZZ-737: shared component */}
        <AdminNavTabs
          activeTab="cron-status"
          da={da}
          className="flex gap-1 -mb-px overflow-x-auto mb-6 border-b border-slate-700/50"
          role="tablist"
        />

        {/* BIZZ-739: KPI stats-cards — matches /dashboard/admin/users + /billing */}
        {data && !error && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2 text-slate-400 text-xs uppercase tracking-wide">
                <CheckCircle2 size={14} className="text-emerald-400" />
                {da ? 'OK' : 'OK'}
              </div>
              <p className="text-2xl font-bold text-white">
                {data.summary.ok}
                <span className="text-slate-500 text-sm font-normal ml-1">
                  / {data.summary.total}
                </span>
              </p>
            </div>
            <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2 text-slate-400 text-xs uppercase tracking-wide">
                <AlertCircle size={14} className="text-red-400" />
                {da ? 'Fejl' : 'Errors'}
              </div>
              <p className="text-2xl font-bold text-white">{data.summary.error}</p>
            </div>
            <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2 text-slate-400 text-xs uppercase tracking-wide">
                <AlertTriangle size={14} className="text-amber-400" />
                {da ? 'Forsinket' : 'Overdue'}
              </div>
              <p className="text-2xl font-bold text-white">{data.summary.overdue}</p>
            </div>
            <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2 text-slate-400 text-xs uppercase tracking-wide">
                <HelpCircle size={14} className="text-slate-500" />
                {da ? 'Ingen data' : 'No data'}
              </div>
              <p className="text-2xl font-bold text-white">{data.summary.missing}</p>
            </div>
          </div>
        )}

        {/* BIZZ-739: Search + status filter */}
        {data && !error && data.crons.length > 0 && (
          <div className="flex gap-3 items-center mb-4">
            <div className="relative flex-1 max-w-xs">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={da ? 'Søg job…' : 'Search job…'}
                className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg pl-9 pr-3 py-2 text-white text-xs placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as CronStatus | 'all')}
              className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-3 py-2 text-white text-xs focus:border-blue-500 focus:outline-none"
            >
              <option value="all">{da ? 'Alle statusser' : 'All statuses'}</option>
              <option value="ok">{da ? 'OK' : 'OK'}</option>
              <option value="error">{da ? 'Fejl' : 'Errors'}</option>
              <option value="overdue">{da ? 'Forsinket' : 'Overdue'}</option>
              <option value="missing">{da ? 'Ingen data' : 'No data'}</option>
            </select>
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-6">
            <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
            <p className="text-red-300 text-sm">{error}</p>
          </div>
        )}

        {/* BIZZ-621: Heartbeat-query-fejl surface — fx når public.cron_heartbeats
            ikke eksisterer i det supabase-miljø dashboardet kalder. Vises som
            amber advarsel, ikke rød fatal — tabellen rendres stadig med alle
            jobs markeret som "Ingen data". */}
        {data?.heartbeatError && (
          <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 mb-6">
            <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-amber-300 text-sm font-medium">
                {da ? 'Heartbeat-data kunne ikke hentes' : 'Heartbeat data unavailable'}
              </p>
              <p className="text-amber-400/80 text-xs mt-0.5">{data.heartbeatError}</p>
            </div>
          </div>
        )}

        {/* Table */}
        {data && (
          <div className="bg-[#0f172a] border border-slate-700/50 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-800/60 text-slate-400 text-xs uppercase tracking-wider">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">{da ? 'Job' : 'Job'}</th>
                  <th className="text-left px-4 py-3 font-medium">
                    {da ? 'Interval' : 'Interval'}
                  </th>
                  <th className="text-left px-4 py-3 font-medium">
                    {da ? 'Seneste run' : 'Last run'}
                  </th>
                  <th className="text-left px-4 py-3 font-medium">
                    {da ? 'Varighed' : 'Duration'}
                  </th>
                  <th className="text-left px-4 py-3 font-medium">{da ? 'Status' : 'Status'}</th>
                </tr>
              </thead>
              <tbody>
                {data.crons
                  .filter((c) => {
                    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
                    if (searchQuery.trim()) {
                      const q = searchQuery.toLowerCase();
                      if (
                        !c.jobName.toLowerCase().includes(q) &&
                        !(c.description ?? '').toLowerCase().includes(q)
                      ) {
                        return false;
                      }
                    }
                    return true;
                  })
                  .map((c) => {
                    const cfg = statusConfig(c.status, da);
                    return (
                      <tr
                        key={c.jobName}
                        className="border-t border-slate-700/30 hover:bg-slate-800/30 transition-colors"
                      >
                        <td className="px-4 py-3">
                          <div className="flex flex-col gap-0.5">
                            <span className="text-white font-mono text-xs">{c.jobName}</span>
                            <span className="text-slate-500 text-[10px]">{c.description}</span>
                            <span className="text-slate-600 text-[10px] font-mono">
                              {c.schedule}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-400 font-mono">
                          {formatInterval(c.intervalMinutes)}
                        </td>
                        <td className="px-4 py-3 text-slate-300">
                          <div className="flex flex-col gap-0.5">
                            <span className="text-xs">{formatAgo(c.lastRunAt, da)}</span>
                            {c.lastRunAt && (
                              <span className="text-slate-600 text-[10px] font-mono">
                                {new Date(c.lastRunAt).toLocaleString(da ? 'da-DK' : 'en-GB', {
                                  month: 'short',
                                  day: '2-digit',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-400 tabular-nums">
                          {formatDuration(c.lastDurationMs)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-col gap-1.5">
                            <span
                              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs font-medium w-fit ${cfg.bg} ${cfg.color}`}
                            >
                              <cfg.Icon size={12} />
                              {cfg.label}
                            </span>
                            {c.status === 'error' && c.lastError && (
                              <span
                                className="text-red-400/80 text-[10px] max-w-sm line-clamp-2"
                                title={c.lastError}
                              >
                                {c.lastError}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}

        {/* Legend */}
        <div className="flex flex-wrap gap-4 mt-6 text-xs text-slate-500">
          <span className="flex items-center gap-1.5">
            <CheckCircle2 size={12} className="text-emerald-400" /> {da ? 'OK' : 'OK'}
          </span>
          <span className="flex items-center gap-1.5">
            <AlertCircle size={12} className="text-red-400" /> {da ? 'Fejl' : 'Error'}
          </span>
          <span className="flex items-center gap-1.5">
            <AlertTriangle size={12} className="text-amber-400" />{' '}
            {da ? 'Forsinket (> 2× forventet interval)' : 'Overdue (> 2× expected interval)'}
          </span>
          <span className="flex items-center gap-1.5">
            <HelpCircle size={12} className="text-slate-500" />{' '}
            {da ? 'Ingen heartbeat endnu' : 'No heartbeat yet'}
          </span>
          <span className="flex items-center gap-1.5">
            <Clock size={12} /> {da ? 'Auto-refresh hver 30. sek' : 'Auto-refresh every 30s'}
          </span>
        </div>
      </div>
    </div>
  );
}
