/**
 * DomainsListClient — super-admin domains table.
 *
 * BIZZ-701: List/create/suspend/delete domains.
 *
 * @module app/dashboard/admin/domains/DomainsListClient
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  Plus,
  Building2,
  Users,
  FileText,
  Briefcase,
  Loader2,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Search,
  Archive,
  ArrowLeft,
  GripVertical,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { AdminNavTabs } from '../AdminNavTabs';
import { DomainDetailPanel } from './DomainDetailPanel';

/** Domain from API */
interface DomainRow {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'archived';
  plan: string;
  memberCount: number;
  templateCount: number;
  caseCount: number;
  created_at: string;
}

/**
 * Renders the super-admin domains list with create/suspend/delete actions.
 */
export default function DomainsListClient() {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // BIZZ-739: search + status filter — pattern matches /dashboard/admin/users
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'suspended' | 'archived'>(
    'all'
  );

  // BIZZ-785: Split-view state — clicking a row opens a detail panel to the
  // right of the list. Left keeps the full list UI unchanged; only its
  // effective width shrinks. URL carries `?d=<id>` so a fresh reload restores
  // the selection and the view is deep-linkable.
  const [selectedDomainId, setSelectedDomainId] = useState<string | null>(null);
  const [leftPct, setLeftPct] = useState(55);
  const containerRef = useRef<HTMLDivElement>(null);

  // Initial sync from URL on mount + persisted divider position.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const d = sp.get('d');
    if (d) setSelectedDomainId(d);
    const saved = Number(window.localStorage.getItem('bizz-domains-split-pct'));
    if (saved >= 20 && saved <= 80) setLeftPct(saved);
  }, []);

  // Keep URL in sync with selection without a router navigation so the
  // existing list state (scroll, search, filter) stays intact.
  const setSelectionWithUrl = useCallback((id: string | null) => {
    setSelectedDomainId(id);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('d', id);
    else url.searchParams.delete('d');
    window.history.replaceState(null, '', url.toString());
  }, []);

  // Divider drag handler — updates leftPct while dragging and persists it.
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const onMove = (ev: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const pct = ((ev.clientX - rect.left) / rect.width) * 100;
        const clamped = Math.max(25, Math.min(80, pct));
        setLeftPct(clamped);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.localStorage.setItem('bizz-domains-split-pct', String(Math.round(leftPct)));
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [leftPct]
  );

  // Resolve the selected domain object for the detail-panel header.
  const selectedDomain = selectedDomainId
    ? (domains.find((d) => d.id === selectedDomainId) ?? null)
    : null;

  /** Fetch domains from API */
  const fetchDomains = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/domains');
      if (res.ok) {
        setDomains(await res.json());
      } else {
        setError(da ? 'Kunne ikke hente domains' : 'Could not fetch domains');
      }
    } catch {
      setError(da ? 'Netværksfejl' : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [da]);

  useEffect(() => {
    fetchDomains();
  }, [fetchDomains]);

  /** Toggle suspend/activate */
  const toggleStatus = async (id: string, currentStatus: string) => {
    const action = currentStatus === 'active' ? 'suspend' : 'activate';
    if (
      !window.confirm(
        da
          ? `Er du sikker på at du vil ${action === 'suspend' ? 'suspendere' : 'aktivere'} dette domain?`
          : `Are you sure you want to ${action} this domain?`
      )
    )
      return;

    const res = await fetch(`/api/admin/domains/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    if (res.ok) fetchDomains();
  };

  /** Delete domain */
  const deleteDomain = async (id: string, name: string) => {
    if (
      !window.confirm(
        da
          ? `ADVARSEL: Slet "${name}" permanent? Alle data (templates, cases, genererede dokumenter) slettes uigenkaldeligt.`
          : `WARNING: Permanently delete "${name}"? All data (templates, cases, generated documents) will be irrecoverably deleted.`
      )
    )
      return;

    const res = await fetch(`/api/admin/domains/${id}`, { method: 'DELETE' });
    if (res.ok) fetchDomains();
  };

  const statusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
            <CheckCircle size={12} /> {da ? 'Aktiv' : 'Active'}
          </span>
        );
      case 'suspended':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/20 text-amber-400 border border-amber-500/30">
            <AlertTriangle size={12} /> {da ? 'Suspenderet' : 'Suspended'}
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-500/20 text-slate-400 border border-slate-500/30">
            <XCircle size={12} /> {status}
          </span>
        );
    }
  };

  // BIZZ-739: stats for KPI row
  const totalCount = domains.length;
  const activeCount = domains.filter((d) => d.status === 'active').length;
  const suspendedCount = domains.filter((d) => d.status === 'suspended').length;
  const archivedCount = domains.filter((d) => d.status === 'archived').length;

  // BIZZ-739: apply search + status filter
  const filteredDomains = domains.filter((d) => {
    if (statusFilter !== 'all' && d.status !== statusFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      if (!d.name.toLowerCase().includes(q) && !d.slug.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // BIZZ-783: Stats as clickable filter pills instead of static KPI cards.
  // Clicking a pill sets statusFilter so the table below filters to that status.
  const statPills: Array<{
    label: string;
    value: number;
    icon: typeof Building2;
    color: string;
    filter: 'all' | 'active' | 'suspended' | 'archived';
  }> = [
    {
      label: da ? 'Total' : 'Total',
      value: totalCount,
      icon: Building2,
      color: 'text-blue-400',
      filter: 'all',
    },
    {
      label: da ? 'Aktive' : 'Active',
      value: activeCount,
      icon: CheckCircle,
      color: 'text-emerald-400',
      filter: 'active',
    },
    {
      label: da ? 'Suspenderede' : 'Suspended',
      value: suspendedCount,
      icon: AlertTriangle,
      color: 'text-amber-400',
      filter: 'suspended',
    },
    {
      label: da ? 'Arkiveret' : 'Archived',
      value: archivedCount,
      icon: Archive,
      color: 'text-slate-400',
      filter: 'archived',
    },
  ];

  const listContent = (
    <div className="w-full px-4 py-8 space-y-6">
      {/* BIZZ-782: Header-struktur matcher Cron-status — back-link + page
          header (titel + subtitle + action-knap) OVER admin tab-bar. */}
      <Link
        href="/dashboard/admin/users"
        className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white text-sm transition-colors"
      >
        <ArrowLeft size={14} />
        {da ? 'Tilbage til admin' : 'Back to admin'}
      </Link>

      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-white text-xl font-bold flex items-center gap-2">
            <Building2 size={22} className="text-blue-400" />
            {da ? 'Domain Management' : 'Domain Management'}
          </h1>
          <p className="text-slate-400 text-sm mt-0.5">
            {loading
              ? da
                ? 'Henter domains…'
                : 'Loading domains…'
              : da
                ? `${totalCount} total · ${activeCount} aktive${suspendedCount > 0 ? ` · ${suspendedCount} suspenderede` : ''}${archivedCount > 0 ? ` · ${archivedCount} arkiveret` : ''}`
                : `${totalCount} total · ${activeCount} active${suspendedCount > 0 ? ` · ${suspendedCount} suspended` : ''}${archivedCount > 0 ? ` · ${archivedCount} archived` : ''}`}
          </p>
        </div>
        <Link
          href="/dashboard/admin/domains/new"
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors self-start"
        >
          <Plus size={16} />
          {da ? 'Opret Domain' : 'Create Domain'}
        </Link>
      </div>

      {/* BIZZ-782: Admin tab-bar i samme variant som cron-status (border-b) */}
      <AdminNavTabs
        activeTab="domains"
        da={da}
        className="flex gap-1 -mb-px overflow-x-auto border-b border-slate-700/50"
      />

      {/* BIZZ-783: Stat-pills — clickable filter tags replacing static KPI cards.
          Active pill gets blue outline + stronger background; clicking toggles
          statusFilter and filters the table below. */}
      {!loading && !error && (
        <div className="flex flex-wrap gap-2">
          {statPills.map((p) => {
            const isActive = statusFilter === p.filter;
            return (
              <button
                key={p.filter}
                type="button"
                onClick={() => setStatusFilter(p.filter)}
                aria-pressed={isActive}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
                  isActive
                    ? 'bg-blue-500/20 border-blue-400/60 text-white'
                    : 'bg-slate-900/50 border-slate-700/40 text-slate-300 hover:bg-slate-800/60 hover:border-slate-600'
                }`}
              >
                <p.icon size={13} className={p.color} />
                <span>{p.label}</span>
                <span
                  className={`ml-1 px-1.5 py-0.5 rounded-md text-[11px] font-semibold ${
                    isActive ? 'bg-blue-500/30 text-white' : 'bg-slate-800/80 text-slate-200'
                  }`}
                >
                  {p.value}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* BIZZ-739: Search (status-filter moved into clickable pills above — BIZZ-783) */}
      {!loading && !error && totalCount > 0 && (
        <div className="flex gap-3 items-center">
          <div className="relative flex-1 max-w-xs">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={da ? 'Søg navn eller slug…' : 'Search name or slug…'}
              className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg pl-9 pr-3 py-2 text-white text-xs placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
        </div>
      ) : error ? (
        <div className="text-center py-20 text-red-400">{error}</div>
      ) : domains.length === 0 ? (
        <div className="text-center py-20">
          <Building2 size={40} className="text-slate-600 mx-auto mb-3" />
          <p className="text-slate-400 text-sm">
            {da ? 'Ingen domains oprettet endnu.' : 'No domains created yet.'}
          </p>
        </div>
      ) : filteredDomains.length === 0 ? (
        <div className="text-center py-20">
          <Search size={32} className="text-slate-600 mx-auto mb-3" />
          <p className="text-slate-400 text-sm">
            {da ? 'Ingen domains matcher filteret.' : 'No domains match the filter.'}
          </p>
        </div>
      ) : (
        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700/40">
                <th className="text-left px-4 py-3 text-slate-400 font-medium">
                  {da ? 'Navn' : 'Name'}
                </th>
                <th className="text-left px-4 py-3 text-slate-400 font-medium">Status</th>
                <th className="text-center px-4 py-3 text-slate-400 font-medium">
                  <Users size={14} className="inline" />
                </th>
                <th className="text-center px-4 py-3 text-slate-400 font-medium">
                  <FileText size={14} className="inline" />
                </th>
                <th className="text-center px-4 py-3 text-slate-400 font-medium">
                  <Briefcase size={14} className="inline" />
                </th>
                <th className="text-right px-4 py-3 text-slate-400 font-medium">
                  {da ? 'Oprettet' : 'Created'}
                </th>
                <th className="text-right px-4 py-3 text-slate-400 font-medium">
                  {da ? 'Handlinger' : 'Actions'}
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredDomains.map((d) => (
                <tr
                  key={d.id}
                  onClick={(e) => {
                    // BIZZ-746: row click → open detail. BIZZ-785: open in split
                    // panel on the right instead of a full-page navigation so
                    // the list stays visible. Skip when the click target is an
                    // action button/link.
                    const target = e.target as HTMLElement;
                    if (target.closest('button') || target.closest('a')) return;
                    setSelectionWithUrl(d.id);
                  }}
                  className={`border-b border-slate-700/20 transition-colors cursor-pointer ${
                    d.id === selectedDomainId
                      ? 'bg-blue-500/10 hover:bg-blue-500/15'
                      : 'hover:bg-slate-700/10'
                  }`}
                >
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        setSelectionWithUrl(d.id);
                      }}
                      className="text-white font-medium hover:text-blue-300 transition-colors text-left"
                    >
                      {d.name}
                    </button>
                    <p className="text-slate-500 text-xs">{d.slug}</p>
                  </td>
                  <td className="px-4 py-3">{statusBadge(d.status)}</td>
                  <td className="px-4 py-3 text-center text-slate-300">{d.memberCount}</td>
                  <td className="px-4 py-3 text-center text-slate-300">{d.templateCount}</td>
                  <td className="px-4 py-3 text-center text-slate-300">{d.caseCount}</td>
                  <td className="px-4 py-3 text-right text-slate-400 text-xs">
                    {new Date(d.created_at).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => toggleStatus(d.id, d.status)}
                        className="text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
                      >
                        {d.status === 'active'
                          ? da
                            ? 'Suspendér'
                            : 'Suspend'
                          : da
                            ? 'Aktivér'
                            : 'Activate'}
                      </button>
                      <button
                        onClick={() => deleteDomain(d.id, d.name)}
                        className="text-xs px-2 py-1 rounded bg-red-900/30 hover:bg-red-900/50 text-red-400 transition-colors"
                      >
                        {da ? 'Slet' : 'Delete'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  // BIZZ-785: When no selection, render the list at full width (unchanged
  // behaviour). When a selection exists, split the viewport into a left
  // column (list — pressed together but otherwise identical) and a right
  // column (detail panel). A draggable divider between the two lets the
  // super-admin choose their preferred split.
  if (!selectedDomainId) {
    return listContent;
  }

  return (
    <div ref={containerRef} className="flex w-full" style={{ minHeight: 'calc(100vh - 140px)' }}>
      {/* LEFT: existing list content, just narrower */}
      <div className="min-w-0 overflow-hidden" style={{ width: `${leftPct}%` }}>
        {listContent}
      </div>

      {/* DIVIDER: mouse-drag to resize. Full-height with subtle hover + grip. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(leftPct)}
        aria-valuemin={25}
        aria-valuemax={80}
        onMouseDown={startResize}
        className="group relative w-1.5 shrink-0 cursor-col-resize bg-slate-800/40 hover:bg-blue-500/40 transition-colors"
        title={da ? 'Træk for at justere opdelingen' : 'Drag to resize split'}
      >
        <GripVertical
          size={14}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-600 group-hover:text-blue-300"
        />
      </div>

      {/* RIGHT: detail panel */}
      <div className="min-w-0 overflow-hidden px-4 py-8" style={{ width: `${100 - leftPct}%` }}>
        <DomainDetailPanel
          domainId={selectedDomainId}
          domainName={selectedDomain?.name}
          onClose={() => setSelectionWithUrl(null)}
        />
      </div>
    </div>
  );
}
