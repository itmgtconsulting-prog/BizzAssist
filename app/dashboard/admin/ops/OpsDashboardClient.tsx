'use client';

/**
 * BIZZ-625: Unified Ops Dashboard — client component.
 *
 * Viser én samlet oversigt over admin-ops i tile-grid: Infrastructure,
 * Crons, Service Manager, Alerts. Hver tile henter summary fra eksisterende
 * API-endpoints og drill-downer til den dedikerede sub-side ved klik.
 *
 * Admin kan svare "er alt OK?" uden at besøge 3+ forskellige admin-sider
 * (BIZZ-625 accept-criteria).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  CheckCircle2,
  Clock,
  CreditCard,
  RefreshCw,
  Settings,
  ShieldCheck,
  Timer,
  Users,
  Wrench,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Aggregated status counts for a single ops area (tile). */
interface TileStats {
  total: number;
  ok: number;
  issues: number;
  loading: boolean;
  error: string | null;
}

/** Cron-status-API's summary shape (subset vi bruger) */
interface CronSummary {
  summary: { total: number; ok: number; error: number; overdue: number; missing: number };
}

/** Service Management-API'ens response shape er bare summary via ServiceManagement UI,
 *  så vi kalder den med de samme probe-ID'er der rendres i tile'en. */

// ─── Komponent ──────────────────────────────────────────────────────────────

/**
 * Ops-dashboard client. Loader alle tile-stats parallelt ved mount + auto-
 * refresh hver 60. sek. Tile-klik navigerer til dedikeret sub-dashboard.
 *
 * @returns Admin ops-landing med 4 drill-down-tiles
 */
