/**
 * DomainsListClient — super-admin domains table.
 *
 * BIZZ-701: List/create/suspend/delete domains.
 *
 * @module app/dashboard/admin/domains/DomainsListClient
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
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
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { AdminNavTabs } from '../AdminNavTabs';

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
  const router = useRouter();
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // BIZZ-739: search + status filter — pattern matches /dashboard/admin/users
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'suspended' | 'archived'>(
    'all'
  );

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

  const statCards = [
    {
      label: da ? 'Total' : 'Total',
      value: totalCount,
      icon: Building2,
      color: 'text-blue-400',
    },
    {
      label: da ? 'Aktive' : 'Active',
      value: activeCount,
      icon: CheckCircle,
      color: 'text-emerald-400',
    },
    {
      label: da ? 'Suspenderede' : 'Suspended',
      value: suspendedCount,
      icon: AlertTriangle,
      color: 'text-amber-400',
    },
    {
      label: da ? 'Arkiveret' : 'Archived',
      value: archivedCount,
      icon: Archive,
      color: 'text-slate-400',
    },
  ];

  return (
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

      {/* BIZZ-739: Stats card row — matches /dashboard/admin/users + /billing */}
      {!loading && !error && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {statCards.map((c) => (
            <div
              key={c.label}
              className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-4"
            >
              <div className="flex items-center gap-2 mb-2 text-slate-400 text-xs uppercase tracking-wide">
                <c.icon size={14} className={c.color} />
                {c.label}
              </div>
              <p className="text-2xl font-bold text-white">{c.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* BIZZ-739: Search + status filter */}
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
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as 'all' | 'active' | 'suspended' | 'archived')
            }
            className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-3 py-2 text-white text-xs focus:border-blue-500 focus:outline-none"
          >
            <option value="all">{da ? 'Alle statusser' : 'All statuses'}</option>
            <option value="active">{da ? 'Aktive' : 'Active'}</option>
            <option value="suspended">{da ? 'Suspenderede' : 'Suspended'}</option>
            <option value="archived">{da ? 'Arkiveret' : 'Archived'}</option>
          </select>
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
                    // BIZZ-746: row click → drill-down. Skip when user clicked
                    // one of the action buttons (they have their own onClick +
                    // stopPropagation on the wrapper div).
                    const target = e.target as HTMLElement;
                    if (target.closest('button') || target.closest('a')) return;
                    router.push(`/dashboard/admin/domains/${d.id}`);
                  }}
                  className="border-b border-slate-700/20 hover:bg-slate-700/10 transition-colors cursor-pointer"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/admin/domains/${d.id}`}
                      className="text-white font-medium hover:text-blue-300 transition-colors"
                    >
                      {d.name}
                    </Link>
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
}
