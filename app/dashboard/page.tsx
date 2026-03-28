'use client';

/**
 * Dashboard hovedside — viser overblik over brugerens aktivitet.
 *
 * Datakilde:
 *   - Seneste ejendomme: localStorage via recentEjendomme.ts
 *   - Fulgte ejendomme: localStorage via trackedEjendomme.ts
 *   - Seneste virksomheder: localStorage (ba-companies-recent)
 *
 * Lytter på 'ba-tracked-changed' og 'storage' events for at opdatere data.
 */

import { useState, useEffect, useCallback } from 'react';
import { Building2, Users, Briefcase, ChevronRight, Eye, MapPin } from 'lucide-react';
import Link from 'next/link';
import { useLanguage } from '@/app/context/LanguageContext';
import { hentRecentEjendomme, type RecentEjendom } from '@/app/lib/recentEjendomme';
import { hentTrackedEjendomme, type TrackedEjendom } from '@/app/lib/trackedEjendomme';

/** Seneste virksomhed gemt i localStorage */
interface RecentCompany {
  cvr: string;
  name: string;
  industry?: string;
  city?: string;
  ts: number;
}

/** Fulgt virksomhed gemt i localStorage (ba-tracked-companies) */
interface TrackedCompany {
  cvr: string;
  navn: string;
  trackedSiden: number;
}