export default function OpsDashboardClient() {
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [cron, setCron] = useState<TileStats>({
    total: 0,
    ok: 0,
    issues: 0,
    loading: true,
    error: null,
  });
  const [isRefreshing, setIsRefreshing] = useState(false);

  /**
   * Henter cron-status summary. Andre tiles (infra/service-manager/alerts)
   * er initialt "stub" — de kan udbygges til at kalde egne summary-APIs
   * senere uden at påvirke dette layout.
   */
  const fetchCronStats = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/admin/cron-status', {
        signal: AbortSignal.timeout(10000),
        cache: 'no-store',
      });
      if (!res.ok) {
        setCron((prev) => ({ ...prev, loading: false, error: `HTTP ${res.status}` }));
        return;
      }
      const data = (await res.json()) as CronSummary;
      const issues = data.summary.error + data.summary.overdue;
      setCron({
        total: data.summary.total,
        ok: data.summary.ok,
        issues,
        loading: false,
        error: null,
      });
    } catch (err) {
      setCron((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Unknown',
      }));
    }
  }, []);

  // Initial load + periodisk refresh
  const refreshAll = useCallback(async (): Promise<void> => {
    setIsRefreshing(true);
    await Promise.allSettled([fetchCronStats()]);
    setIsRefreshing(false);
  }, [fetchCronStats]);

  useEffect(() => {
    void refreshAll();
    const interval = setInterval(() => void refreshAll(), 60_000);
    return () => clearInterval(interval);
  }, [refreshAll]);

  const totalIssues = cron.issues;

  return (
    <div className="min-h-full bg-[#0a1020] text-white">
      <div className="max-w-7xl mx-auto px-4 py-8">
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
            <h1 className="text-white text-xl font-bold">{da ? 'Operations' : 'Operations'}</h1>
            <p className="text-slate-400 text-sm mt-0.5">
              {totalIssues > 0
                ? da
                  ? `${totalIssues} åbne issues`
                  : `${totalIssues} open issues`
                : da
                  ? 'Alt OK'
                  : 'All OK'}
            </p>
          </div>
          <button
            onClick={() => void refreshAll()}
            disabled={isRefreshing}
            aria-label={da ? 'Opdatér' : 'Refresh'}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 border border-slate-700/50 text-slate-300 hover:text-white hover:border-slate-500 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed self-start"
          >
            <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
            {da ? 'Opdatér' : 'Refresh'}
          </button>
        </div>

        {/* Admin tab-navigation */}
        <div
          className="flex gap-1 -mb-px overflow-x-auto mb-6 border-b border-slate-700/50"
          role="tablist"
        >
          <Link
            href="/dashboard/admin/users"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
          >
            <Users size={14} /> {da ? 'Brugere' : 'Users'}
          </Link>
          <Link
            href="/dashboard/admin/billing"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
          >
            <CreditCard size={14} /> {da ? 'Fakturering' : 'Billing'}
          </Link>
          <Link
            href="/dashboard/admin/plans"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
          >
            <Settings size={14} /> {da ? 'Planer' : 'Plans'}
          </Link>
          <Link
            href="/dashboard/admin/analytics"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
          >
            <BarChart3 size={14} /> {da ? 'Analyse' : 'Analytics'}
          </Link>
          <Link
            href="/dashboard/admin/ai-media-agents"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap"
          >
            <Bot size={14} /> {da ? 'AI-agenter' : 'AI Agents'}
          </Link>
          <Link
            href="/dashboard/admin/security"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap"
          >
            <ShieldCheck size={14} /> {da ? 'Sikkerhed' : 'Security'}
          </Link>
          {/* Aktiv tab */}
          <span
            role="tab"
            aria-selected="true"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-blue-500 text-blue-300 font-medium cursor-default whitespace-nowrap"
          >
            <Activity size={14} /> Ops
          </span>
        </div>

        {/* Tile grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Infrastructure tile */}
          <OpsTile
            href="/dashboard/admin/service-management"
            icon={<Activity size={18} className="text-blue-400" />}
            title={da ? 'Infrastruktur' : 'Infrastructure'}
            description={da ? '13 komponenter' : '13 components'}
            hint={
              da
                ? 'Live probes for Datafordeler, Upstash, Resend, Stripe m.fl.'
                : 'Live probes for Datafordeler, Upstash, Resend, Stripe and more.'
            }
            status="unknown"
            statusLabel={da ? 'Se status' : 'View status'}
          />

          {/* Crons tile */}
          <OpsTile
            href="/dashboard/admin/cron-status"
            icon={<Timer size={18} className="text-blue-400" />}
            title={da ? 'Cron-jobs' : 'Crons'}
            description={
              cron.loading
                ? da
                  ? 'Henter…'
                  : 'Loading…'
                : cron.error
                  ? da
                    ? 'Fejl'
                    : 'Error'
                  : da
                    ? `${cron.ok}/${cron.total} OK`
                    : `${cron.ok}/${cron.total} OK`
            }
            hint={
              da
                ? 'Heartbeat-status for alle 14 daglige/ugentlige jobs.'
                : 'Heartbeat status for all 14 daily/weekly jobs.'
            }
            status={cron.loading ? 'loading' : cron.issues > 0 ? 'warning' : 'ok'}
            statusLabel={
              cron.issues > 0
                ? da
                  ? `${cron.issues} issues`
                  : `${cron.issues} issues`
                : da
                  ? 'Alt OK'
                  : 'All OK'
            }
          />

          {/* Service Manager tile */}
          <OpsTile
            href="/dashboard/admin/service-manager"
            icon={<Wrench size={18} className="text-blue-400" />}
            title={da ? 'Service Manager' : 'Service Manager'}
            description={da ? 'Auto-scan + hotfixes' : 'Auto-scan + hotfixes'}
            hint={
              da
                ? 'AI-agent der scanner Vercel-deploys + mail-alerts og foreslår fixes.'
                : 'AI agent scanning Vercel deploys + mail alerts, suggesting fixes.'
            }
            status="unknown"
            statusLabel={da ? 'Åbn manager' : 'Open manager'}
          />

          {/* Security / Alerts tile */}
          <OpsTile
            href="/dashboard/admin/security"
            icon={<ShieldCheck size={18} className="text-blue-400" />}
            title={da ? 'Sikkerhed' : 'Security'}
            description={da ? 'Audit log + alerts' : 'Audit log + alerts'}
            hint={
              da
                ? 'GDPR / ISO 27001 audit-log og åbne sikkerhedshændelser.'
                : 'GDPR / ISO 27001 audit log and open security events.'
            }
            status="unknown"
            statusLabel={da ? 'Åbn' : 'Open'}
          />
        </div>

        {/* Footer legend */}
        <div className="flex flex-wrap gap-4 mt-6 text-xs text-slate-500">
          <span className="flex items-center gap-1.5">
            <CheckCircle2 size={12} className="text-emerald-400" /> {da ? 'OK' : 'OK'}
          </span>
          <span className="flex items-center gap-1.5">
            <AlertTriangle size={12} className="text-amber-400" />{' '}
            {da ? 'Åbne issues' : 'Open issues'}
          </span>
          <span className="flex items-center gap-1.5">
            <Clock size={12} /> {da ? 'Auto-refresh 60s' : 'Auto-refresh 60s'}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Tile-komponent ─────────────────────────────────────────────────────────

interface OpsTileProps {
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  hint: string;
  status: 'ok' | 'warning' | 'loading' | 'unknown';
  statusLabel: string;
}

/**
 * Én tile i ops-grid. Hele tile'en er klikbar via Link-wrapper.
 * Status-badge matcher farver brugt på de dedikerede sub-sider.
 *
 * @param props - Tile-konfiguration
 */
function OpsTile({ href, icon, title, description, hint, status, statusLabel }: OpsTileProps) {
  const statusStyle =
    status === 'ok'
      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
      : status === 'warning'
        ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
        : status === 'loading'
          ? 'bg-slate-700/20 border-slate-600/30 text-slate-500 animate-pulse'
          : 'bg-slate-700/20 border-slate-600/30 text-slate-400';

  return (
    <Link
      href={href}
      className="group flex flex-col gap-3 bg-[#0f172a] border border-slate-700/50 rounded-xl p-5 hover:border-blue-500/40 hover:bg-[#131d36] transition-all"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-slate-800 flex items-center justify-center shrink-0">
            {icon}
          </div>
          <div>
            <h3 className="text-white font-semibold text-sm leading-tight group-hover:text-blue-300 transition-colors">
              {title}
            </h3>
            <p className="text-slate-500 text-xs mt-0.5">{description}</p>
          </div>
        </div>
      </div>
      <p className="text-slate-400 text-xs leading-relaxed flex-1">{hint}</p>
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs font-medium w-fit ${statusStyle}`}
      >
        {statusLabel}
      </span>
    </Link>
  );
}
