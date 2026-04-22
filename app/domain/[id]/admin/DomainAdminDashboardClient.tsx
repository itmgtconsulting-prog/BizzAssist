/**
 * DomainAdminDashboardClient — Domain admin dashboard with stats cards.
 *
 * BIZZ-704: User count, template count, case count, recent audit activity.
 *
 * @module app/domain/[id]/admin/DomainAdminDashboardClient
 */

'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Users, FileText, Briefcase, Settings, Loader2, Shield } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

interface DomainStats {
  name: string;
  slug: string;
  status: string;
  memberCount: number;
  templateCount: number;
  caseCount: number;
}

/**
 * Dashboard showing domain stats and admin navigation.
 *
 * @param domainId - Domain UUID
 */
export default function DomainAdminDashboardClient({ domainId }: { domainId: string }) {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const [stats, setStats] = useState<DomainStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/admin/domains/${domainId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setStats(d);
      })
      .finally(() => setLoading(false));
  }, [domainId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
      </div>
    );
  }

  if (!stats) {
    return <div className="text-center py-20 text-slate-400">Domain not found</div>;
  }

  const cards = [
    {
      label: da ? 'Brugere' : 'Users',
      value: stats.memberCount,
      icon: Users,
      color: 'text-blue-400',
      href: `/domain/${domainId}/admin/users`,
    },
    {
      label: da ? 'Skabeloner' : 'Templates',
      value: stats.templateCount,
      icon: FileText,
      color: 'text-emerald-400',
      href: `/domain/${domainId}/admin/templates`,
    },
    {
      label: da ? 'Sager' : 'Cases',
      value: stats.caseCount,
      icon: Briefcase,
      color: 'text-amber-400',
      href: `/domain/${domainId}/admin/cases`,
    },
  ];

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Shield size={22} className="text-purple-400" />
            {stats.name}
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            {da ? 'Domain Administration' : 'Domain Administration'}
          </p>
        </div>
        <Link
          href={`/domain/${domainId}/admin/settings`}
          className="flex items-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700/40 rounded-lg text-slate-300 text-sm transition-colors"
        >
          <Settings size={14} />
          {da ? 'Indstillinger' : 'Settings'}
        </Link>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {cards.map((card) => (
          <Link
            key={card.label}
            href={card.href}
            className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5 hover:bg-slate-800/60 transition-colors group"
          >
            <div className="flex items-center gap-3 mb-3">
              <card.icon size={20} className={card.color} />
              <span className="text-slate-400 text-sm">{card.label}</span>
            </div>
            <p className="text-3xl font-bold text-white">{card.value}</p>
          </Link>
        ))}
      </div>

      {/* Quick links */}
      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5">
        <h2 className="text-white font-semibold text-sm mb-3">
          {da ? 'Administration' : 'Administration'}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Link
            href={`/domain/${domainId}/admin/users`}
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-slate-700/30 text-slate-300 text-sm transition-colors"
          >
            <Users size={16} className="text-blue-400" />
            {da ? 'Administrer brugere' : 'Manage users'}
          </Link>
          <Link
            href={`/domain/${domainId}/admin/templates`}
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-slate-700/30 text-slate-300 text-sm transition-colors"
          >
            <FileText size={16} className="text-emerald-400" />
            {da ? 'Administrer skabeloner' : 'Manage templates'}
          </Link>
          <Link
            href={`/domain/${domainId}/admin/training`}
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-slate-700/30 text-slate-300 text-sm transition-colors"
          >
            <FileText size={16} className="text-cyan-400" />
            {da ? 'Træningsdokumenter' : 'Training documents'}
          </Link>
          <Link
            href={`/domain/${domainId}/admin/settings`}
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-slate-700/30 text-slate-300 text-sm transition-colors"
          >
            <Settings size={16} className="text-slate-400" />
            {da ? 'Indstillinger' : 'Settings'}
          </Link>
        </div>
      </div>
    </div>
  );
}
