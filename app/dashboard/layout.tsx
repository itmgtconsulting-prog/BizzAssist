'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { signOut } from '@/app/auth/actions';
import {
  LayoutDashboard,
  Search,
  Building2,
  Briefcase,
  Users,
  Map,
  Settings,
  LogOut,
  Menu,
  X,
  MapPin,
  Navigation,
  Loader2,
  ArrowRight,
  Shield,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { erDawaId } from '@/app/lib/dawa';
import { gemRecentEjendom } from '@/app/lib/recentEjendomme';
import type { UnifiedSearchResult } from '@/app/api/search/route';
import AIChatPanel from '@/app/components/AIChatPanel';
import NotifikationsDropdown from '@/app/components/NotifikationsDropdown';
import {
  getSubscription,
  switchActiveUser,
  clearActiveSubscription,
  saveSubscription,
  registerSubscription,
  ADMIN_EMAIL,
  type UserSubscription,
} from '@/app/lib/subscriptions';
import { createClient } from '@/lib/supabase/client';
import { hasMigrated, migrateLocalStorageToSupabase } from '@/app/lib/migrateLocalStorage';

/** Navigation items — 'adminOnly' items are only shown for admin users */
const navItems = [
  {
    icon: LayoutDashboard,
    labelDa: 'Oversigt',
    labelEn: 'Overview',
    href: '/dashboard',
    adminOnly: false,
  },
  {
    icon: Building2,
    labelDa: 'Ejendomme',
    labelEn: 'Properties',
    href: '/dashboard/ejendomme',
    adminOnly: false,
  },
  {
    icon: Briefcase,
    labelDa: 'Virksomheder',
    labelEn: 'Companies',
    href: '/dashboard/companies',
    adminOnly: false,
  },
  { icon: Users, labelDa: 'Ejere', labelEn: 'Owners', href: '/dashboard/owners', adminOnly: false },
  { icon: Map, labelDa: 'Kort', labelEn: 'Map', href: '/dashboard/kort', adminOnly: false },
  {
    icon: Shield,
    labelDa: 'Admin',
    labelEn: 'Admin',
    href: '/dashboard/admin/users',
    adminOnly: true,
  },
];

/** Standard sidebarbredde i px */
const SIDEBAR_DEFAULT = 256;
/** Minimum sidebarbredde */
const SIDEBAR_MIN = 180;
/** Maximum sidebarbredde */
const SIDEBAR_MAX = 480;

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { lang, setLang } = useLanguage();
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  /** Blocks dashboard rendering until subscription check passes */
  const [accessGranted, setAccessGranted] = useState(false);
  /** Current user profile from Supabase auth */
  const [userProfile, setUserProfile] = useState<{
    name: string;
    email: string;
    initials: string;
  } | null>(null);

  /** Helper: set profile UI from email + optional name */
  const setProfile = useCallback((email: string, fullName?: string) => {
    const name = fullName || email.split('@')[0];
    const parts = name.trim().split(/\s+/);
    const initials =
      parts.length >= 2
        ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
        : name.slice(0, 2).toUpperCase();
    setUserProfile({ name, email, initials });
    setIsAdmin(email === ADMIN_EMAIL);
  }, []);

  /**
   * Detect the currently logged-in Supabase user, load their profile,
   * and check their subscription from:
   *   1. localStorage (fast, per-browser)
   *   2. Supabase app_metadata (server-side, cross-browser)
   *
   * Access gate: users without a subscription or with pending/cancelled status
   * are signed out and redirected to /login with an appropriate error message.
   */
  useEffect(() => {
    const supabase = createClient();

    /** Redirect to login if subscription check fails, or grant access. */
    const gateAccess = async (status: 'ok' | 'pending' | 'cancelled' | 'no_subscription') => {
      if (status === 'ok') {
        setAccessGranted(true);
        // Migrate localStorage data to Supabase on first authenticated access
        if (!hasMigrated()) {
          migrateLocalStorageToSupabase().catch(() => {});
        }
        return;
      }
      clearActiveSubscription();
      await supabase.auth.signOut();
      if (status === 'pending') {
        window.location.href = '/login?error=subscription_pending';
      } else if (status === 'cancelled') {
        window.location.href = '/login?error=subscription_cancelled';
      } else {
        window.location.href = '/login?error=no_subscription';
      }
    };

    /** Check subscription status — returns gate status string */
    const checkSub = (
      sub: UserSubscription | null
    ): 'ok' | 'pending' | 'cancelled' | 'no_subscription' => {
      if (!sub) return 'no_subscription';
      if (sub.status === 'pending') return 'pending';
      if (sub.status === 'cancelled') return 'cancelled';
      return 'ok';
    };

    /** Main auth + subscription check */
    const checkAccess = async () => {
      // PRIMARY: Call server-side API which uses cookies (works even when
      // client-side getUser() can't read the session).
      // The API uses the admin client to read FRESH subscription data.
      try {
        const res = await fetch('/api/subscription');
        console.log('[checkAccess] /api/subscription status:', res.status);

        if (res.ok) {
          const json = await res.json();
          console.log('[checkAccess] /api/subscription response:', JSON.stringify(json));
          const email = json.email as string | undefined;
          const serverSub = json.subscription;

          if (email) {
            setProfile(email, json.fullName || '');

            if (serverSub && serverSub.planId) {
              const sub: UserSubscription = {
                email,
                planId: serverSub.planId as UserSubscription['planId'],
                status: serverSub.status as UserSubscription['status'],
                createdAt: serverSub.createdAt,
                approvedAt: serverSub.approvedAt,
                tokensUsedThisMonth: serverSub.tokensUsedThisMonth ?? 0,
                periodStart: serverSub.periodStart,
                bonusTokens: serverSub.bonusTokens ?? 0,
              };
              saveSubscription(sub);
              registerSubscription(sub);
              console.log('[checkAccess] Server sub:', sub.status, '/', sub.planId);
              gateAccess(checkSub(sub));
              return;
            }

            // Authenticated but no subscription in Supabase — try localStorage
            const localSub = switchActiveUser(email);
            if (localSub) {
              console.log('[checkAccess] localStorage sub:', localSub.status, '/', localSub.planId);
              gateAccess(checkSub(localSub));
              return;
            }

            // No subscription anywhere
            console.log('[checkAccess] No subscription → no_subscription');
            gateAccess('no_subscription');
            return;
          }
        }

        // 401 or no email = not authenticated
        if (res.status === 401) {
          console.log('[checkAccess] Not authenticated (401)');
          window.location.href = '/login';
          return;
        }
      } catch (err) {
        console.error('[checkAccess] /api/subscription error:', err);
      }

      // FALLBACK: try client-side getUser (may work in some setups)
      try {
        const { data } = await supabase.auth.getUser();
        const email = data.user?.email;
        console.log('[checkAccess] client getUser email:', email);
        if (email) {
          setProfile(email);
          const localSub = switchActiveUser(email);
          if (localSub) {
            gateAccess(checkSub(localSub));
            return;
          }
          gateAccess('no_subscription');
          return;
        }
      } catch {
        // ignore
      }

      // Last resort: existing localStorage
      const existing = getSubscription();
      if (existing?.email) {
        setProfile(existing.email);
        gateAccess(checkSub(existing));
        return;
      }

      // No session, no data — go to login
      window.location.href = '/login';
    };

    checkAccess();
  }, [setProfile, router]);

  /** Sidebarbredde — kan trækkes af brugeren */
  const [sidebarBredde, setSidebarBredde] = useState(SIDEBAR_DEFAULT);
  const sidebarTrækStart = useRef<{ x: number; bredde: number } | null>(null);

  /** Start sidebar-resize ved mousedown på bjælken */
  const onSidebarDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      sidebarTrækStart.current = { x: e.clientX, bredde: sidebarBredde };

      const onMove = (ev: MouseEvent) => {
        if (!sidebarTrækStart.current) return;
        const delta = ev.clientX - sidebarTrækStart.current.x;
        setSidebarBredde(
          Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, sidebarTrækStart.current.bredde + delta))
        );
      };
      const onUp = () => {
        sidebarTrækStart.current = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [sidebarBredde]
  );

  // ── Global søgning ────────────────────────────────────────────────────────
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchDropdownRef = useRef<HTMLDivElement>(null);
  const [søgning, setSøgning] = useState('');
  const [resultater, setResultater] = useState<UnifiedSearchResult[]>([]);
  const [søgerDAWA, setSøgerDAWA] = useState(false);
  const [søgÅben, setSøgÅben] = useState(false);
  const [markeret, setMarkeret] = useState(-1);
  /** Cached position of the search input for portal dropdown positioning */
  const [searchRect, setSearchRect] = useState<{ top: number; left: number; width: number }>({
    top: 0,
    left: 0,
    width: 380,
  });

  /** Debounced unified search (addresses + companies + people) */
  useEffect(() => {
    const timer = setTimeout(async () => {
      if (søgning.trim().length < 2) {
        setResultater([]);
        setSøgerDAWA(false);
        return;
      }
      setSøgerDAWA(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(søgning)}`);
        const data: UnifiedSearchResult[] = res.ok ? await res.json() : [];
        setResultater(data);
      } catch {
        setResultater([]);
      }
      setSøgerDAWA(false);
    }, 250);
    return () => clearTimeout(timer);
  }, [søgning]);

  /** Luk dropdown ved klik udenfor */
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
      if (
        searchDropdownRef.current &&
        !searchDropdownRef.current.contains(e.target as Node) &&
        searchInputRef.current &&
        !searchInputRef.current.contains(e.target as Node)
      ) {
        setSøgÅben(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  /** Vælg et resultat fra dropdown — håndterer adresser, virksomheder og personer */
  const vælgResultat = useCallback(
    (result: UnifiedSearchResult) => {
      if (result.type === 'address') {
        // Road name without house number — fill search field so user can add number
        if (result.meta?.dawaType === 'vejnavn' || !erDawaId(result.id)) {
          setSøgning((result.meta?.vejnavn ?? result.title) + ' ');
          searchInputRef.current?.focus();
          return;
        }
        // Full address — save to recent and navigate
        gemRecentEjendom({
          id: result.id,
          adresse:
            `${result.meta?.vejnavn ?? ''} ${result.meta?.husnr ?? ''}`.trim() || result.title,
          postnr: result.meta?.postnr ?? '',
          by: result.meta?.postnrnavn ?? '',
          kommune: result.meta?.kommunenavn ?? '',
          anvendelse: null,
        });
      }
      setSøgning('');
      setSøgÅben(false);
      setResultater([]);
      router.push(result.href);
    },
    [router]
  );

  /* ── Access gate — block dashboard until subscription verified ── */
  if (!accessGranted) {
    return (
      <div className="flex h-screen bg-[#0a1020] items-center justify-center">
        <div className="text-center">
          <Loader2 size={28} className="mx-auto mb-3 text-blue-400 animate-spin" />
          <p className="text-slate-500 text-sm">
            {lang === 'da' ? 'Kontrollerer adgang…' : 'Checking access…'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#0a1020] overflow-hidden">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar + resize-bjælke */}
      <div
        className={`fixed lg:static inset-y-0 left-0 z-30 flex flex-row transition-transform duration-300 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
        style={{ width: sidebarBredde }}
      >
        <aside className="flex-1 bg-[#0f172a] flex flex-col overflow-hidden">
          {/* Logo */}
          <div className="flex items-center justify-between px-6 py-5 border-b border-white/10 shrink-0">
            <Link href="/" className="flex items-center gap-2 min-w-0">
              <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shrink-0">
                <span className="text-white font-bold text-sm">B</span>
              </div>
              <span className="text-white font-bold text-lg truncate">
                Bizz<span className="text-blue-400">Assist</span>
              </span>
            </Link>
            <button
              className="lg:hidden text-slate-400 hover:text-white shrink-0"
              onClick={() => setSidebarOpen(false)}
            >
              <X size={20} />
            </button>
          </div>

          {/* Navigation — shrink-0 så AI-panelet nedenfor fylder resten */}
          <nav className="shrink-0 px-4 py-6 space-y-1">
            {navItems
              .filter((item) => !item.adminOnly || isAdmin)
              .map((item) => {
                const Icon = item.icon;
                const label = lang === 'da' ? item.labelDa : item.labelEn;
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setSidebarOpen(false)}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                      active
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-400 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <Icon size={18} />
                    <span className="truncate">{label}</span>
                  </Link>
                );
              })}
          </nav>

          {/* AI Chat Panel — resizable, nederst i sidebar */}
          <AIChatPanel />
        </aside>

        {/* Resize-bjælke — kun desktop */}
        <div
          onMouseDown={onSidebarDragStart}
          className="hidden lg:flex w-1.5 cursor-col-resize items-center justify-center group hover:bg-blue-500/20 transition-colors shrink-0"
          title="Træk for at justere menubredde"
        >
          <div className="w-0.5 h-10 rounded-full bg-slate-700 group-hover:bg-blue-400 transition-colors" />
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Top bar */}
        <header className="bg-[#0f172a] border-b border-white/8 px-6 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <button
              className="lg:hidden text-slate-400 hover:text-white"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={22} />
            </button>
            {/* Global adressesøgning med DAWA autocomplete */}
            <div className="relative hidden sm:block">
              <Search
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
                size={16}
              />
              <input
                ref={searchInputRef}
                type="text"
                value={søgning}
                onChange={(e) => {
                  setSøgning(e.target.value);
                  setSøgÅben(true);
                  setMarkeret(-1);
                  const rect = searchInputRef.current?.getBoundingClientRect();
                  if (rect)
                    setSearchRect({
                      top: rect.bottom + 6,
                      left: rect.left,
                      width: Math.max(rect.width, 380),
                    });
                }}
                onFocus={() => {
                  setSøgÅben(true);
                  const rect = searchInputRef.current?.getBoundingClientRect();
                  if (rect)
                    setSearchRect({
                      top: rect.bottom + 6,
                      left: rect.left,
                      width: Math.max(rect.width, 380),
                    });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setMarkeret((m) => Math.min(m + 1, Math.min(resultater.length, 15) - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setMarkeret((m) => Math.max(m - 1, -1));
                  } else if (e.key === 'Enter') {
                    const v = markeret >= 0 ? resultater[markeret] : resultater[0];
                    if (v) vælgResultat(v);
                  } else if (e.key === 'Escape') {
                    setSøgÅben(false);
                    setSøgning('');
                  }
                }}
                placeholder={
                  lang === 'da' ? 'Søg adresse, CVR, virksomhed…' : 'Search address, CVR, company…'
                }
                className="pl-10 pr-8 py-2 bg-white/5 border border-white/10 rounded-xl text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-blue-500/60 w-80 transition-colors"
              />
              {/* Loader / ryd */}
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                {søgerDAWA ? (
                  <Loader2 size={14} className="text-blue-400 animate-spin" />
                ) : søgning.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSøgning('');
                      setResultater([]);
                      setSøgÅben(false);
                    }}
                    className="text-slate-600 hover:text-slate-300"
                  >
                    <X size={14} />
                  </button>
                ) : null}
              </div>

              {/* Dropdown via portal — unified results (addresses, companies, people) */}
              {søgÅben &&
                resultater.length > 0 &&
                typeof document !== 'undefined' &&
                createPortal(
                  <div
                    ref={searchDropdownRef}
                    style={{
                      position: 'fixed',
                      top: searchRect.top,
                      left: searchRect.left,
                      width: searchRect.width,
                      zIndex: 9999,
                    }}
                    className="bg-slate-900 border border-slate-700/60 rounded-2xl shadow-2xl overflow-hidden max-h-[70vh] overflow-y-auto"
                  >
                    {resultater.slice(0, 15).map((r, i) => {
                      /** Section header when type changes */
                      const prevType = i > 0 ? resultater[i - 1].type : null;
                      const showHeader = r.type !== prevType;
                      const sectionConfig =
                        r.type === 'company'
                          ? {
                              label: lang === 'da' ? 'Virksomheder' : 'Companies',
                              headerColor: 'text-blue-400',
                            }
                          : r.type === 'person'
                            ? {
                                label: lang === 'da' ? 'Ejere' : 'Owners',
                                headerColor: 'text-purple-400',
                              }
                            : {
                                label: lang === 'da' ? 'Adresser' : 'Addresses',
                                headerColor: 'text-emerald-400',
                              };
                      /** Icon and color per result type */
                      const iconConfig =
                        r.type === 'company'
                          ? {
                              Icon: Briefcase,
                              color: 'text-blue-400',
                              bg: 'bg-blue-600/30',
                              bgIdle: 'bg-blue-900/40',
                            }
                          : r.type === 'person'
                            ? {
                                Icon: Users,
                                color: 'text-purple-400',
                                bg: 'bg-purple-600/30',
                                bgIdle: 'bg-purple-900/40',
                              }
                            : r.meta?.dawaType === 'vejnavn'
                              ? {
                                  Icon: Navigation,
                                  color: 'text-emerald-400',
                                  bg: 'bg-emerald-600/30',
                                  bgIdle: 'bg-slate-800',
                                }
                              : {
                                  Icon: MapPin,
                                  color: 'text-emerald-400',
                                  bg: 'bg-emerald-600/30',
                                  bgIdle: 'bg-slate-800',
                                };
                      const {
                        Icon: ResultIcon,
                        color: iconColor,
                        bg: iconBgActive,
                        bgIdle: iconBgIdle,
                      } = iconConfig;

                      /** Type label prefix for subtitle */
                      const typeLabel =
                        r.type === 'company'
                          ? lang === 'da'
                            ? 'Virksomhed'
                            : 'Company'
                          : r.type === 'person'
                            ? lang === 'da'
                              ? 'Ejer'
                              : 'Owner'
                            : r.meta?.dawaType === 'vejnavn'
                              ? lang === 'da'
                                ? 'Vej'
                                : 'Road'
                              : lang === 'da'
                                ? 'Ejendom'
                                : 'Property';

                      return (
                        <div key={`${r.type}-${r.id}-${i}`}>
                          {showHeader && (
                            <div
                              className={`px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${sectionConfig.headerColor} bg-slate-800/40 border-t border-slate-700/30 first:border-t-0`}
                            >
                              {sectionConfig.label}
                            </div>
                          )}
                          <button
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              vælgResultat(r);
                            }}
                            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${i === markeret ? 'bg-blue-600/20' : 'hover:bg-slate-800/80'}`}
                          >
                            <div
                              className={`p-1.5 rounded-lg flex-shrink-0 ${i === markeret ? iconBgActive : iconBgIdle}`}
                            >
                              <ResultIcon
                                size={12}
                                className={i === markeret ? iconColor : 'text-slate-400'}
                              />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-white text-sm font-medium truncate">{r.title}</p>
                              <p className="text-slate-500 text-xs truncate">
                                {typeLabel}
                                {r.subtitle ? ` \u00b7 ${r.subtitle}` : ''}
                              </p>
                            </div>
                            <ArrowRight
                              size={12}
                              className={i === markeret ? 'text-blue-400' : 'text-slate-600'}
                            />
                          </button>
                        </div>
                      );
                    })}
                  </div>,
                  document.body
                )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Language toggle */}
            <div className="flex items-center bg-white/10 rounded-full p-1 gap-1">
              <button
                onClick={() => setLang('da')}
                className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-all ${
                  lang === 'da' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                DA
              </button>
              <button
                onClick={() => setLang('en')}
                className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-all ${
                  lang === 'en' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                EN
              </button>
            </div>
            <NotifikationsDropdown lang={lang} />
            {/* Profile dropdown */}
            <div className="relative" ref={profileRef}>
              <button
                onClick={() => setProfileOpen((o) => !o)}
                className="w-9 h-9 bg-blue-600 hover:bg-blue-500 rounded-full flex items-center justify-center text-white text-sm font-bold transition-colors"
              >
                {userProfile?.initials ?? '..'}
              </button>

              {profileOpen && (
                <div className="absolute right-0 top-11 w-52 bg-[#1e293b] border border-white/10 rounded-2xl shadow-2xl overflow-hidden z-50">
                  <div className="px-4 py-3 border-b border-white/10">
                    <p className="text-white text-sm font-medium">{userProfile?.name ?? ''}</p>
                    <p className="text-slate-500 text-xs mt-0.5 truncate">
                      {userProfile?.email ?? ''}
                    </p>
                  </div>
                  <div className="py-1.5">
                    <Link
                      href="/dashboard/settings"
                      onClick={() => setProfileOpen(false)}
                      className="flex items-center gap-3 px-4 py-2.5 text-sm text-slate-300 hover:text-white hover:bg-white/5 transition-colors"
                    >
                      <Settings size={15} />
                      {lang === 'da' ? 'Indstillinger' : 'Settings'}
                    </Link>
                  </div>
                  <div className="py-1.5 border-t border-white/10">
                    <button
                      onClick={() => {
                        clearActiveSubscription();
                        signOut();
                      }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/5 transition-colors"
                    >
                      <LogOut size={15} />
                      {lang === 'da' ? 'Log ud' : 'Log out'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Page content — flex container så children strækker til fuld højde uden h-full */}
        <main className="flex-1 flex overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
