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
import { Users, FileText, Briefcase, Loader2 } from 'lucide-react';
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
      {/* BIZZ-742: Header + back-arrow + settings-link nu rendered af
          DomainAdminTabs (layout.tsx) — ingen duplikeret header her. */}

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

      {/* BIZZ-742: "Quick links"-panelet er fjernet — tabberne øverst
          dækker nøjagtig samme navigation og undgår dobbelt-UI. */}
    </div>
  );
}
