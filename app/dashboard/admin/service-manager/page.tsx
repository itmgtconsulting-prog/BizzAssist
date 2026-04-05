'use client';

/**
 * Service Manager admin page — /dashboard/admin/service-manager
 *
 * Monitoring dashboard for the BizzAssist platform (BIZZ-86).
 * Shows:
 *   - Recent Vercel deployments with build status
 *   - History of automated bug scans with categorised issues
 *   - "Run Bug Scan" button that triggers a new scan
 *
 * Data is fetched from:
 *   - GET /api/admin/service-manager — deployments + scan history
 *   - POST /api/admin/service-manager { action: 'scan' } — trigger scan
 *
 * Only accessible by admin users (app_metadata.isAdmin === true).
 * Polling every 5 seconds when a scan is in progress.
 *
 * @see app/api/admin/service-manager/route.ts — API route
 * @see app/api/admin/service-manager/scan/route.ts — scan implementation
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Activity,
  Play,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Rocket,
  Bug,
  Settings,
  BarChart3,
  Bot,
  ShieldCheck,
  Users,
  CreditCard,
  AlertCircle,
  Wrench,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import type {
  VercelDeployment,
  ScanRecord,
  ScanIssue,
} from '@/app/api/admin/service-manager/route';

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * Badge showing a Vercel deployment state with appropriate colour.
 *
 * @param state - The Vercel deployment state string.
 */
function DeploymentStateBadge({ state }: { state: string }) {
  const config: Record<string, { label: string; className: string; icon: React.ReactNode }> = {
    READY: {
      label: 'Ready',
      className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
      icon: <CheckCircle2 size={11} />,
    },
    ERROR: {
      label: 'Failed',
      className: 'bg-red-500/15 text-red-400 border-red-500/30',
      icon: <XCircle size={11} />,
    },
    BUILDING: {
      label: 'Building',
      className: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
      icon: <Loader2 size={11} className="animate-spin" />,
    },
    QUEUED: {
      label: 'Queued',
      className: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
      icon: <Clock size={11} />,
    },
    CANCELED: {
      label: 'Canceled',
      className: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
      icon: <XCircle size={11} />,
    },
  };
  const c = config[state] ?? {
    label: state,
    className: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
    icon: <Clock size={11} />,
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${c.className}`}
    >
      {c.icon} {c.label}
    </span>
  );
}

/**
 * Badge for a scan's overall status.
 *
 * @param status - 'running' | 'completed' | 'failed'
 * @param da - Whether to use Danish labels.
 */
function ScanStatusBadge({ status, da }: { status: ScanRecord['status']; da: boolean }) {
  const config: Record<
    ScanRecord['status'],
    { label: string; className: string; icon: React.ReactNode }
  > = {
    running: {
      label: da ? 'Kører' : 'Running',
      className: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
      icon: <Loader2 size={11} className="animate-spin" />,
    },
    completed: {
      label: da ? 'Færdig' : 'Done',
      className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
      icon: <CheckCircle2 size={11} />,
    },
    failed: {
      label: da ? 'Fejlet' : 'Failed',
      className: 'bg-red-500/15 text-red-400 border-red-500/30',
      icon: <XCircle size={11} />,
    },
  };
  const c = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${c.className}`}
    >
      {c.icon} {c.label}
    </span>
  );
}

/**
 * Badge for a single scan issue type.
 *
 * @param issue - The ScanIssue to badge.
 */
