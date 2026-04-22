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
  ArrowLeft,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

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

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push('/dashboard/admin/users')}
            className="text-slate-400 hover:text-slate-200 transition-colors"
            aria-label={da ? 'Tilbage' : 'Back'}
          >
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Building2 size={22} className="text-blue-400" />
            {da ? 'Domain Management' : 'Domain Management'}
          </h1>
        </div>
        <Link
          href="/dashboard/admin/domains/new"
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <Plus size={16} />
          {da ? 'Opret Domain' : 'Create Domain'}
        </Link>
      </div>

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
              {domains.map((d) => (
                <tr
                  key={d.id}
                  className="border-b border-slate-700/20 hover:bg-slate-700/10 transition-colors"
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
                  <td className="px-4 py-3 text-right">
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
