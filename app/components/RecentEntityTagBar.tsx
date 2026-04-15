'use client';

/**
 * RecentEntityTagBar — viser de 3 senest besøgte af hver enhedstype
 * (ejendom, virksomhed, person) som farvekodede tags i 3 rækker.
 *
 * variant="bar"    — standalone bar under topbaren (default)
 * variant="inline" — kompakt inline i topbaren (viser én tag per type, én række)
 *
 * Farver: Ejendom → grøn, Virksomhed → blå, Person → lilla
 * Data fra Supabase — virker på tværs af browsere og enheder.
 *
 * BIZZ-371: Udvidet fra 1 tag per type til 3 tags per type i 3 rækker.
 *
 * @module components/RecentEntityTagBar
 */

import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Building2, Briefcase, User, X } from 'lucide-react';

interface RecentTag {
  type: 'property' | 'company' | 'person';
  /** Unique key combining type + entity id to allow per-tag dismissal */
  key: string;
  href: string;
  label: string;
}

const TYPE_CONFIG: Record<
  RecentTag['type'],
  { bg: string; border: string; text: string; icon: React.ReactNode; rowLabel: string }
> = {
  property: {
    bg: 'bg-emerald-950/60',
    border: 'border-emerald-700/40',
    text: 'text-emerald-300',
    icon: <Building2 size={10} />,
    rowLabel: 'Ejendomme',
  },
  company: {
    bg: 'bg-blue-950/60',
    border: 'border-blue-700/40',
    text: 'text-blue-300',
    icon: <Briefcase size={10} />,
    rowLabel: 'Virksomheder',
  },
  person: {
    bg: 'bg-purple-950/60',
    border: 'border-purple-700/40',
    text: 'text-purple-300',
    icon: <User size={10} />,
    rowLabel: 'Personer',
  },
};

/** Number of tags to show per entity type */
const TAGS_PER_TYPE = 3;

/** Tags dismissed in this browser session — keyed by unique tag key */
const sessionDismissed = new Set<string>();

/**
 * Fetches the 3 most recent tags of each entity type from the API.
 * For 'search' results the resultType field determines which type bucket the
 * entry belongs to, so it is still a single API call for searches.
 *
 * @returns All available tags grouped by type, up to TAGS_PER_TYPE each
 */
async function loadAllTags(): Promise<RecentTag[]> {
  const [searchRes, propRes, companyRes, personRes] = await Promise.all([
    fetch('/api/recents?type=search').catch(() => null),
    fetch('/api/recents?type=property').catch(() => null),
    fetch('/api/recents?type=company').catch(() => null),
    fetch('/api/recents?type=person').catch(() => null),
  ]);

  // Collect up to TAGS_PER_TYPE entries per type in insertion order
  const byType: Record<RecentTag['type'], RecentTag[]> = {
    property: [],
    company: [],
    person: [],
  };

  /**
   * Adds a tag to the relevant type bucket if there is still space.
   *
   * @param type   - Entity type
   * @param href   - Navigation URL
   * @param label  - Display name
   * @param suffix - Optional suffix added to the key to keep it unique
   */
  function addTag(type: RecentTag['type'], href: string, label: string, suffix: string): void {
    if (byType[type].length >= TAGS_PER_TYPE) return;
    const key = `${type}::${suffix}`;
    // Avoid duplicates (same href already present from another source)
    if (byType[type].some((t) => t.href === href)) return;
    byType[type].push({ type, key, href, label });
  }

  // --- Direct property recents ---
  if (propRes?.ok) {
    const json = await propRes.json().catch(() => ({}));
    for (const r of (json.recents ?? []) as Array<Record<string, unknown>>) {
      if (r.entity_id && r.display_name) {
        addTag(
          'property',
          `/dashboard/ejendomme/${r.entity_id}`,
          r.display_name as string,
          r.entity_id as string
        );
      }
    }
  }

  // --- Direct company recents ---
  if (companyRes?.ok) {
    const json = await companyRes.json().catch(() => ({}));
    for (const r of (json.recents ?? []) as Array<Record<string, unknown>>) {
      if (r.entity_id && r.display_name) {
        addTag(
          'company',
          `/dashboard/companies/${r.entity_id}`,
          r.display_name as string,
          r.entity_id as string
        );
      }
    }
  }

  // --- Direct person recents ---
  if (personRes?.ok) {
    const json = await personRes.json().catch(() => ({}));
    for (const r of (json.recents ?? []) as Array<Record<string, unknown>>) {
      if (r.entity_id && r.display_name) {
        addTag(
          'person',
          `/dashboard/owners/${r.entity_id}`,
          r.display_name as string,
          r.entity_id as string
        );
      }
    }
  }

  // --- Search recents (supplement any gaps left by direct recents) ---
  if (searchRes?.ok) {
    const json = await searchRes.json().catch(() => ({}));
    for (const r of (json.recents ?? []) as Array<Record<string, unknown>>) {
      const ed = r.entity_data as Record<string, unknown> | undefined;
      const rt = ed?.resultType as string | undefined;
      const href = ed?.resultHref as string | undefined;
      const label = (ed?.resultTitle ?? r.display_name) as string | undefined;
      const entityId = (r.entity_id as string | undefined) ?? href ?? '';
      if (!href || !label) continue;
      if (rt === 'address') addTag('property', href, label, entityId);
      else if (rt === 'company') addTag('company', href, label, entityId);
      else if (rt === 'person') addTag('person', href, label, entityId);
    }
  }

  // Return in fixed type order: property → company → person
  const ORDER: RecentTag['type'][] = ['property', 'company', 'person'];
  return ORDER.flatMap((t) => byType[t]);
}

