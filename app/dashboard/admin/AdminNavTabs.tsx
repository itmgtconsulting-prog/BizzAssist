/**
 * Shared admin navigation tab-bar.
 *
 * BIZZ-737: Previously duplicated across 9+ admin client components. Each
 * page hard-coded the same tab-bar markup, which meant adding a new tab
 * (like the Domains link) required editing every file. The review on
 * BIZZ-701 flagged the duplication; BIZZ-737 extracts it here.
 *
 * The active tab is identified by `activeTab` (keyed by route slug). The
 * Domains tab is feature-flag-gated via `isDomainFeatureEnabled()`.
 *
 * @module app/dashboard/admin/AdminNavTabs
 */
'use client';

import Link from 'next/link';
import {
  Users,
  CreditCard,
  Settings,
  BarChart3,
  Bot,
  ShieldCheck,
  Wrench,
  Activity,
  Clock,
  Shield,
  type LucideIcon,
} from 'lucide-react';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';

/** Identifier used to mark which tab is currently active. */
export type AdminTabId =
  | 'users'
  | 'billing'
  | 'plans'
  | 'analytics'
  | 'ai-media-agents'
  | 'security'
  | 'service-manager'
  | 'service-management'
  | 'cron-status'
  | 'domains'
  // BIZZ-749: pages below don't appear in the tab-bar but render it so
  // users have a way back to the main admin surface. Neither value matches
  // a TAB id, so no tab is highlighted — the surface is "in between".
  | 'ai-feedback'
  | 'release-manager';

interface TabDef {
  id: AdminTabId;
  href: string;
  icon: LucideIcon;
  labelDa: string;
  labelEn: string;
  /** Present only when the tab should be feature-flag-gated. */
  flag?: 'domain';
}

const TABS: TabDef[] = [
  {
    id: 'users',
    href: '/dashboard/admin/users',
    icon: Users,
    labelDa: 'Brugere',
    labelEn: 'Users',
  },
  {
    id: 'billing',
    href: '/dashboard/admin/billing',
    icon: CreditCard,
    labelDa: 'Fakturering',
    labelEn: 'Billing',
  },
  {
    id: 'plans',
    href: '/dashboard/admin/plans',
    icon: Settings,
    labelDa: 'Planer',
    labelEn: 'Plans',
  },
  {
    id: 'analytics',
    href: '/dashboard/admin/analytics',
    icon: BarChart3,
    labelDa: 'Analyse',
    labelEn: 'Analytics',
  },
  {
    id: 'ai-media-agents',
    href: '/dashboard/admin/ai-media-agents',
    icon: Bot,
    labelDa: 'AI-agenter',
    labelEn: 'AI Agents',
  },
  {
    id: 'security',
    href: '/dashboard/admin/security',
    icon: ShieldCheck,
    labelDa: 'Sikkerhed',
    labelEn: 'Security',
  },
  {
    id: 'service-manager',
    href: '/dashboard/admin/service-manager',
    icon: Wrench,
    labelDa: 'Service Manager',
    labelEn: 'Service Manager',
  },
  {
    id: 'service-management',
    href: '/dashboard/admin/service-management',
    icon: Activity,
    labelDa: 'Infrastruktur',
    labelEn: 'Infrastructure',
  },
  {
    id: 'cron-status',
    href: '/dashboard/admin/cron-status',
    icon: Clock,
    labelDa: 'Cron-status',
    labelEn: 'Cron Status',
  },
  {
    id: 'domains',
    href: '/dashboard/admin/domains',
    icon: Shield,
    labelDa: 'Domains',
    labelEn: 'Domains',
    flag: 'domain',
  },
];

/** Props for AdminNavTabs. */
export interface AdminNavTabsProps {
  /** The currently active tab — drives the blue underline. */
  activeTab: AdminTabId;
  /** Language toggle — true when the UI is in Danish. */
  da: boolean;
  /** Optional wrapper class override. Some admin pages put the tab-bar
   *  directly under a header (mt-4 default) while others use a separate
   *  card that already provides the bottom border (`mb-6 border-b ...`). */
  className?: string;
  /** Optional list item role — some pages use `role="tablist"` for a11y. */
  role?: 'tablist';
}

/**
 * Renders the horizontal tab-bar used on every /dashboard/admin/* page.
 * The Domains tab is only rendered when `isDomainFeatureEnabled()` returns
 * true — i.e. it stays hidden in production until the feature launches.
 */
export function AdminNavTabs({
  activeTab,
  da,
  className = 'flex gap-1 -mb-px overflow-x-auto mt-4',
  role,
}: AdminNavTabsProps) {
  const domainEnabled = isDomainFeatureEnabled();
  return (
    <div className={className} {...(role ? { role } : {})}>
      {TABS.filter((t) => !t.flag || (t.flag === 'domain' && domainEnabled)).map((tab) => {
        const Icon = tab.icon;
        const label = da ? tab.labelDa : tab.labelEn;
        const isActive = tab.id === activeTab;
        if (isActive) {
          return (
            <span
              key={tab.id}
              {...(role === 'tablist' ? { role: 'tab', 'aria-selected': true } : {})}
              className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-blue-500 text-blue-300 font-medium cursor-default whitespace-nowrap"
            >
              <Icon size={14} /> {label}
            </span>
          );
        }
        return (
          <Link
            key={tab.id}
            href={tab.href}
            {...(role === 'tablist' ? { role: 'tab' } : {})}
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap"
          >
            <Icon size={14} /> {label}
          </Link>
        );
      })}
    </div>
  );
}