export default function DashboardPage() {
  const { lang } = useLanguage();
  const da = lang === 'da';

  /* ------------------------------------------------------------------ */
  /*  State                                                              */
  /* ------------------------------------------------------------------ */

  const [trackedEjendomme, setTrackedEjendomme] = useState<TrackedEjendom[]>([]);
  const [trackedCompanies, setTrackedCompanies] = useState<TrackedCompany[]>([]);
  const [recentEjendomme, setRecentEjendomme] = useState<RecentEjendom[]>([]);
  const [recentCompanies, setRecentCompanies] = useState<RecentCompany[]>([]);

  /** Collapsible sections — all collapsed by default */
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});

  /** Toggle a collapsible section open/closed */
  const toggle = (key: string) => setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  /**
   * Indlæser alle dashboard-data fra localStorage.
   * Kaldt ved mount og når tracked/storage events fyres.
   */
  const refreshData = useCallback(() => {
    setTrackedEjendomme(hentTrackedEjendomme());
    setRecentEjendomme(hentRecentEjendomme());

    // Fulgte virksomheder fra localStorage
    try {
      const rawTracked = localStorage.getItem('ba-tracked-companies');
      if (rawTracked) {
        const parsed = JSON.parse(rawTracked) as TrackedCompany[];
        setTrackedCompanies(Array.isArray(parsed) ? parsed : []);
      }
    } catch {
      setTrackedCompanies([]);
    }

    // Seneste virksomheder fra localStorage
    try {
      const raw = localStorage.getItem('ba-companies-recent');
      if (raw) {
        const parsed = JSON.parse(raw) as RecentCompany[];
        setRecentCompanies(Array.isArray(parsed) ? parsed.slice(0, 8) : []);
      }
    } catch {
      setRecentCompanies([]);
    }
  }, []);

  /** Indlæs data ved mount og lyt efter ændringer */
  useEffect(() => {
    refreshData();

    const handler = () => refreshData();
    window.addEventListener('storage', handler);
    window.addEventListener('ba-tracked-changed', handler);
    return () => {
      window.removeEventListener('storage', handler);
      window.removeEventListener('ba-tracked-changed', handler);
    };
  }, [refreshData]);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Welcome */}
      <div>
        <h1 className="text-2xl font-bold text-white">
          {da ? 'Velkommen til BizzAssist' : 'Welcome to BizzAssist'}
        </h1>
        <p className="text-slate-400 mt-1">
          {da
            ? 'Her er et overblik over din aktivitet og de seneste data.'
            : "Here's an overview of your activity and the latest data."}
        </p>
      </div>

      {/* Quick actions — 4 navigation cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          {
            icon: Building2,
            labelDa: 'Ejendomme',
            labelEn: 'Properties',
            href: '/dashboard/ejendomme',
            color: 'bg-emerald-500/10 text-emerald-400',
          },
          {
            icon: Briefcase,
            labelDa: 'Virksomheder',
            labelEn: 'Companies',
            href: '/dashboard/companies',
            color: 'bg-blue-500/10 text-blue-400',
          },
          {
            icon: Users,
            labelDa: 'Ejere',
            labelEn: 'Owners',
            href: '/dashboard/owners',
            color: 'bg-purple-500/10 text-purple-400',
          },
          {
            icon: MapPin,
            labelDa: 'Kort',
            labelEn: 'Map',
            href: '/dashboard/kort',
            color: 'bg-amber-500/10 text-amber-400',
          },
        ].map((action) => {
          const Icon = action.icon;
          return (
            <Link
              key={action.href}
              href={action.href}
              className="bg-white/5 border border-white/8 hover:border-blue-500/40 hover:bg-white/8 rounded-2xl p-5 flex flex-col items-center gap-3 transition-all group"
            >
              <div
                className={`w-12 h-12 rounded-xl flex items-center justify-center ${action.color}`}
              >
                <Icon size={22} />
              </div>
              <span className="text-sm font-medium text-slate-400 group-hover:text-white transition-colors">
                {da ? action.labelDa : action.labelEn}
              </span>
            </Link>
          );
        })}
      </div>

      {/* Main content */}
      <div className="space-y-4">
        {/* ─── Seneste ejendomme (collapsible) ─── */}
        <CollapsibleSection
          title={da ? 'Seneste ejendomme' : 'Recent properties'}
          count={recentEjendomme.length}
          titleColor="text-emerald-400"
          open={!!openSections['recent-props']}
          onToggle={() => toggle('recent-props')}
          linkHref="/dashboard/ejendomme"
          linkLabel={da ? 'Se alle' : 'View all'}
        >
          {recentEjendomme.length === 0 ? (
            <EmptyState
              icon={<Building2 size={24} className="mx-auto mb-2 text-slate-600" />}
              text={
                da
                  ? 'Ingen seneste ejendomme — søg efter en adresse for at komme i gang.'
                  : 'No recent properties — search for an address to get started.'
              }
            />
          ) : (
            recentEjendomme.map((ej) => (
              <Link
                key={ej.id}
                href={`/dashboard/ejendomme/${ej.id}`}
                className="flex items-center gap-4 px-6 py-3.5 hover:bg-white/5 transition-colors group"
              >
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-emerald-500/10 text-emerald-400">
                  <Building2 size={14} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-slate-200 text-sm truncate">{ej.adresse}</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {ej.postnr} {ej.by}
                    {ej.kommune ? ` · ${ej.kommune}` : ''}
                  </div>
                </div>
                <ChevronRight
                  size={14}
                  className="text-slate-600 group-hover:text-slate-400 shrink-0"
                />
              </Link>
            ))
          )}
        </CollapsibleSection>

        {/* ─── Seneste virksomheder (collapsible) ─── */}
        <CollapsibleSection
          title={da ? 'Seneste virksomheder' : 'Recent companies'}
          count={recentCompanies.length}
          titleColor="text-blue-400"
          open={!!openSections['recent-companies']}
          onToggle={() => toggle('recent-companies')}
          linkHref="/dashboard/companies"
          linkLabel={da ? 'Se alle' : 'View all'}
        >
          {recentCompanies.length === 0 ? (
            <EmptyState
              icon={<Briefcase size={24} className="mx-auto mb-2 text-slate-600" />}
              text={
                da
                  ? 'Ingen seneste virksomheder — søg efter et CVR-nummer eller virksomhedsnavn.'
                  : 'No recent companies — search for a CVR number or company name.'
              }
            />
          ) : (
            recentCompanies.map((c) => (
              <Link
                key={c.cvr}
                href={`/dashboard/companies/${c.cvr}`}
                className="flex items-center gap-4 px-6 py-3.5 hover:bg-white/5 transition-colors group"
              >
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-blue-500/10 text-blue-400">
                  <Briefcase size={14} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-slate-200 text-sm truncate">{c.name}</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    CVR {c.cvr}
                    {c.industry ? ` · ${c.industry}` : ''}
                    {c.city ? ` · ${c.city}` : ''}
                  </div>
                </div>
                <ChevronRight
                  size={14}
                  className="text-slate-600 group-hover:text-slate-400 shrink-0"
                />
              </Link>
            ))
          )}
        </CollapsibleSection>

        {/* ─── Seneste ejere (collapsible) ─── */}
        <CollapsibleSection
          title={da ? 'Seneste ejere' : 'Recent owners'}
          count={0}
          titleColor="text-purple-400"
          open={!!openSections['recent-owners']}
          onToggle={() => toggle('recent-owners')}
          linkHref="/dashboard/owners"
          linkLabel={da ? 'Se alle' : 'View all'}
        >
          <EmptyState
            icon={<Users size={24} className="mx-auto mb-2 text-slate-600" />}
            text={
              da
                ? 'Ejersøgning er under udvikling — her vil dine seneste ejere blive vist.'
                : 'Owner search is under development — your recent owners will appear here.'
            }
          />
        </CollapsibleSection>

        {/* ─── Fulgte (ejendomme + virksomheder + ejere, grupperet) ─── */}
        <CollapsibleSection
          title={da ? 'Fulgte' : 'Tracked'}
          count={trackedEjendomme.length + trackedCompanies.length}
          titleColor="text-amber-400"
          open={!!openSections['tracked']}
          onToggle={() => toggle('tracked')}
          linkHref="/dashboard/settings"
          linkLabel={da ? 'Administrer' : 'Manage'}
          badgeColor="bg-amber-500/20 text-amber-400"
        >
          {trackedEjendomme.length === 0 && trackedCompanies.length === 0 ? (
            <EmptyState
              icon={<Eye size={24} className="mx-auto mb-2 text-slate-600" />}
              text={
                da
                  ? 'Du følger ingenting endnu — tryk "Følg" på en ejendoms- eller virksomhedsside.'
                  : 'You are not tracking anything yet — click "Follow" on a property or company page.'
              }
            />
          ) : (
            <>
              {/* Ejendomme gruppe */}
              {trackedEjendomme.length > 0 && (
                <>
                  <div className="px-6 py-2 bg-white/3">
                    <span className="text-[11px] font-semibold text-emerald-400 uppercase tracking-wider">
                      {da ? 'Ejendomme' : 'Properties'}
                    </span>
                  </div>
                  {trackedEjendomme.map((ej) => (
                    <Link
                      key={ej.id}
                      href={`/dashboard/ejendomme/${ej.id}`}
                      className="flex items-center gap-4 px-6 py-3.5 hover:bg-white/5 transition-colors group"
                    >
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-emerald-500/10 text-emerald-400">
                        <Building2 size={14} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-slate-200 text-sm truncate">
                          {ej.adresse}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {ej.postnr} {ej.by}
                          {ej.kommune ? ` · ${ej.kommune}` : ''}
                        </div>
                      </div>
                      <ChevronRight
                        size={14}
                        className="text-slate-600 group-hover:text-slate-400 shrink-0"
                      />
                    </Link>
                  ))}
                </>
              )}

              {/* Virksomheder gruppe */}
              {trackedCompanies.length > 0 && (
                <>
                  <div className="px-6 py-2 bg-white/3">
                    <span className="text-[11px] font-semibold text-blue-400 uppercase tracking-wider">
                      {da ? 'Virksomheder' : 'Companies'}
                    </span>
                  </div>
                  {trackedCompanies.map((c) => (
                    <Link
                      key={c.cvr}
                      href={`/dashboard/companies/${c.cvr}`}
                      className="flex items-center gap-4 px-6 py-3.5 hover:bg-white/5 transition-colors group"
                    >
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-blue-500/10 text-blue-400">
                        <Briefcase size={14} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-slate-200 text-sm truncate">{c.navn}</div>
                        <div className="text-xs text-slate-500 mt-0.5">CVR {c.cvr}</div>
                      </div>
                      <ChevronRight
                        size={14}
                        className="text-slate-600 group-hover:text-slate-400 shrink-0"
                      />
                    </Link>
                  ))}
                </>
              )}

              {/* Ejere gruppe — placeholder til fremtiden */}
            </>
          )}
        </CollapsibleSection>
      </div>
    </div>
  );
}