function IssueBadge({ issue }: { issue: ScanIssue }) {
  const typeConfig: Record<ScanIssue['type'], { label: string; className: string }> = {
    build_error: { label: 'Build', className: 'bg-red-500/15 text-red-400 border-red-500/30' },
    runtime_error: {
      label: 'Runtime',
      className: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
    },
    type_error: {
      label: 'TypeScript',
      className: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
    },
    config_error: {
      label: 'Config',
      className: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    },
  };
  const c = typeConfig[issue.type];
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border ${c.className}`}
    >
      {c.label}
    </span>
  );
}

/**
 * Expandable row showing a single scan record and its issues.
 *
 * @param scan - The scan record to display.
 * @param da - Whether to use Danish labels.
 */
function ScanRow({ scan, da }: { scan: ScanRecord; da: boolean }) {
  const [open, setOpen] = useState(false);
  const errorCount = scan.issues_found.filter((i) => i.severity === 'error').length;
  const warnCount = scan.issues_found.filter((i) => i.severity === 'warning').length;

  return (
    <div className="border border-slate-700/50 rounded-xl overflow-hidden">
      {/* Row header */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-800/40 transition-colors text-left"
      >
        <span className="text-slate-500">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <ScanStatusBadge status={scan.status} da={da} />
        <span className="text-white text-sm flex-1 truncate">
          {scan.summary ?? (da ? 'Ingen opsummering' : 'No summary')}
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {errorCount > 0 && (
            <span className="text-red-400 text-xs font-medium">
              {errorCount} {da ? 'fejl' : 'error(s)'}
            </span>
          )}
          {warnCount > 0 && (
            <span className="text-amber-400 text-xs font-medium">
              {warnCount} {da ? 'adv.' : 'warn'}
            </span>
          )}
          {scan.issues_found.length === 0 && scan.status === 'completed' && (
            <span className="text-emerald-400 text-xs">{da ? 'Ingen problemer' : 'Clean'}</span>
          )}
          <span className="text-slate-500 text-xs">
            {new Date(scan.created_at).toLocaleString(da ? 'da-DK' : 'en-GB', {
              day: '2-digit',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </span>
      </button>

      {/* Expanded issue list */}
      {open && scan.issues_found.length > 0 && (
        <div className="border-t border-slate-700/50 divide-y divide-slate-700/30">
          {scan.issues_found.map((issue, idx) => (
            <div key={idx} className="px-4 py-3 flex gap-3 items-start">
              <span className="mt-0.5 shrink-0">
                {issue.severity === 'error' ? (
                  <AlertCircle size={14} className="text-red-400" />
                ) : (
                  <AlertTriangle size={14} className="text-amber-400" />
                )}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <IssueBadge issue={issue} />
                  <span className="text-white text-xs truncate">{issue.message}</span>
                </div>
                {issue.context && (
                  <p className="text-slate-500 text-xs font-mono mt-0.5 truncate">
                    {issue.context}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Expanded — no issues */}
      {open && scan.issues_found.length === 0 && scan.status === 'completed' && (
        <div className="border-t border-slate-700/50 px-4 py-3 flex items-center gap-2 text-emerald-400 text-xs">
          <CheckCircle2 size={14} />
          {da ? 'Ingen problemer fundet i dette scan.' : 'No issues found in this scan.'}
        </div>
      )}

      {/* Still running */}
      {open && scan.status === 'running' && (
        <div className="border-t border-slate-700/50 px-4 py-3 flex items-center gap-2 text-blue-400 text-xs">
          <Loader2 size={14} className="animate-spin" />
          {da ? 'Scan er i gang…' : 'Scan in progress…'}
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

/**
 * Service Manager admin page — monitoring dashboard for BIZZ-86.
 * Shows Vercel deployment status and scan history; allows triggering new scans.
 */
export default function ServiceManagerPage() {
  const router = useRouter();
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [deployments, setDeployments] = useState<VercelDeployment[]>([]);
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  /** Ref used to cancel polling when component unmounts */
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** Fetch deployment + scan data from the API */
  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/service-manager');
      if (res.status === 403) {
        setIsAdmin(false);
        return;
      }
      if (!res.ok) return;
      setIsAdmin(true);
      const data = await res.json();
      setDeployments(data.deployments ?? []);
      setScans(data.scans ?? []);
      setConfigured(data.configured ?? false);
      setLastRefresh(new Date());
    } catch {
      // Network error — keep existing data
    }
  }, []);

  /** Initial load */
  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  /** Poll every 4 seconds while any scan is running */
  useEffect(() => {
    const hasRunning = scans.some((s) => s.status === 'running');
    if (hasRunning) {
      pollRef.current = setInterval(refresh, 4000);
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [scans, refresh]);

  /** Trigger a new scan */
  const startScan = async () => {
    setScanning(true);
    try {
      const res = await fetch('/api/admin/service-manager', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'scan' }),
      });
      if (res.ok) {
        // Immediately refresh so the 'running' record appears
        await refresh();
      }
    } finally {
      setScanning(false);
    }
  };

  // ── Access denied ─────────────────────────────────────────────────────────
  if (!loading && isAdmin === false) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-400">
        <div className="text-center">
          <ShieldCheck size={40} className="mx-auto mb-3 text-slate-600" />
          <p className="text-sm">{da ? 'Adgang nægtet.' : 'Access denied.'}</p>
        </div>
      </div>
    );
  }

  // ── Derived stats ──────────────────────────────────────────────────────────
  const totalScans = scans.length;
  const openIssues = scans
    .filter((s) => s.status === 'completed')
    .flatMap((s) => s.issues_found)
    .filter((i) => i.severity === 'error').length;
  const lastScan = scans[0] ?? null;
  const hasRunning = scans.some((s) => s.status === 'running');

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ─── Header ─── */}
      <div className="sticky top-0 z-20 px-3 sm:px-6 pt-5 pb-0 border-b border-slate-700/50 bg-slate-900/30 backdrop-blur-sm">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
          >
            <ArrowLeft size={16} /> {da ? 'Tilbage' : 'Back'}
          </button>
        </div>
        <div className="flex items-center gap-3 mb-1">
          <Wrench size={22} className="text-blue-400" />
          <div>
            <h1 className="text-white text-xl font-bold">
              {da ? 'Service Manager' : 'Service Manager'}
            </h1>
            <p className="text-slate-400 text-sm">
              {da
                ? 'Overvågning af deployments og automatisk fejlscanning'
                : 'Deployment monitoring and automated bug scanning'}
            </p>
          </div>
        </div>

        {/* Tab navigation — mirrors other admin pages */}
        <div className="flex gap-1 -mb-px overflow-x-auto mt-4">
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
          {/* Active tab */}
          <span className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-blue-500 text-blue-300 font-medium cursor-default whitespace-nowrap">
            <Wrench size={14} /> {da ? 'Service Manager' : 'Service Manager'}
          </span>
        </div>
      </div>

      {/* ─── Body ─── */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-6 space-y-6">
        {loading ? (
          <div className="flex items-center gap-3 text-slate-400 text-sm">
            <Loader2 size={18} className="animate-spin" /> {da ? 'Indlæser…' : 'Loading…'}
          </div>
        ) : (
          <>
            {/* ─── Vercel credentials warning ─── */}
            {!configured && (
              <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
                <AlertTriangle size={16} className="text-amber-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-amber-300 text-sm font-medium">
                    {da ? 'Vercel ikke konfigureret' : 'Vercel not configured'}
                  </p>
                  <p className="text-amber-400/70 text-xs mt-0.5">
                    {da
                      ? 'Tilføj VERCEL_TOKEN og VERCEL_PROJECT_ID i .env.local for live data.'
                      : 'Add VERCEL_TOKEN and VERCEL_PROJECT_ID to .env.local for live data.'}
                  </p>
                </div>
              </div>
            )}

            {/* ─── Stats row ─── */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl px-4 py-3">
                <p className="text-slate-400 text-xs mb-1">{da ? 'Scans i alt' : 'Total scans'}</p>
                <p className="text-white text-2xl font-bold">{totalScans}</p>
              </div>
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl px-4 py-3">
                <p className="text-slate-400 text-xs mb-1">{da ? 'Åbne fejl' : 'Open errors'}</p>
                <p
                  className={`text-2xl font-bold ${openIssues > 0 ? 'text-red-400' : 'text-emerald-400'}`}
                >
                  {openIssues}
                </p>
              </div>
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl px-4 py-3">
                <p className="text-slate-400 text-xs mb-1">{da ? 'Seneste scan' : 'Last scan'}</p>
                <p className="text-white text-sm font-medium truncate">
                  {lastScan
                    ? new Date(lastScan.created_at).toLocaleTimeString(da ? 'da-DK' : 'en-GB', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : '—'}
                </p>
              </div>
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl px-4 py-3">
                <p className="text-slate-400 text-xs mb-1">{da ? 'Deployments' : 'Deployments'}</p>
                <p className="text-white text-2xl font-bold">{deployments.length}</p>
              </div>
            </div>

            {/* ─── Action bar ─── */}
            <div className="flex items-center gap-3">
              <button
                onClick={startScan}
                disabled={scanning || hasRunning}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-xl transition-colors"
              >
                {scanning || hasRunning ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Play size={15} />
                )}
                {scanning || hasRunning
                  ? da
                    ? 'Scanner…'
                    : 'Scanning…'
                  : da
                    ? 'Kør fejlscan'
                    : 'Run Bug Scan'}
              </button>
              <button
                onClick={refresh}
                className="flex items-center gap-2 px-3 py-2 bg-slate-700/60 hover:bg-slate-700 text-slate-300 text-sm rounded-xl transition-colors border border-slate-600/50"
              >
                <RefreshCw size={14} />
                {da ? 'Opdater' : 'Refresh'}
              </button>
              {lastRefresh && (
                <span className="text-slate-500 text-xs">
                  {da ? 'Opdateret' : 'Updated'}{' '}
                  {lastRefresh.toLocaleTimeString(da ? 'da-DK' : 'en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
              )}
            </div>

            {/* ─── Recent deployments ─── */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Rocket size={16} className="text-slate-400" />
                <h2 className="text-slate-200 text-sm font-semibold">
                  {da ? 'Seneste deployments' : 'Recent Deployments'}
                </h2>
              </div>

              {deployments.length === 0 ? (
                <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl px-4 py-6 text-center text-slate-500 text-sm">
                  {configured
                    ? da
                      ? 'Ingen deployments fundet.'
                      : 'No deployments found.'
                    : da
                      ? 'Konfigurer VERCEL_TOKEN og VERCEL_PROJECT_ID for at se deployments.'
                      : 'Configure VERCEL_TOKEN and VERCEL_PROJECT_ID to see deployments.'}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-slate-500 text-xs border-b border-slate-700/50">
                        <th className="pb-2 pr-4 font-medium">{da ? 'Status' : 'Status'}</th>
                        <th className="pb-2 pr-4 font-medium">{da ? 'Besked' : 'Message'}</th>
                        <th className="pb-2 pr-4 font-medium">{da ? 'Branch' : 'Branch'}</th>
                        <th className="pb-2 pr-4 font-medium">{da ? 'Miljø' : 'Env'}</th>
                        <th className="pb-2 font-medium">{da ? 'Tidspunkt' : 'Time'}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/30">
                      {deployments.map((d) => (
                        <tr key={d.uid} className="hover:bg-slate-800/30 transition-colors">
                          <td className="py-2.5 pr-4">
                            <DeploymentStateBadge state={d.state} />
                          </td>
                          <td className="py-2.5 pr-4 text-white max-w-[260px] truncate">
                            {d.meta?.githubCommitMessage ?? d.uid}
                          </td>
                          <td className="py-2.5 pr-4 text-slate-400 font-mono text-xs">
                            {d.meta?.githubCommitRef ?? '—'}
                          </td>
                          <td className="py-2.5 pr-4">
                            {d.target === 'production' ? (
                              <span className="text-emerald-400 text-xs font-medium">
                                {da ? 'Produktion' : 'Production'}
                              </span>
                            ) : (
                              <span className="text-slate-400 text-xs">Preview</span>
                            )}
                          </td>
                          <td className="py-2.5 text-slate-400 text-xs whitespace-nowrap">
                            {new Date(d.createdAt).toLocaleString(da ? 'da-DK' : 'en-GB', {
                              day: '2-digit',
                              month: 'short',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* ─── Scan history ─── */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Bug size={16} className="text-slate-400" />
                <h2 className="text-slate-200 text-sm font-semibold">
                  {da ? 'Scanhistorik' : 'Scan History'}
                </h2>
                {hasRunning && (
                  <span className="flex items-center gap-1 text-blue-400 text-xs">
                    <Activity size={12} className="animate-pulse" />
                    {da ? 'opdaterer…' : 'updating…'}
                  </span>
                )}
              </div>

              {scans.length === 0 ? (
                <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl px-4 py-6 text-center text-slate-500 text-sm">
                  {da
                    ? 'Ingen scans endnu. Tryk "Kør fejlscan" for at starte.'
                    : 'No scans yet. Click "Run Bug Scan" to start.'}
                </div>
              ) : (
                <div className="space-y-2">
                  {scans.map((scan) => (
                    <ScanRow key={scan.id} scan={scan} da={da} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
