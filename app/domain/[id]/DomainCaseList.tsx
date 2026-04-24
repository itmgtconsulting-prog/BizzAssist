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
  /** BIZZ-809: Kort beskrivelse (max 200 tegn) vist som preview på kortet. */
  short_description?: string | null;
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
  /**
   * BIZZ-800: When provided, intercepts row-click so the parent can open the
   * case inline in a split-view workspace instead of navigating to the
   * full-page case detail route.
   */
  onOpenCase?: (id: string) => void;
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
  onOpenCase,
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

  // BIZZ-897: Fuldbredde-linjer i stedet for grid-cards. Kompakt layout
  // med vandret flex: checkbox | navn | klient-ref | tags | beskrivelse
  // (flex-1, truncate) | status-badge | opdateret-dato. Passer flere sager
  // på skærmen og matcher "table-like" UX brugeren efterspurgte i BIZZ-896.
  return (
    <div className="flex flex-col divide-y divide-slate-800/60 rounded-xl border border-slate-700/40 bg-slate-800/20 overflow-hidden">
      {cases.map((c) => {
        const checked = selectedIds?.has(c.id) ?? false;
        const rowClassName = `flex items-center gap-3 px-4 py-2.5 transition-colors ${
          checked ? 'bg-blue-500/10' : 'hover:bg-slate-800/60'
        }`;
        // BIZZ-800: Wrapper skifter mellem Link og button-div afhængigt
        // af onOpenCase — samme row-indhold i begge tilfælde.
        const Wrapper = ({ children }: { children: React.ReactNode }) =>
          onOpenCase ? (
            <div
              role="button"
              tabIndex={0}
              onClick={() => onOpenCase(c.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpenCase(c.id);
                }
              }}
              className={`${rowClassName} cursor-pointer`}
            >
              {children}
            </div>
          ) : (
            <Link href={`/domain/${domainId}/case/${c.id}`} className={rowClassName}>
              {children}
            </Link>
          );
        return (
          <Wrapper key={c.id}>
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
                className="shrink-0 accent-blue-500"
              />
            )}
            {/* Sagsnavn — primary-label, cap via min-w-0+truncate */}
            <div className="min-w-0 shrink-0 basis-1/4">
              <p className="text-white text-sm font-medium truncate">{c.name}</p>
              {c.client_ref && (
                <p className="text-slate-500 text-[11px] truncate">{c.client_ref}</p>
              )}
            </div>
            {/* Tags (max 2 synlige + overflow-count) */}
            {c.tags.length > 0 && (
              <div className="hidden sm:flex items-center gap-1 shrink-0">
                {c.tags.slice(0, 2).map((t) => (
                  <span
                    key={t}
                    className="px-1.5 py-0.5 bg-slate-700/40 text-slate-300 text-[10px] rounded whitespace-nowrap"
                  >
                    {t}
                  </span>
                ))}
                {c.tags.length > 2 && (
                  <span className="text-slate-500 text-[10px] whitespace-nowrap">
                    +{c.tags.length - 2}
                  </span>
                )}
              </div>
            )}
            {/* Beskrivelse — flex-1 så den optager resten af bredden */}
            <p
              title={c.short_description ?? undefined}
              className="hidden md:block flex-1 min-w-0 text-slate-400 text-xs truncate"
            >
              {c.short_description ?? ''}
            </p>
            {/* Spacer for små skærme så status/dato presses til højre */}
            <span className="md:hidden flex-1" />
            {/* Status-badge */}
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
            {/* Opdateret-dato */}
            <p className="hidden sm:block text-slate-500 text-[11px] shrink-0 tabular-nums">
              {new Date(c.updated_at).toLocaleDateString(da ? 'da-DK' : 'en-GB')}
            </p>
          </Wrapper>
        );
      })}
    </div>
  );
}
