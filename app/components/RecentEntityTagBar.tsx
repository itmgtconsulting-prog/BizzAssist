'use client';

/**
 * RecentEntityTagBar — viser de senest besøgte enheder (ejendom, virksomhed, person)
 * som farvekodede tags.
 *
 * variant="bar"    — standalone bar under topbaren (default)
 * variant="inline" — kompakt inline i topbaren
 *
 * Farver: Ejendom → grøn, Virksomhed → blå, Person → lilla
 * Data fra Supabase — virker på tværs af browsere og enheder.
 *
 * @module components/RecentEntityTagBar
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Building2, Briefcase, User, X } from 'lucide-react';

interface RecentTag {
  type: 'property' | 'company' | 'person';
  href: string;
  label: string;
}

const TYPE_CONFIG: Record<
  RecentTag['type'],
  { bg: string; border: string; text: string; icon: React.ReactNode; label: string }
> = {
  property: {
    bg: 'bg-emerald-950/60',
    border: 'border-emerald-700/40',
    text: 'text-emerald-300',
    icon: <Building2 size={10} />,
    label: 'Ejendom',
  },
  company: {
    bg: 'bg-blue-950/60',
    border: 'border-blue-700/40',
    text: 'text-blue-300',
    icon: <Briefcase size={10} />,
    label: 'Virksomhed',
  },
  person: {
    bg: 'bg-purple-950/60',
    border: 'border-purple-700/40',
    text: 'text-purple-300',
    icon: <User size={10} />,
    label: 'Person',
  },
};

/** Tags afvist i denne session */
const sessionDismissed = new Set<string>();

async function loadAllTags(): Promise<RecentTag[]> {
  const [searchRes, propRes] = await Promise.all([
    fetch('/api/recents?type=search').catch(() => null),
    fetch('/api/recents?type=property').catch(() => null),
  ]);

  const tags = new Map<string, RecentTag>();

  if (propRes?.ok) {
    const json = await propRes.json().catch(() => ({}));
    const latest = ((json.recents ?? []) as Array<Record<string, unknown>>)[0];
    if (latest?.entity_id && latest?.display_name) {
      tags.set('property', {
        type: 'property',
        href: `/dashboard/ejendomme/${latest.entity_id}`,
        label: latest.display_name as string,
      });
    }
  }

  if (searchRes?.ok) {
    const json = await searchRes.json().catch(() => ({}));
    const recents: Array<Record<string, unknown>> = (json.recents ?? []) as Array<
      Record<string, unknown>
    >;
    for (const r of recents) {
      const ed = r.entity_data as Record<string, unknown> | undefined;
      const rt = ed?.resultType as string | undefined;
      const href = ed?.resultHref as string | undefined;
      const label = (ed?.resultTitle ?? r.display_name) as string | undefined;
      if (!href || !label) continue;
      if (rt === 'address' && !tags.has('property'))
        tags.set('property', { type: 'property', href, label });
      else if (rt === 'company' && !tags.has('company'))
        tags.set('company', { type: 'company', href, label });
      else if (rt === 'person' && !tags.has('person'))
        tags.set('person', { type: 'person', href, label });
      if (tags.size === 3) break;
    }
  }

  const ORDER: RecentTag['type'][] = ['property', 'company', 'person'];
  return [...tags.values()].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
}

interface RecentEntityTagBarProps {
  currentPath: string;
  /** 'inline' = compact tags i topbaren, 'bar' = standalone bar under topbaren */
  variant?: 'bar' | 'inline';
}

/**
 * RecentEntityTagBar — gengives som enten inline (i topbaren) eller som bar (under topbaren).
 *
 * @param currentPath - Aktuel URL-sti — undgår at vise tag for siden man er på
 * @param variant     - 'inline' | 'bar' (default: 'inline')
 */
export default function RecentEntityTagBar({
  currentPath,
  variant = 'inline',
}: RecentEntityTagBarProps) {
  const [tags, setTags] = useState<RecentTag[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set(sessionDismissed));

  const refresh = useCallback(async () => {
    const all = await loadAllTags();
    setTags(all.filter((t) => !sessionDismissed.has(t.type)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    window.addEventListener('ba-recents-updated', refresh);
    return () => window.removeEventListener('ba-recents-updated', refresh);
  }, [refresh]);

  const dismiss = useCallback((type: RecentTag['type']) => {
    sessionDismissed.add(type);
    setDismissed((prev) => new Set([...prev, type]));
    setTags((prev) => prev.filter((t) => t.type !== type));
  }, []);

  const visibleTags = tags.filter((t) => !dismissed.has(t.type));
  if (visibleTags.length === 0) return null;

  const tagList = (
    <div className="flex items-center gap-1.5">
      {visibleTags.map((tag) => {
        const cfg = TYPE_CONFIG[tag.type];
        const isCurrent = tag.href === currentPath;
        return (
          <div
            key={tag.type}
            className={`flex items-center gap-1 ${cfg.bg} border ${isCurrent ? cfg.text.replace('text-', 'border-') : cfg.border} rounded-full pl-2 pr-1 py-0.5 shrink-0 ${isCurrent ? 'ring-1 ring-current opacity-100' : 'opacity-80 hover:opacity-100'} transition-opacity`}
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
              onClick={() => dismiss(tag.type)}
              className={`ml-0.5 ${cfg.text} opacity-40 hover:opacity-100 transition-opacity rounded-full p-0.5`}
              aria-label={`Fjern ${cfg.label} tag`}
            >
              <X size={9} />
            </button>
          </div>
        );
      })}
    </div>
  );

  if (variant === 'bar') {
    return (
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-white/5 bg-[#0a1020]/60 shrink-0 overflow-x-auto scrollbar-hide">
        <span className="text-[10px] text-slate-600 uppercase tracking-wider font-semibold shrink-0 hidden sm:block">
          Senest
        </span>
        {tagList}
      </div>
    );
  }

  // inline — bare tags, ingen ydre wrapper styling
  return tagList;
}