interface RecentEntityTagBarProps {
  currentPath: string;
  /** 'inline' = one row of tags in the topbar, 'bar' = 3-row bar below the topbar */
  variant?: 'bar' | 'inline';
}

/**
 * RecentEntityTagBar — renders the most recently visited entities as coloured tags.
 *
 * In 'bar' variant: three labelled rows (Ejendomme / Virksomheder / Personer),
 * each showing up to 3 tags.
 * In 'inline' variant: a flat list of tags (at most one per type) for tight spaces.
 *
 * @param currentPath - Current URL path — highlights the tag for the active page
 * @param variant     - 'inline' | 'bar' (default: 'inline')
 */
/** BIZZ-211: memoized to prevent re-renders from dashboard layout state changes */
const RecentEntityTagBar = React.memo(function RecentEntityTagBar({
  currentPath,
  variant = 'inline',
}: RecentEntityTagBarProps) {
  const [tags, setTags] = useState<RecentTag[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set(sessionDismissed));

  const refresh = useCallback(async () => {
    const all = await loadAllTags();
    setTags(all.filter((t) => !sessionDismissed.has(t.key)));
  }, []);

  // Initial load
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Re-load whenever any part of the app signals that recents have changed
  useEffect(() => {
    window.addEventListener('ba-recents-updated', refresh);
    return () => window.removeEventListener('ba-recents-updated', refresh);
  }, [refresh]);

  /**
   * Dismisses a single tag for the duration of the browser session.
   *
   * @param key - Unique tag key to dismiss
   */
  const dismiss = useCallback((key: string) => {
    sessionDismissed.add(key);
    setDismissed((prev) => new Set([...prev, key]));
    setTags((prev) => prev.filter((t) => t.key !== key));
  }, []);

  const visibleTags = tags.filter((t) => !dismissed.has(t.key));
  if (visibleTags.length === 0) return null;

  /**
   * Renders a single tag pill with a dismiss button.
   *
   * @param tag - Tag data
   * @returns JSX element
   */
  function renderTag(tag: RecentTag): React.ReactElement {
    const cfg = TYPE_CONFIG[tag.type];
    const isCurrent = tag.href === currentPath;
    return (
      <div
        key={tag.key}
        className={`flex items-center gap-1 ${cfg.bg} border ${
          isCurrent ? cfg.text.replace('text-', 'border-') : cfg.border
        } rounded-full pl-2 pr-1 py-0.5 shrink-0 ${
          isCurrent ? 'ring-1 ring-current opacity-100' : 'opacity-80 hover:opacity-100'
        } transition-opacity`}
      >
        <Link
          href={tag.href}
          className={`flex items-center gap-1 ${cfg.text} text-[11px] font-medium transition-opacity max-w-[160px]`}
          title={tag.label}
        >
          <span>{cfg.icon}</span>
          <span className="truncate">{tag.label}</span>
        </Link>
        <button
          onClick={() => dismiss(tag.key)}
          className={`ml-0.5 ${cfg.text} opacity-40 hover:opacity-100 transition-opacity rounded-full p-0.5`}
          aria-label={`Fjern ${cfg.rowLabel ?? tag.type} tag`}
        >
          <X size={9} />
        </button>
      </div>
    );
  }

  // ---- inline variant: flat one-row list (legacy/compact usage) ----
  if (variant === 'inline') {
    // Show at most one tag per type to keep topbar compact
    const seenTypes = new Set<RecentTag['type']>();
    const inlineTags = visibleTags.filter((t) => {
      if (seenTypes.has(t.type)) return false;
      seenTypes.add(t.type);
      return true;
    });
    return <div className="flex items-center gap-1.5">{inlineTags.map(renderTag)}</div>;
  }

  // ---- bar variant: 3 rows, one per entity type ----
  const ORDER: RecentTag['type'][] = ['property', 'company', 'person'];

  return (
    <div className="flex flex-col border-b border-white/5 bg-[#0a1020]/60 shrink-0">
      {ORDER.map((type) => {
        const rowTags = visibleTags.filter((t) => t.type === type);
        if (rowTags.length === 0) return null;
        const cfg = TYPE_CONFIG[type];
        return (
          <div
            key={type}
            className="flex items-center gap-2 px-4 py-1 border-b border-white/[0.03] last:border-b-0 overflow-x-auto scrollbar-hide"
          >
            {/* Row label — hidden on very small screens */}
            <span
              className={`text-[10px] uppercase tracking-wider font-semibold shrink-0 hidden sm:block w-20 ${cfg.text} opacity-50`}
            >
              {cfg.rowLabel}
            </span>
            <div className="flex items-center gap-1.5">{rowTags.map(renderTag)}</div>
          </div>
        );
      })}
    </div>
  );
});

export default RecentEntityTagBar;
