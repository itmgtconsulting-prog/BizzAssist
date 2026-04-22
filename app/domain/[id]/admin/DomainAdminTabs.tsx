/**
 * DomainAdminTabs — shared tab-bar + header for /domain/[id]/admin/* routes.
 *
 * BIZZ-742: Previously each admin subpage (users, templates, training,
 * settings) was a standalone page with its own back-nav and header. Users
 * had no consistent way to move between them — clicking the dashboard's
 * "Manage users" button dropped you on /users with no breadcrumb back.
 *
 * This component wraps every admin route in a shared tab-bar matching the
 * pattern used by /dashboard/admin/*. The domain header + back-arrow keeps
 * the user anchored; tab changes feel like in-place content swaps thanks
 * to the layout staying mounted across route transitions.
 *
 * BIZZ-744: The back-arrow fixes the "no way back" complaint.
 * BIZZ-740: The settings tab gives the settings button a real target.
 *
 * @module app/domain/[id]/admin/DomainAdminTabs
 */
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowLeft,
  LayoutDashboard,
  Users,
  FileText,
  FolderOpen,
  Settings,
  Shield,
  History,
  type LucideIcon,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

interface TabDef {
  id: string;
  /** URL suffix appended to `/domain/[id]/admin` — empty string for dashboard. */
  suffix: string;
  icon: LucideIcon;
  labelDa: string;
  labelEn: string;
}

const TABS: TabDef[] = [
  { id: 'overview', suffix: '', icon: LayoutDashboard, labelDa: 'Oversigt', labelEn: 'Overview' },
  { id: 'users', suffix: '/users', icon: Users, labelDa: 'Brugere', labelEn: 'Users' },
  {
    id: 'templates',
    suffix: '/templates',
    icon: FileText,
    labelDa: 'Skabeloner',
    labelEn: 'Templates',
  },
  {
    id: 'training',
    suffix: '/training',
    icon: FolderOpen,
    labelDa: 'Dokumenter',
    labelEn: 'Documents',
  },
  { id: 'audit', suffix: '/audit', icon: History, labelDa: 'Historik', labelEn: 'Audit log' },
  {
    id: 'settings',
    suffix: '/settings',
    icon: Settings,
    labelDa: 'Indstillinger',
    labelEn: 'Settings',
  },
];

interface DomainAdminTabsProps {
  /** Domain UUID — used to build tab hrefs. */
  domainId: string;
  /** Domain display name — shown in the header next to the shield icon. */
  domainName?: string;
}

/**
 * Compute which tab is active from the pathname. Uses longest-suffix match
 * so /admin/templates/[templateId] still highlights the "Templates" tab.
 */
function activeTabIdFor(pathname: string, domainId: string): string {
  const base = `/domain/${domainId}/admin`;
  if (pathname === base) return 'overview';
  const remainder = pathname.slice(base.length);
  // Pick the tab whose suffix (non-empty) is the longest prefix of remainder.
  let best = 'overview';
  let bestLen = 0;
  for (const t of TABS) {
    if (!t.suffix) continue;
    if (remainder.startsWith(t.suffix) && t.suffix.length > bestLen) {
      best = t.id;
      bestLen = t.suffix.length;
    }
  }
  return best;
}

/** Renders the domain-admin tab-bar with back-arrow and optional header. */
export function DomainAdminTabs({ domainId, domainName }: DomainAdminTabsProps) {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const pathname = usePathname();
  const activeId = activeTabIdFor(pathname, domainId);

  return (
    <div className="border-b border-slate-700/40 bg-slate-900/40">
      <div className="max-w-6xl mx-auto px-4 pt-6">
        {/* Header row: back + domain name */}
        <div className="flex items-center gap-3 mb-4">
          <Link
            href={`/domain/${domainId}`}
            className="text-slate-400 hover:text-slate-200 transition-colors"
            aria-label={da ? 'Tilbage til domain' : 'Back to domain'}
          >
            <ArrowLeft size={20} />
          </Link>
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <Shield size={20} className="text-purple-400" />
            {domainName ?? (da ? 'Domain Administration' : 'Domain Administration')}
          </h1>
          <span className="text-slate-500 text-xs ml-2">
            {da ? 'Administration' : 'Administration'}
          </span>
        </div>

        {/* Tab row */}
        <div className="flex gap-1 -mb-px overflow-x-auto" role="tablist">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const label = da ? tab.labelDa : tab.labelEn;
            const isActive = tab.id === activeId;
            const href = `/domain/${domainId}/admin${tab.suffix}`;
            if (isActive) {
              return (
                <span
                  key={tab.id}
                  role="tab"
                  aria-selected="true"
                  className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-blue-500 text-blue-300 font-medium cursor-default whitespace-nowrap"
                >
                  <Icon size={14} /> {label}
                </span>
              );
            }
            return (
              <Link
                key={tab.id}
                role="tab"
                href={href}
                className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap"
              >
                <Icon size={14} /> {label}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
