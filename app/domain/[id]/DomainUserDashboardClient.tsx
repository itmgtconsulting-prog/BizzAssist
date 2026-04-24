/**
 * DomainUserDashboardClient — Cases list + new-case CTA + status filter + search.
 *
 * BIZZ-712: Member-scoped landing page for a domain. Matches the visual
 * vocabulary of other dashboard lists (dark slate, rounded cards).
 *
 * @module app/domain/[id]/DomainUserDashboardClient
 */

'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import {
  Briefcase,
  Plus,
  Search,
  Loader2,
  Shield,
  Archive,
  Trash2,
  X,
  LayoutDashboard,
  ArrowLeft,
  type LucideIcon,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { DomainCaseList, type DomainCaseSummary } from './DomainCaseList';
import { DomainWorkspaceSplitView } from './DomainWorkspaceSplitView';

// BIZZ-760: case row shape now lives in DomainCaseList — re-exported here
// so the fetcher typing stays local.
type DomainCase = DomainCaseSummary;

const STATUS_FILTERS: Array<{
  key: 'open' | 'closed' | 'archived' | 'all';
  labelDa: string;
  labelEn: string;
}> = [
  { key: 'open', labelDa: 'Åbne', labelEn: 'Open' },
  { key: 'closed', labelDa: 'Lukkede', labelEn: 'Closed' },
  { key: 'archived', labelDa: 'Arkiveret', labelEn: 'Archived' },
  { key: 'all', labelDa: 'Alle', labelEn: 'All' },
];

/**
 * Domain user dashboard — cases list with search + status filter + new-case CTA.
 *
 * @param domainId - Domain UUID
 */
