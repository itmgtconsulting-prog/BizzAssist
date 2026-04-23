/**
 * DomainDetailSplitView — master-detail split view for super-admin domain detail.
 *
 * BIZZ-784: When a super-admin navigates into /dashboard/admin/domains/[id],
 * the page splits into two columns:
 *   - Left: compact list of all domains (click to switch)
 *   - Right: the selected domain's detail (DomainAdminTabs + sub-page)
 *
 * The right panel has a collapse toggle so the super-admin can hide the detail
 * and let the list fill the viewport. This is the "iter 2" follow-up promised
 * in BIZZ-780 — a resizable divider is still future work; collapsing is the
 * minimum viable master-detail UX.
 *
 * @module app/dashboard/admin/domains/[id]/DomainDetailSplitView
 */

'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Building2,
  CheckCircle,
  AlertTriangle,
  Archive,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { DomainAdminTabs } from '@/app/domain/[id]/admin/DomainAdminTabs';

/** Compact domain summary for the left sidebar list. */
export interface DomainSummary {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'archived';
}

interface Props {
  /** Currently-selected domain id (from the URL). */
  domainId: string;
  /** Name of the selected domain, used in the admin-tabs header. */
  domainName?: string;
  /** All domains the super-admin can switch between. */
  domains: DomainSummary[];
  /** The detail page content (Oversigt / Brugere / etc). */
  children: React.ReactNode;
}

/** Status icon for the left-sidebar list rows. */
function statusIcon(status: DomainSummary['status']) {
  if (status === 'active') return <CheckCircle size={12} className="text-emerald-400" />;
  if (status === 'suspended') return <AlertTriangle size={12} className="text-amber-400" />;
  return <Archive size={12} className="text-slate-400" />;
}

/**
 * Renders a 2-column master-detail layout:
 *   - Left: domain list (fixed width, always visible)
 *   - Right: domain detail (collapsible)
 *
 * Collapsing the right panel hides the detail and shows only a floating
 * "show detail" button at the top-right so the user can re-open it.
 */
export function DomainDetailSplitView({ domainId, domainName, domains, children }: Props) {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex gap-4 w-full min-h-[calc(100vh-200px)]">
      {/* LEFT: domain list */}
      <aside
        className={`shrink-0 border border-slate-700/40 rounded-xl bg-slate-900/40 overflow-y-auto ${
          collapsed ? 'w-full' : 'w-72'
        }`}
      >
        <div className="px-3 py-2 border-b border-slate-700/40 flex items-center justify-between">
          <h2 className="text-xs uppercase tracking-wide text-slate-400 flex items-center gap-1.5">
            <Building2 size={12} /> {da ? 'Domains' : 'Domains'}
            <span className="text-slate-500">· {domains.length}</span>
          </h2>
          {collapsed && (
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
              title={da ? 'Vis detaljer' : 'Show details'}
            >
              <PanelRightOpen size={14} />
              {da ? 'Vis detaljer' : 'Show details'}
            </button>
          )}
        </div>

        <ul className="py-1">
          {domains.map((d) => {
            const active = d.id === domainId;
            return (
              <li key={d.id}>
                <Link
                  href={`/dashboard/admin/domains/${d.id}`}
                  className={`flex items-center gap-2 px-3 py-2 text-sm transition-colors ${
                    active
                      ? 'bg-blue-500/15 text-white border-l-2 border-blue-400'
                      : 'text-slate-300 hover:bg-slate-800/60 border-l-2 border-transparent'
                  }`}
                >
                  {statusIcon(d.status)}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{d.name}</div>
                    <div className="truncate text-[11px] text-slate-500">{d.slug}</div>
                  </div>
                </Link>
              </li>
            );
          })}
          {domains.length === 0 && (
            <li className="px-3 py-4 text-center text-xs text-slate-500">
              {da ? 'Ingen domains' : 'No domains'}
            </li>
          )}
        </ul>
      </aside>

      {/* RIGHT: domain detail (collapsible) */}
      {!collapsed && (
        <div className="flex-1 min-w-0 border border-slate-700/40 rounded-xl bg-slate-900/20 overflow-hidden flex flex-col">
          {/* Collapse-button bar */}
          <div className="flex justify-end px-2 py-1 border-b border-slate-700/40">
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              title={da ? 'Skjul detaljer' : 'Hide details'}
            >
              <PanelRightClose size={14} />
              {da ? 'Skjul' : 'Hide'}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            <DomainAdminTabs
              domainId={domainId}
              domainName={domainName}
              hrefBase={`/dashboard/admin/domains/${domainId}`}
              backHref="/dashboard/admin/domains"
            />
            {children}
          </div>
        </div>
      )}
    </div>
  );
}
