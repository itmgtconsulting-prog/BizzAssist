'use client';

/**
 * Dashboard hovedside — viser overblik over brugerens aktivitet.
 *
 * Datakilde:
 *   - Seneste ejendomme: Supabase via recentEjendomme.ts
 *   - Fulgte ejendomme: localStorage via trackedEjendomme.ts
 *   - Seneste virksomheder: Supabase via recentCompanies.ts
 *
 * Lytter på 'ba-tracked-changed', 'ba-recents-updated' og 'storage' events.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Building2,
  Users,
  Briefcase,
  ChevronRight,
  Eye,
  MapPin,
  X,
  FlaskConical,
  ShieldAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';
import { createClient } from '@/lib/supabase/client';
import { hentRecentEjendomme, type RecentEjendom } from '@/app/lib/recentEjendomme';
import { hentTrackedEjendomme, type TrackedEjendom } from '@/app/lib/trackedEjendomme';
import { getRecentCompanies, type RecentCompany } from '@/app/lib/recentCompanies';
import { getRecentPersons, type RecentPerson } from '@/app/lib/recentPersons';

/** Fulgt virksomhed gemt i localStorage (ba-tracked-companies) */
interface TrackedCompany {
  cvr: string;
  navn: string;
  trackedSiden: number;
}

export default function DashboardPageClient() {
  const { lang } = useLanguage();
  const t = translations[lang];
  const d = t.dashboard;

  /* ------------------------------------------------------------------ */
  /*  State                                                              */
  /* ------------------------------------------------------------------ */

  const [trackedEjendomme, setTrackedEjendomme] = useState<TrackedEjendom[]>([]);
  const [trackedCompanies, setTrackedCompanies] = useState<TrackedCompany[]>([]);
  const [recentEjendomme, setRecentEjendomme] = useState<RecentEjendom[]>([]);
  const [recentCompanies, setRecentCompanies] = useState<RecentCompany[]>([]);
  const [recentPersons, setRecentPersons] = useState<RecentPerson[]>([]);

  /** Collapsible sections — all collapsed by default */
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});

  /** Beta banner — hidden if user has dismissed it */
  const [showBetaBanner, setShowBetaBanner] = useState(false);

  /** 2FA recommendation banner — shown to email/password users who haven't enrolled TOTP */
  const [show2faBanner, setShow2faBanner] = useState(false);

  /** Read localStorage after mount to avoid SSR mismatch */
  useEffect(() => {
    if (localStorage.getItem('ba-beta-banner-dismissed') !== '1') {
      setShowBetaBanner(true);
    }
  }, []);

  /** Dismiss beta banner and persist to localStorage */
  const dismissBetaBanner = () => {
    localStorage.setItem('ba-beta-banner-dismissed', '1');
    setShowBetaBanner(false);
  };

  /**
   * Check whether the logged-in user is an email/password user without TOTP enrolled.
   * OAuth-only users are excluded — they rely on their identity provider's 2FA.
   * Runs once on mount; dismissal state is stored in localStorage for the session.
   */
  useEffect(() => {
    if (localStorage.getItem('ba-2fa-banner-dismissed') === '1') return;

    const checkMfaStatus = async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      // Only show for email/password users (not OAuth-only accounts)
      const providers = (user.app_metadata?.providers as string[] | undefined) ?? [];
      const isOAuthOnly =
        providers.length > 0 &&
        !providers.includes('email') &&
        providers.some((p) => ['azure', 'google', 'linkedin_oidc'].includes(p));
      if (isOAuthOnly) return;

      // Hide if user has already enrolled a verified TOTP factor
      const { data: factorsData } = await supabase.auth.mfa.listFactors();
      const hasVerifiedTotp = factorsData?.totp?.some((f) => f.status === 'verified');
      if (hasVerifiedTotp) return;

      setShow2faBanner(true);
    };

    checkMfaStatus();
  }, []);

  /** Dismiss the 2FA recommendation banner for the rest of this browser session */
  const dismiss2faBanner = () => {
    localStorage.setItem('ba-2fa-banner-dismissed', '1');
    setShow2faBanner(false);
  };

  /** Toggle a collapsible section open/closed */
  const toggle = (key: string) => setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  /**
   * Indlæser fulgte virksomheder — Supabase som primær kilde, localStorage som fallback.
   * Supabase-resultater skrives tilbage til localStorage for konsistens på tværs af faner.
   */
  const refreshTrackedCompanies = useCallback(async () => {
    try {
      const res = await fetch('/api/tracked-companies');
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json.tracked) && json.tracked.length > 0) {
          const mapped: TrackedCompany[] = json.tracked.map(
            (e: { entity_id: string; label: string | null; created_at: string }) => ({
              cvr: e.entity_id,
              navn: e.label ?? e.entity_id,
              trackedSiden: new Date(e.created_at).getTime(),
            })
          );
          setTrackedCompanies(mapped);
          // Keep localStorage in sync as fallback for offline/tab scenarios
          try {
            localStorage.setItem('ba-tracked-companies', JSON.stringify(mapped));
          } catch {
            /* ignore quota errors */
          }
          return;
        }
      }
    } catch {
      /* Supabase unavailable — fall through to localStorage */
    }

    // localStorage fallback
    try {
      const rawTracked = localStorage.getItem('ba-tracked-companies');
      if (rawTracked) {
        const parsed = JSON.parse(rawTracked) as TrackedCompany[];
        setTrackedCompanies(Array.isArray(parsed) ? parsed : []);
      }
    } catch {
      setTrackedCompanies([]);
    }
  }, []);

  /**
   * Indlæser alle dashboard-data.
   * Kaldt ved mount og når tracked/storage events fyres.
   */
  const refreshData = useCallback(() => {
    setTrackedEjendomme(hentTrackedEjendomme());
    setRecentEjendomme(hentRecentEjendomme());
    refreshTrackedCompanies();

    // Seneste virksomheder fra Supabase (in-memory cache)
    setRecentCompanies(getRecentCompanies());

    // Seneste ejere fra Supabase (in-memory cache)
    setRecentPersons(getRecentPersons());
  }, [refreshTrackedCompanies]);

  /** Indlæs data ved mount og lyt efter ændringer */
  useEffect(() => {
    refreshData();

    const handler = () => refreshData();
    window.addEventListener('storage', handler);
    window.addEventListener('ba-tracked-changed', handler);
    window.addEventListener('ba-recents-updated', handler);
    return () => {
      window.removeEventListener('storage', handler);
      window.removeEventListener('ba-tracked-changed', handler);
      window.removeEventListener('ba-recents-updated', handler);
    };
  }, [refreshData]);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Beta banner — dismissible, persisted in localStorage */}
      {showBetaBanner && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <p className="flex-1 leading-snug">
            <span className="font-semibold text-amber-200">BizzAssist Beta</span>
            {' — '}Produktet er under aktiv udvikling. Der kan forekomme fejl og mangler. Del din
            feedback via 💬 knappen.
          </p>
          <button
            onClick={dismissBetaBanner}
            aria-label="Luk beta-banner"
            className="mt-0.5 shrink-0 rounded p-0.5 text-amber-400 hover:bg-amber-500/20 hover:text-amber-200 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* 2FA recommendation banner — shown to email/password users without TOTP enrolled */}
      {show2faBanner && (
        <div className="flex items-start gap-3 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-300">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-yellow-400" />
          <p className="flex-1 leading-snug">
            Vi anbefaler at aktivere to-faktor autentificering for at beskytte din konto.{' '}
            <Link
              href="/dashboard/settings/security"
              className="font-semibold underline underline-offset-2 hover:text-yellow-200 transition-colors"
            >
              Gå til Indstillinger → Sikkerhed
            </Link>{' '}
            for at sætte det op.
          </p>
          <button
            onClick={dismiss2faBanner}
            aria-label="Luk 2FA-anbefaling"
            className="mt-0.5 shrink-0 rounded p-0.5 text-yellow-400 hover:bg-yellow-500/20 hover:text-yellow-200 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Welcome */}
      <div>
        <h1 className="text-2xl font-bold text-white">{d.welcome}</h1>
        <p className="text-slate-400 mt-1">{d.welcomeSub}</p>
      </div>

      {/* Quick actions — 4 navigation cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        {[
          {
            icon: Building2,
            label: d.properties,
            href: '/dashboard/ejendomme',
            color: 'bg-emerald-500/10 text-emerald-400',
          },
          {
            icon: Briefcase,
            label: d.companies,
            href: '/dashboard/companies',
            color: 'bg-blue-500/10 text-blue-400',
          },
          {
            icon: Users,
            label: d.owners,
            href: '/dashboard/owners',
            color: 'bg-purple-500/10 text-purple-400',
          },
          {
            icon: MapPin,
            label: d.map,
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
                {action.label}
              </span>
            </Link>
          );
        })}
      </div>

      {/* Main content */}
      <div className="space-y-4">
        {/* ─── Seneste ejendomme (collapsible) ─── */}
        <CollapsibleSection
          title={d.recentProperties}
          count={recentEjendomme.length}
          titleColor="text-emerald-400"
          open={!!openSections['recent-props']}
          onToggle={() => toggle('recent-props')}
          linkHref="/dashboard/ejendomme"
          linkLabel={d.viewAll}
        >
          {recentEjendomme.length === 0 ? (
            <EmptyState
              icon={<Building2 size={24} className="mx-auto mb-2 text-slate-600" />}
              text={d.emptyProperties}
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
          title={d.recentCompanies}
          count={recentCompanies.length}
          titleColor="text-blue-400"
          open={!!openSections['recent-companies']}
          onToggle={() => toggle('recent-companies')}
          linkHref="/dashboard/companies"
          linkLabel={d.viewAll}
        >
          {recentCompanies.length === 0 ? (
            <EmptyState
              icon={<Briefcase size={24} className="mx-auto mb-2 text-slate-600" />}
              text={d.emptyCompanies}
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
          title={d.recentOwners}
          count={recentPersons.length}
          titleColor="text-purple-400"
          open={!!openSections['recent-owners']}
          onToggle={() => toggle('recent-owners')}
          linkHref="/dashboard/owners"
          linkLabel={d.viewAll}
        >
          {recentPersons.length === 0 ? (
            <EmptyState
              icon={<Users size={24} className="mx-auto mb-2 text-slate-600" />}
              text={d.emptyOwners}
            />
          ) : (
            recentPersons.map((p) => (
              <Link
                key={p.enhedsNummer}
                href={`/dashboard/owners/${p.enhedsNummer}`}
                className="group flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-slate-800/60 transition-colors"
              >
                <Users
                  size={16}
                  className="text-purple-400/70 group-hover:text-purple-300 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-200 group-hover:text-white truncate font-medium">
                    {p.name}
                  </p>
                  <p className="text-xs text-slate-500 truncate">
                    {p.antalVirksomheder} {lang === 'da' ? 'virksomheder' : 'companies'}
                  </p>
                </div>
                <ChevronRight
                  size={14}
                  className="text-slate-600 group-hover:text-slate-400 shrink-0"
                />
              </Link>
            ))
          )}
        </CollapsibleSection>

        {/* ─── Fulgte (ejendomme + virksomheder + ejere, grupperet) ─── */}
        <CollapsibleSection
          title={d.tracked}
          count={trackedEjendomme.length + trackedCompanies.length}
          titleColor="text-amber-400"
          open={!!openSections['tracked']}
          onToggle={() => toggle('tracked')}
          linkHref="/dashboard/settings"
          linkLabel={d.manage}
          badgeColor="bg-amber-500/20 text-amber-400"
        >
          {trackedEjendomme.length === 0 && trackedCompanies.length === 0 ? (
            <EmptyState
              icon={<Eye size={24} className="mx-auto mb-2 text-slate-600" />}
              text={d.emptyTracked}
            />
          ) : (
            <>
              {/* Ejendomme gruppe */}
              {trackedEjendomme.length > 0 && (
                <>
                  <div className="px-6 py-2 bg-white/3">
                    <span className="text-[11px] font-semibold text-emerald-400 uppercase tracking-wider">
                      {d.properties}
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
                      {d.companies}
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