export default function DomainUserDashboardClient({ domainId }: { domainId: string }) {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const [cases, setCases] = useState<DomainCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<'open' | 'closed' | 'archived' | 'all'>('open');
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<'admin' | 'member' | null>(null);
  // BIZZ-759: bulk-selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // BIZZ-800: Workspace-mode — klik på en sag åbner 4-kvadrant split-view
  // med AI-agent + skabelon-vælger + sag-detail. URL-param ?sag=<id>.
  const [workspaceCaseId, setWorkspaceCaseId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const s = sp.get('sag');
    if (s) setWorkspaceCaseId(s);
  }, []);

  const setWorkspaceWithUrl = useCallback((id: string | null) => {
    setWorkspaceCaseId(id);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('sag', id);
    else url.searchParams.delete('sag');
    window.history.replaceState(null, '', url.toString());
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ status });
      if (search.trim()) params.set('search', search.trim());
      const r = await fetch(`/api/domain/${domainId}/cases?${params}`);
      if (r.ok) {
        setCases((await r.json()) as DomainCase[]);
      }
    } finally {
      setLoading(false);
    }
  }, [domainId, status, search]);

  useEffect(() => {
    void load();
  }, [load]);

  // Fetch the user's role in this domain (for conditional Admin-button)
  useEffect(() => {
    fetch('/api/domain/mine')
      .then((r) => (r.ok ? r.json() : []))
      .then((d: Array<{ id: string; role: 'admin' | 'member' }>) => {
        const hit = Array.isArray(d) ? d.find((x) => x.id === domainId) : null;
        if (hit) setRole(hit.role);
      })
      .catch(() => {});
  }, [domainId]);

  // Debounce search input — fire load() 300ms after typing stops
  useEffect(() => {
    const h = setTimeout(() => void load(), 300);
    return () => clearTimeout(h);
  }, [search, load]);

  const statusCount = useMemo(() => cases.length, [cases]);

  // BIZZ-773: top-level tabs — matches person/company/ejendom detail pages.
  // Only "Sager" is a fully in-page view right now; other tabs link to the
  // existing admin sub-routes (requires admin role, handled by those
  // layouts). Split-view + AI side-panel are iter 2.
  // BIZZ-787: "Dokumenter" fjernet som top-level tab — dokumenter hører
  // hjemme i kontekst af en skabelon (resizable side-panel i template-editor).
  const [topTab, setTopTab] = useState<'overview' | 'cases'>('cases');
  // BIZZ-885: Skabeloner, Historik og Indstillinger fjernet fra hoved-
  // menuen. Admin-funktioner tilgås via dedikeret Admin-knap i header
  // (kun synlig for admins). Medlemmer ser kun Oversigt + Sager.
  const topTabs: Array<{
    id: typeof topTab;
    icon: LucideIcon;
    labelDa: string;
    labelEn: string;
    adminHref?: string;
  }> = [
    { id: 'overview', icon: LayoutDashboard, labelDa: 'Oversigt', labelEn: 'Overview' },
    { id: 'cases', icon: Briefcase, labelDa: 'Sager', labelEn: 'Cases' },
  ];

  // BIZZ-759: bulk actions — iterate the selected IDs and fire per-case PATCH
  // or DELETE calls. The existing /api/domain/[id]/cases/[caseId] endpoints
  // already validate membership + admin role per request, so no new API is
  // needed. After completion we reload the list and clear selection.
  const bulkArchive = useCallback(async () => {
    if (selectedIds.size === 0) return;
    if (
      !window.confirm(
        da
          ? `Arkivér ${selectedIds.size} sag${selectedIds.size === 1 ? '' : 'er'}?`
          : `Archive ${selectedIds.size} case${selectedIds.size === 1 ? '' : 's'}?`
      )
    )
      return;
    setBulkBusy(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          fetch(`/api/domain/${domainId}/cases/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'archived' }),
          })
        )
      );
      clearSelection();
      await load();
    } finally {
      setBulkBusy(false);
    }
  }, [domainId, selectedIds, clearSelection, load, da]);

  const bulkDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    if (
      !window.confirm(
        da
          ? `SLET ${selectedIds.size} sag${selectedIds.size === 1 ? '' : 'er'} permanent? Alle dokumenter + generationer går tabt.`
          : `DELETE ${selectedIds.size} case${selectedIds.size === 1 ? '' : 's'} permanently? All documents + generations will be lost.`
      )
    )
      return;
    setBulkBusy(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          fetch(`/api/domain/${domainId}/cases/${id}`, { method: 'DELETE' })
        )
      );
      clearSelection();
      await load();
    } finally {
      setBulkBusy(false);
    }
  }, [domainId, selectedIds, clearSelection, load, da]);

  return (
    <div className="w-full px-4 py-6 space-y-5">
      {/* BIZZ-798: Layout matcher person-detalje — full-width, "Tilbage til
          dashboard"-link øverst, header + tabs spanning full content width.
          BIZZ-805: efter pivot til global AI Chat er højre-side panelet
          fjernet, så ingen paddingRight-reservation er nødvendig længere. */}
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white text-xs font-medium transition-colors"
      >
        <ArrowLeft size={12} />
        {da ? 'Tilbage til dashboard' : 'Back to dashboard'}
      </Link>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Shield size={22} className="text-purple-400" />
            {da ? 'Domain' : 'Domain'}
          </h1>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/15 text-blue-300 border border-blue-500/30">
              <Briefcase size={11} />
              {statusCount} {da ? 'sager' : 'cases'}
            </span>
            {role === 'admin' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-500/15 text-purple-300 border border-purple-500/30">
                <Shield size={11} />
                {da ? 'Admin' : 'Admin'}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {role === 'admin' && (
            <Link
              href={`/domain/${domainId}/admin`}
              className="flex items-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700/40 rounded-md text-slate-300 text-sm font-medium transition-colors"
            >
              <Shield size={14} className="text-purple-400" />
              {da ? 'Admin' : 'Admin'}
            </Link>
          )}
          <Link
            href={`/domain/${domainId}/new-case`}
            className="flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded-md text-white text-sm font-medium transition-colors"
          >
            <Plus size={14} />
            {da ? 'Opret sag' : 'New case'}
          </Link>
        </div>
      </div>

      {/* BIZZ-773: Top-level tabs — aligns domain with person/company/ejendom
          detail pattern. Admin-only tabs link out to existing admin routes.
          Iter 2 will bring inline rendering + split-view + AI side-panel. */}
      <div
        className="flex gap-1 -mb-px overflow-x-auto border-b border-slate-700/40"
        role="tablist"
      >
        {topTabs.map((tab) => {
          const Icon = tab.icon;
          const label = da ? tab.labelDa : tab.labelEn;
          const isActive = tab.id === topTab;
          const className = `flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 transition-colors whitespace-nowrap ${
            isActive
              ? 'border-blue-500 text-blue-300 font-medium'
              : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600'
          }`;
          // Admin-scoped tabs navigate out when user is admin; member sees
          // them disabled so they aren't surprised by a 403.
          if (tab.adminHref) {
            if (role === 'admin') {
              return (
                <Link key={tab.id} role="tab" href={tab.adminHref} className={className}>
                  <Icon size={14} /> {label}
                </Link>
              );
            }
            return (
              <span
                key={tab.id}
                role="tab"
                aria-disabled="true"
                title={da ? 'Kun admin' : 'Admin only'}
                className={`${className} opacity-40 cursor-not-allowed`}
              >
                <Icon size={14} /> {label}
              </span>
            );
          }
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => setTopTab(tab.id)}
              className={className}
            >
              <Icon size={14} /> {label}
            </button>
          );
        })}
      </div>

      {topTab === 'overview' && (
        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-8 text-center">
          <LayoutDashboard size={32} className="mx-auto text-slate-600 mb-3" />
          <p className="text-slate-400 text-sm">
            {da
              ? 'Overblik — domain-stats og seneste aktivitet kommer i iter 2.'
              : 'Overview — domain stats and recent activity coming in iter 2.'}
          </p>
        </div>
      )}

      {topTab === 'cases' && (
        <>
          {/* BIZZ-781: header + actions flyttet til sidens top (over tabs) — undgår duplikation */}

          {/* Search + status filter */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
              />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={da ? 'Søg i sager…' : 'Search cases…'}
                className="w-full pl-9 pr-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-sm"
              />
            </div>
            <div
              role="tablist"
              aria-label={da ? 'Status-filter' : 'Status filter'}
              className="flex gap-1 bg-slate-800/40 border border-slate-700/40 rounded-md p-1"
            >
              {STATUS_FILTERS.map((f) => {
                const active = f.key === status;
                return (
                  <button
                    key={f.key}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setStatus(f.key)}
                    className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                      active
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-400 hover:text-white hover:bg-slate-700/40'
                    }`}
                  >
                    {da ? f.labelDa : f.labelEn}
                  </button>
                );
              })}
            </div>
          </div>

          {/* BIZZ-759: bulk-action toolbar — visible only when >=1 selected.
          Admin-only for delete; any member may bulk-archive. */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2 bg-blue-500/10 border border-blue-500/30 rounded-lg px-4 py-2">
              <span className="text-blue-300 text-sm font-medium">
                {selectedIds.size} {da ? 'valgt' : 'selected'}
              </span>
              <div className="flex-1" />
              <button
                onClick={bulkArchive}
                disabled={bulkBusy}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600/30 hover:bg-amber-600/50 disabled:opacity-50 text-amber-200 text-xs font-medium rounded-md transition-colors border border-amber-500/40"
              >
                <Archive size={12} />
                {da ? 'Arkivér' : 'Archive'}
              </button>
              {role === 'admin' && (
                <button
                  onClick={bulkDelete}
                  disabled={bulkBusy}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/30 hover:bg-red-600/50 disabled:opacity-50 text-red-200 text-xs font-medium rounded-md transition-colors border border-red-500/40"
                >
                  <Trash2 size={12} />
                  {da ? 'Slet' : 'Delete'}
                </button>
              )}
              <button
                onClick={clearSelection}
                disabled={bulkBusy}
                aria-label={da ? 'Ryd valg' : 'Clear selection'}
                className="text-slate-400 hover:text-white transition-colors"
              >
                <X size={14} />
              </button>
            </div>
          )}

          {/* BIZZ-760 + BIZZ-800: Cases grid ELLER workspace split-view */}
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
            </div>
          ) : workspaceCaseId ? (
            <DomainWorkspaceSplitView
              domainId={domainId}
              selectedCaseId={workspaceCaseId}
              cases={cases}
              onSelectCase={(id) => setWorkspaceWithUrl(id)}
              onCloseWorkspace={() => setWorkspaceWithUrl(null)}
              onCaseUpdated={load}
            />
          ) : (
            <DomainCaseList
              domainId={domainId}
              cases={cases}
              showCreateEmptyAction
              selectable
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onOpenCase={(id) => setWorkspaceWithUrl(id)}
            />
          )}
        </>
      )}
    </div>
  );
}
