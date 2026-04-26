/**
 * DomainDetailPanel — right-hand detail panel for the split-view on
 * /dashboard/admin/domains.
 *
 * BIZZ-785: When a super-admin clicks a domain row in the list, the list
 * stays unchanged on the left and the selected domain's detail opens in
 * this panel on the right. A resizable divider (owned by the parent
 * DomainsListClient) sits between the two halves.
 *
 * The panel hosts a compact sub-tab switcher (Oversigt / Brugere /
 * Skabeloner / Dokumenter / Historik / Indstillinger) and renders the
 * existing per-tab client components inline. No page navigation happens
 * while switching sub-tabs — everything is client-side state.
 *
 * @module app/dashboard/admin/domains/DomainDetailPanel
 */

'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import {
  LayoutDashboard,
  Users,
  FileText,
  History,
  Settings,
  X,
  Loader2,
  Shield,
  type LucideIcon,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

const Loading = () => (
  <div className="flex items-center justify-center py-12 text-slate-500">
    <Loader2 className="w-5 h-5 animate-spin" />
  </div>
);

// Dynamic imports — each sub-tab client component is lazy-loaded so the
// initial list bundle stays lean. ssr:false because these are all pure
// client components that fetch via /api.
const DomainAdminDashboardClient = dynamic(
  () => import('@/app/domain/[id]/admin/DomainAdminDashboardClient'),
  { loading: Loading, ssr: false }
);
const DomainUsersClient = dynamic(() => import('@/app/domain/[id]/admin/users/DomainUsersClient'), {
  loading: Loading,
  ssr: false,
});
const TemplatesListClient = dynamic(
  () => import('@/app/domain/[id]/admin/templates/TemplatesListClient'),
  { loading: Loading, ssr: false }
);
// BIZZ-787: Dokumenter er flyttet ind under skabelon-editoren som et
// resizable side-panel — ikke en selvstændig sub-tab her. TrainingDocsClient
// loades kun hvis nogen deep-linker direkte til /admin/training.
const AuditLogClient = dynamic(() => import('@/app/domain/[id]/admin/audit/AuditLogClient'), {
  loading: Loading,
  ssr: false,
});
const DomainSettingsClient = dynamic(
  () => import('@/app/domain/[id]/admin/settings/DomainSettingsClient'),
  { loading: Loading, ssr: false }
);

type SubTab = 'overview' | 'users' | 'templates' | 'audit' | 'settings';

interface Props {
  domainId: string;
  domainName?: string;
  onClose: () => void;
}

/**
 * Right-hand detail panel with sub-tab switcher and close/full-view actions.
 */
export function DomainDetailPanel({ domainId, domainName, onClose }: Props) {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const [activeTab, setActiveTab] = useState<SubTab>('overview');

  // Reset to overview when the selected domain changes so users land on the
  // dashboard tab for each new selection.
  useEffect(() => {
    setActiveTab('overview');
  }, [domainId]);

  const tabs: Array<{
    id: SubTab;
    icon: LucideIcon;
    labelDa: string;
    labelEn: string;
  }> = [
    { id: 'overview', icon: LayoutDashboard, labelDa: 'Oversigt', labelEn: 'Overview' },
    { id: 'users', icon: Users, labelDa: 'Brugere', labelEn: 'Users' },
    { id: 'templates', icon: FileText, labelDa: 'Skabeloner', labelEn: 'Templates' },
    { id: 'audit', icon: History, labelDa: 'Historik', labelEn: 'Audit log' },
    { id: 'settings', icon: Settings, labelDa: 'Indstillinger', labelEn: 'Settings' },
  ];

  return (
    <div className="h-full flex flex-col bg-slate-900/30 border border-slate-700/40 rounded-xl overflow-hidden">
      {/* Header: domain name + close + open full */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-700/40 bg-slate-900/50">
        <Shield size={16} className="text-purple-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-white text-sm font-semibold truncate">
            {domainName ?? (da ? 'Domain' : 'Domain')}
          </p>
        </div>
        {/* BIZZ-789 v2: "Fuld visning"-link fjernet per user-feedback. */}
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition-colors shrink-0"
          aria-label={da ? 'Luk detalje' : 'Close detail'}
        >
          <X size={14} />
        </button>
      </div>

      {/* Sub-tab strip */}
      <div
        role="tablist"
        className="flex gap-0.5 px-2 border-b border-slate-700/40 overflow-x-auto bg-slate-900/30"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap border-b-2 transition-colors ${
                active
                  ? 'border-blue-500 text-blue-300'
                  : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600'
              }`}
            >
              <Icon size={13} />
              {da ? tab.labelDa : tab.labelEn}
            </button>
          );
        })}
      </div>

      {/* Body — the active sub-tab client component. Each manages its own
          fetches + loading state. */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'overview' && <DomainAdminDashboardClient domainId={domainId} />}
        {activeTab === 'users' && <DomainUsersClient domainId={domainId} />}
        {activeTab === 'templates' && <TemplatesListClient domainId={domainId} />}
        {activeTab === 'audit' && <AuditLogClient domainId={domainId} />}
        {activeTab === 'settings' && <DomainSettingsClient domainId={domainId} />}
      </div>
    </div>
  );
}
