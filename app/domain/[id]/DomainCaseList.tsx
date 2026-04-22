/**
 * DomainCaseList — shared case-grid used by the domain user dashboard and
 * potentially the admin cases overview.
 *
 * BIZZ-760: Extracted from DomainUserDashboardClient.tsx so a second
 * consumer (admin-side cases view, bulk-selection UI per BIZZ-759) can
 * reuse the same rendering without forking the cards + empty-state.
 *
 * The component is display-only — parent owns fetching, search+status
 * state, and click handling. Selection is optional: when `selectable`
 * is true, cards show a checkbox and `onToggleSelect` is invoked.
 *
 * @module app/domain/[id]/DomainCaseList
 */
'use client';

import Link from 'next/link';
import { Briefcase, Plus } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

export interface DomainCaseSummary {
  id: string;
  name: string;
  client_ref: string | null;
  status: 'open' | 'closed' | 'archived';
  tags: string[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DomainCaseListProps {
  /** Domain UUID — used to build per-case href. */
  domainId: string;
  /** Cases to render. */
  cases: DomainCaseSummary[];
  /** Empty-state behaviour: show the "create your first case" call-to-action. */
  showCreateEmptyAction?: boolean;
  /** BIZZ-759 hook — render checkbox per card when true. */
  selectable?: boolean;
  /** Currently-selected case IDs (controlled by parent). */
  selectedIds?: Set<string>;
  /** Invoked when the user toggles a card's checkbox. */
  onToggleSelect?: (id: string) => void;
}

/**
 * Renders the case-grid with status badges, tags, and updated-date.
 * Click on a card → navigate to the case detail page. Checkbox-click
 * is intercepted (stopPropagation) so it doesn't also trigger navigation.
 */
export function DomainCaseList({
  domainId,
  cases,
  showCreateEmptyAction = true,
  selectable = false,
  selectedIds,
  onToggleSelect,
}: DomainCaseListProps) {
  const { lang } = useLanguage();
  const da = lang === 'da';

  if (cases.length === 0) {
    return (
      <div className="text-center py-16 bg-slate-800/40 border border-slate-700/40 rounded-xl">
        <Briefcase size={32} className="mx-auto text-slate-600 mb-3" />
        <p className="text-slate-400 text-sm">{da ? 'Ingen sager fundet' : 'No cases found'}</p>
        {showCreateEmptyAction && (
          <Link
            href={`/domain/${domainId}/new-case`}
            className="mt-4 inline-flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded-md text-white text-sm font-medium"
          >
            <Plus size={14} />
            {da ? 'Opret første sag' : 'Create first case'}
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {cases.map((c) => {
        const checked = selectedIds?.has(c.id) ?? false;
        return (
          <Link
            key={c.id}
            href={`/domain/${domainId}/case/${c.id}`}
            className={`block bg-slate-800/40 border rounded-xl p-4 transition-colors ${
              checked
                ? 'border-blue-500/60 bg-slate-800/80'
                : 'border-slate-700/40 hover:bg-slate-800/60'
            }`}
          >
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="flex items-start gap-2 flex-1 min-w-0">
                {selectable && (
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      e.stopPropagation();
                      onToggleSelect?.(c.id);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={da ? `Vælg ${c.name}` : `Select ${c.name}`}
                    className="mt-0.5 accent-blue-500"
                  />
                )}
                <h3 className="text-white font-medium text-sm truncate flex-1">{c.name}</h3>
              </div>
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
        );
      })}
    </div>
  );
}
