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
import { Briefcase, Plus, Search, Loader2, Shield } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

interface DomainCase {
  id: string;
  name: string;
  client_ref: string | null;
  status: 'open' | 'closed' | 'archived';
  tags: string[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

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

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Briefcase size={22} className="text-blue-400" />
            {da ? 'Sager' : 'Cases'}
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            {statusCount} {da ? 'sager vist' : 'cases shown'}
          </p>
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

      {/* Search + status filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
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

      {/* Cases grid */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
        </div>
      ) : cases.length === 0 ? (
        <div className="text-center py-16 bg-slate-800/40 border border-slate-700/40 rounded-xl">
          <Briefcase size={32} className="mx-auto text-slate-600 mb-3" />
          <p className="text-slate-400 text-sm">{da ? 'Ingen sager fundet' : 'No cases found'}</p>
          <Link
            href={`/domain/${domainId}/new-case`}
            className="mt-4 inline-flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded-md text-white text-sm font-medium"
          >
            <Plus size={14} />
            {da ? 'Opret første sag' : 'Create first case'}
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {cases.map((c) => (
            <Link
              key={c.id}
              href={`/domain/${domainId}/case/${c.id}`}
              className="block bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 hover:bg-slate-800/60 transition-colors"
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <h3 className="text-white font-medium text-sm truncate flex-1">{c.name}</h3>
                <span
                  className={`px-2 py-0.5 text-[10px] font-semibold rounded-full shrink-0 ${
                    c.status === 'open'
                      ? 'bg-emerald-900/40 text-emerald-300'
                      : c.status === 'closed'
                        ? 'bg-slate-700/40 text-slate-300'
                        : 'bg-amber-900/40 text-amber-300'
                  }`}
                >
                  {c.status}
                </span>
              </div>
              {c.client_ref && <p className="text-slate-400 text-xs mb-2">{c.client_ref}</p>}
              {c.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {c.tags.slice(0, 3).map((t) => (
                    <span
                      key={t}
                      className="px-1.5 py-0.5 bg-slate-700/40 text-slate-300 text-[10px] rounded"
                    >
                      {t}
                    </span>
                  ))}
                  {c.tags.length > 3 && (
                    <span className="text-slate-500 text-[10px]">+{c.tags.length - 3}</span>
                  )}
                </div>
              )}
              <p className="text-slate-500 text-xs">
                {da ? 'Opdateret' : 'Updated'}{' '}
                {new Date(c.updated_at).toLocaleDateString(da ? 'da-DK' : 'en-GB')}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