/* ================================================================== */
/*  Reusable sub-components                                            */
/* ================================================================== */

/** Props for the collapsible section wrapper */
interface CollapsibleSectionProps {
  /** Section title */
  title: string;
  /** Item count shown in badge */
  count: number;
  /** Tailwind text color class for the title (e.g. "text-emerald-400") */
  titleColor?: string;
  /** Whether the section is expanded */
  open: boolean;
  /** Toggle handler */
  onToggle: () => void;
  /** Optional link in header */
  linkHref?: string;
  /** Optional link label */
  linkLabel?: string;
  /** Badge color classes (default: slate) */
  badgeColor?: string;
  /** Section content (list items) */
  children: React.ReactNode;
}

/**
 * Collapsible card section with header, count badge, and optional link.
 * Content is hidden when collapsed; header is always visible and clickable.
 */
function CollapsibleSection({
  title,
  count,
  titleColor = 'text-white',
  open,
  onToggle,
  linkHref,
  linkLabel,
  badgeColor = 'bg-slate-700/60 text-slate-400',
  children,
}: CollapsibleSectionProps) {
  return (
    <div className="bg-white/5 border border-white/8 rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/8">
        <button
          onClick={onToggle}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <ChevronRight
            size={14}
            className={`${titleColor} transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
          />
          <h2 className={`font-semibold text-sm ${titleColor}`}>{title}</h2>
          {count > 0 && (
            <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${badgeColor}`}>
              {count}
            </span>
          )}
        </button>
        {linkHref && linkLabel && (
          <Link href={linkHref} className="text-blue-400 text-xs font-medium hover:text-blue-300">
            {linkLabel}
          </Link>
        )}
      </div>
      {open && <div className="divide-y divide-white/5">{children}</div>}
    </div>
  );
}

/** Props for the empty state placeholder */
interface EmptyStateProps {
  /** Icon to display */
  icon: React.ReactNode;
  /** Message text */
  text: string;
}

/**
 * Centered empty state with icon and message text.
 */
function EmptyState({ icon, text }: EmptyStateProps) {
  return (
    <div className="px-6 py-8 text-center">
      {icon}
      <p className="text-slate-500 text-sm">{text}</p>
    </div>
  );
}
