'use client';

import { useState, useRef, useEffect, useCallback, useTransition } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { signOut, selectFreePlan } from '@/app/auth/actions';
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
  MessageSquare,
  Loader2,
  ArrowRight,
  Shield,
  Lock,
  CheckCircle2,
  Zap,
  Clock,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  BarChart2,
  Sparkles,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';
import { erDawaId } from '@/app/lib/dawa';
import { gemRecentEjendom } from '@/app/lib/recentEjendomme';
import { getRecentSearches, saveRecentSearch, type RecentSearch } from '@/app/lib/recentSearches';
import type { UnifiedSearchResult } from '@/app/api/search/route';
import AIChatPanel from '@/app/components/AIChatPanel';
import ErrorBoundary from '@/app/components/ErrorBoundary';
import NotifikationsDropdown from '@/app/components/NotifikationsDropdown';
import RecentEntityTagBar from '@/app/components/RecentEntityTagBar';
import SessionTimeoutWarning from '@/app/components/SessionTimeoutWarning';
import { useSessionTimeout } from '@/app/hooks/useSessionTimeout';
import OnboardingModal from '@/app/components/OnboardingModal';
import FeedbackButton from '@/app/components/FeedbackButton';
import SubscriptionGate from '@/app/components/SubscriptionGate';
import { companyInfo } from '@/app/lib/companyInfo';
import { cachePlans, type UserSubscription, type PlanDef } from '@/app/lib/subscriptions';
import { SubscriptionProvider, useSubscription } from '@/app/context/SubscriptionContext';
import { AIPageProvider } from '@/app/context/AIPageContext';
import { AIChatContextProvider, useAIChatContext } from '@/app/context/AIChatContext';
import { createClient } from '@/lib/supabase/client';
import { hasMigrated, migrateLocalStorageToSupabase } from '@/app/lib/migrateLocalStorage';
import { initCacheUserId, clearCacheUserId } from '@/app/lib/trackedEjendomme';
import TopProgressBar from '@/app/components/TopProgressBar';
import { logger } from '@/app/lib/logger';

/**
 * BIZZ-236: AI features are now gated by subscription plan (aiEnabled flag)
 * instead of NEXT_PUBLIC_AI_ENABLED env var. The nav items are always visible;
 * SubscriptionGate in AIChatPanel and ChatPageClient handles access control.
 */

/** Navigation items — 'adminOnly' items are only shown for admin users.
 *  'key' maps to translations[lang].sidebar[key] for the label.
 */
const navItems = [
  { icon: LayoutDashboard, key: 'overview' as const, href: '/dashboard', adminOnly: false },
  { icon: Search, key: 'search' as const, href: '/dashboard/search', adminOnly: false },
  { icon: Building2, key: 'properties' as const, href: '/dashboard/ejendomme', adminOnly: false },
  { icon: Briefcase, key: 'companies' as const, href: '/dashboard/companies', adminOnly: false },
  { icon: Users, key: 'owners' as const, href: '/dashboard/owners', adminOnly: false },
  { icon: Map, key: 'map' as const, href: '/dashboard/kort', adminOnly: false },
  // BIZZ-341: AI Analyse only visible in dev/test — not ready for production
  ...(process.env.NEXT_PUBLIC_APP_URL?.includes('test.bizzassist.dk') ||
  process.env.NODE_ENV === 'development'
    ? [{ icon: BarChart2, key: 'analysis' as const, href: '/dashboard/analysis', adminOnly: false }]
    : []),
  { icon: MessageSquare, key: 'chat' as const, href: '/dashboard/chat', adminOnly: false },
  { icon: Shield, key: 'admin' as const, href: '/dashboard/admin/users', adminOnly: true },
];

/** Standard sidebarbredde i px */
const SIDEBAR_DEFAULT = 256;
/** Minimum sidebarbredde */
const SIDEBAR_MIN = 180;
/** Maximum sidebarbredde */
const SIDEBAR_MAX = 480;
/** Bredde når sidebar er foldet ind (ikoner only) */
const SIDEBAR_COLLAPSED = 56;

/**
 * Outer wrapper that provides SubscriptionContext to the entire dashboard.
 * Delegates all rendering to DashboardLayoutInner.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <SubscriptionProvider>
      <AIPageProvider>
        <AIChatContextProvider>
          <DashboardLayoutInner>{children}</DashboardLayoutInner>
        </AIChatContextProvider>
      </AIPageProvider>
    </SubscriptionProvider>
  );
}

function DashboardLayoutInner({ children }: { children: React.ReactNode }) {
  const { lang, setLang } = useLanguage();
  const t = translations[lang];
  const s = t.sidebar;
  const pathname = usePathname();
  const router = useRouter();
  const chatCtx = useAIChatContext();
  const [isPending, startTransition] = useTransition();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** Om sidebar er foldet ind til ikoner-only (desktop) */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  /** Blocks dashboard rendering until subscription check passes */
  const [accessGranted, setAccessGranted] = useState(false);
  /** Whether user has an active paid subscription (gates search + AI) */
  const [_hasActiveSub, setHasActiveSub] = useState(false);
  /** Whether to show the 2FA setup recommendation banner */
  const [show2FaBanner, setShow2FaBanner] = useState(false);
  /** Whether the subscription is functional (paid, free, or within trial) — gates features */
  const [isFunctional, setIsFunctional] = useState(false);
  /**
   * Controls which overlay (if any) is shown over the dashboard.
   * 'select_plan'       → user has no subscription at all
   * 'pending_approval'  → user chose a plan requiring admin approval (status: pending)
   * null                → no overlay, full access
   */
  const [overlayMode, setOverlayMode] = useState<'select_plan' | 'pending_approval' | null>(null);
  /** Current user profile from Supabase auth */
  const [userProfile, setUserProfile] = useState<{
    name: string;
    email: string;
    initials: string;
  } | null>(null);

  /** Subscription context — replaces localStorage for subscription state */
  const { initialize: initSub } = useSubscription();

  // Session timeout — tracks idle + absolute timeout, shows warning modal.
  // Only active once access is granted (user is authenticated in the dashboard).
  const {
    showWarning: showSessionWarning,
    secondsLeft,
    extendSession,
  } = useSessionTimeout({
    onTimeout: async () => {
      clearCacheUserId();
      await signOut();
    },
  });

  /** Helper: set profile UI from email + optional name */
  const setProfile = useCallback((email: string, fullName?: string) => {
    const name = fullName || email.split('@')[0];
    const parts = name.trim().split(/\s+/);
    const initials =
      parts.length >= 2
        ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
        : name.slice(0, 2).toUpperCase();
    setUserProfile({ name, email, initials });
    // Admin status is set from server response (app_metadata.isAdmin) in checkAccess
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
    const gateAccess = async (
      status: 'ok' | 'pending' | 'cancelled' | 'no_subscription',
      functional = true,
      sub: UserSubscription | null = null,
      admin = false
    ) => {
      // ── Onboarding gate ──────────────────────────────────────────────────────
      // Before granting any dashboard access, check whether the user has completed
      // the onboarding wizard. Admins bypass this check so they can always access
      // the dashboard (they were provisioned without going through onboarding).
      if (!admin && status !== 'cancelled') {
        try {
          const {
            data: { user: currentUser },
          } = await supabase.auth.getUser();
          if (currentUser && currentUser.user_metadata?.onboarding_complete !== true) {
            window.location.href = '/onboarding';
            return;
          }
        } catch {
          // If check fails, let user through — onboarding page guards itself
        }
      }

      if (status === 'ok') {
        setAccessGranted(true);
        setHasActiveSub(true);
        setIsFunctional(functional);
        // Initialize subscription context (replaces localStorage)
        initSub({ subscription: sub, isAdmin: admin, isFunctional: functional });
        // Migrate localStorage data to Supabase on first authenticated access
        if (!hasMigrated()) {
          migrateLocalStorageToSupabase().catch(() => {});
        }
        return;
      }
      // Users without a plan are let into the dashboard but shown a plan-selection overlay
      if (status === 'no_subscription') {
        setAccessGranted(true);
        setHasActiveSub(false);
        setIsFunctional(false);
        setOverlayMode('select_plan');
        initSub({ subscription: null, isAdmin: admin, isFunctional: false });
        return;
      }
      // Pending demo users are let into the dashboard but shown an "awaiting approval" overlay
      if (status === 'pending') {
        setAccessGranted(true);
        setHasActiveSub(false);
        setIsFunctional(false);
        setOverlayMode('pending_approval');
        initSub({ subscription: sub, isAdmin: admin, isFunctional: false });
        return;
      }
      clearCacheUserId();
      await supabase.auth.signOut();
      if (status === 'cancelled') {
        window.location.href = '/login?error=subscription_cancelled';
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

    /** Main auth + subscription check — retries up to 3× on transient network errors */
    const checkAccess = async (attempt = 0) => {
      // PRIMARY: Call server-side API which uses cookies (works even when
      // client-side getUser() can't read the session).
      // The API uses the admin client to read FRESH subscription data.
      try {
        const res = await fetch('/api/subscription');
        logger.log('[checkAccess] /api/subscription status:', res.status);

        if (res.ok) {
          const json = await res.json();
          logger.log('[checkAccess] /api/subscription response:', JSON.stringify(json));
          const email = json.email as string | undefined;
          const serverSub = json.subscription;

          if (email) {
            setProfile(email, json.fullName || '');

            // BIZZ-180: Namespace localStorage cache keys with the user's ID
            // to prevent cross-user data leaks on shared devices.
            try {
              const {
                data: { user: authUser },
              } = await supabase.auth.getUser();
              if (authUser?.id) {
                initCacheUserId(authUser.id);
              }
            } catch {
              // If we can't get the user ID, localStorage caching is simply skipped
            }

            // Show 2FA banner for email/password users who haven't set up TOTP yet.
            // OAuth users (Microsoft/Google) are excluded — they have 2FA at their IdP.
            const dismissed2Fa = sessionStorage.getItem('bizzassist_2fa_banner_dismissed');
            if (!dismissed2Fa && json.isEmailUser && !json.hasMfa) {
              setShow2FaBanner(true);
            }

            // Admin users bypass all subscription gates
            if (json.isAdmin) {
              setIsAdmin(true);
            }

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
                isPaid: serverSub.isPaid ?? false,
              };
              logger.log(
                '[checkAccess] Server sub:',
                sub.status,
                '/',
                sub.planId,
                '/ isFunctional:',
                json.isFunctional,
                '/ isAdmin:',
                json.isAdmin
              );
              // Admin users always have functional access; otherwise use server-computed flag
              const functional = json.isAdmin ? true : (json.isFunctional ?? true);
              gateAccess(checkSub(sub), functional, sub, !!json.isAdmin);
              return;
            }

            // No subscription in Supabase — but admins still get access
            if (json.isAdmin) {
              logger.log('[checkAccess] No subscription but isAdmin → granting access');
              gateAccess('ok', true, null, true);
            } else {
              logger.log('[checkAccess] No subscription → no_subscription');
              gateAccess('no_subscription');
            }
            return;
          }
        }

        // 401 or no email = not authenticated
        if (res.status === 401) {
          logger.log('[checkAccess] Not authenticated (401)');
          window.location.href = '/login';
          return;
        }
      } catch (err) {
        // Transient network error (e.g. dev server restarting, stale Turbopack cache).
        // Retry up to 3 times with increasing delay instead of redirecting to /login.
        logger.warn('[checkAccess] /api/subscription network error (attempt', attempt, '):', err);
        if (attempt < 3) {
          const delay = (attempt + 1) * 1500;
          logger.log('[checkAccess] Retrying in', delay, 'ms...');
          setTimeout(() => checkAccess(attempt + 1), delay);
          return;
        }
        logger.error('[checkAccess] All retries exhausted:', err);
      }

      // FALLBACK: try client-side getUser (may work in some setups)
      try {
        const { data } = await supabase.auth.getUser();
        const email = data.user?.email;
        logger.log('[checkAccess] client getUser email: [redacted]');
        if (email) {
          // BIZZ-180: Namespace localStorage cache keys with user ID
          if (data.user?.id) initCacheUserId(data.user.id);
          setProfile(email);
          gateAccess('no_subscription');
          return;
        }
      } catch {
        // ignore
      }

      // No session, no data — go to login
      window.location.href = '/login';
    };

    checkAccess();
  }, [setProfile, router, initSub]);

  /** Fetch plan definitions from DB and populate the plan cache */
  useEffect(() => {
    if (!accessGranted) return;
    fetch('/api/plans')
      .then((res) => (res.ok ? res.json() : []))
      .then((plans: PlanDef[]) => {
        if (Array.isArray(plans) && plans.length > 0) cachePlans(plans);
      })
      .catch(() => {});
  }, [accessGranted]);

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
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);
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
      // Save to recent searches
      saveRecentSearch({
        query: søgning,
        ts: Date.now(),
        resultType: result.type as RecentSearch['resultType'],
        resultTitle: result.title,
        resultHref: result.href,
      });

      // Save company/person to type-specific recents (properties handled by gemRecentEjendom above)
      if (result.type === 'company') {
        fetch('/api/recents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entity_type: 'company',
            entity_id: result.id,
            display_name: result.title,
            entity_data: {
              industry: result.meta?.industry ?? null,
              city: result.meta?.city ?? null,
            },
          }),
        })
          .then(() => window.dispatchEvent(new Event('ba-recents-updated')))
          .catch(() => {});
      } else if (result.type === 'person') {
        fetch('/api/recents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entity_type: 'person',
            entity_id: result.id,
            display_name: result.title,
            entity_data: { subtitle: result.subtitle ?? null },
          }),
        })
          .then(() => window.dispatchEvent(new Event('ba-recents-updated')))
          .catch(() => {});
      }

      setSøgning('');
      setSøgÅben(false);
      setResultater([]);
      router.push(result.href);
    },
    [router, søgning]
  );

  /* ── Access gate — block dashboard until subscription verified ── */
  if (!accessGranted) {
    return (
      <div className="flex h-screen bg-[#0a1020] items-center justify-center">
        <div className="text-center">
          <Loader2 size={28} className="mx-auto mb-3 text-blue-400 animate-spin" />
          <p className="text-slate-400 text-sm">{t.dashboard.checkingAccess}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#0a1020] overflow-hidden">
      {/* Top progress bar — shown during route transitions */}
      <TopProgressBar />

      {/* Skip navigation for keyboard users */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-blue-600 focus:text-white focus:rounded-lg focus:outline-none"
      >
        Spring til hovedindhold
      </a>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar + resize-bjælke */}
      <div
        className={`fixed lg:static inset-y-0 left-0 z-30 flex flex-row transition-all duration-300 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
        style={{ width: sidebarCollapsed ? SIDEBAR_COLLAPSED : sidebarBredde }}
      >
        <aside className="flex-1 bg-[#0f172a] flex flex-col overflow-hidden">
          {/* Logo + collapse-knap */}
          <div
            className={`flex items-center border-b border-white/10 shrink-0 ${sidebarCollapsed ? 'justify-center px-0 py-5' : 'justify-between px-6 py-5'}`}
          >
            {!sidebarCollapsed && (
              <Link href="/" className="flex items-center gap-2 min-w-0">
                <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shrink-0">
                  <span className="text-white font-bold text-sm">B</span>
                </div>
                <span className="text-white font-bold text-lg truncate">
                  Bizz<span className="text-blue-400">Assist</span>
                </span>
              </Link>
            )}
            {sidebarCollapsed && (
              <Link
                href="/"
                className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shrink-0"
              >
                <span className="text-white font-bold text-sm">B</span>
              </Link>
            )}
            <div className="flex items-center gap-1 shrink-0">
              {/* Collapse-toggle — kun desktop */}
              <button
                className="hidden lg:flex text-slate-500 hover:text-white p-1 rounded-lg hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                onClick={() => setSidebarCollapsed((c) => !c)}
                aria-label={sidebarCollapsed ? 'Udvid sidebar' : 'Fold sidebar sammen'}
                title={sidebarCollapsed ? 'Udvid' : 'Fold sammen'}
              >
                {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
              </button>
              {/* Luk-knap — kun mobil */}
              <button
                className="lg:hidden text-slate-400 hover:text-white shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-lg"
                onClick={() => setSidebarOpen(false)}
                aria-label="Luk navigationsmenu"
              >
                <X size={20} />
              </button>
            </div>
          </div>

          {/* Navigation — shrink-0 så AI-panelet nedenfor fylder resten */}
          <nav className={`shrink-0 py-6 space-y-1 ${sidebarCollapsed ? 'px-2' : 'px-4'}`}>
            {navItems
              .filter((item) => !item.adminOnly || isAdmin)
              .map((item) => {
                const Icon = item.icon;
                const label = s[item.key];
                const active = pathname === item.href;
                /** Only overview and admin are accessible without a functional subscription */
                const requiresFunctional =
                  item.href !== '/dashboard' && !item.href.startsWith('/dashboard/admin');
                const locked = requiresFunctional && !isFunctional;
                return (
                  <Link
                    key={item.href}
                    href={locked ? '/dashboard/settings?tab=abonnement' : item.href}
                    prefetch={false}
                    onClick={(e) => {
                      setSidebarOpen(false);
                      // Brug startTransition for at lade React afbryde tung rendering
                      if (!locked) {
                        e.preventDefault();
                        startTransition(() => {
                          router.push(locked ? '/dashboard/settings' : item.href);
                        });
                      }
                    }}
                    title={sidebarCollapsed ? label : undefined}
                    className={`flex items-center rounded-xl text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${sidebarCollapsed ? 'justify-center px-0 py-3' : 'gap-3 px-4 py-3'} ${
                      locked
                        ? 'text-slate-600 cursor-not-allowed'
                        : active
                          ? 'bg-blue-600 text-white'
                          : isPending && item.href !== pathname
                            ? 'text-blue-300 bg-blue-600/10'
                            : 'text-slate-400 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <Icon size={18} className={locked ? 'opacity-40' : ''} />
                    {!sidebarCollapsed && <span className="truncate">{label}</span>}
                    {!sidebarCollapsed && locked && (
                      <Lock size={12} className="ml-auto text-slate-600" />
                    )}
                  </Link>
                );
              })}
          </nav>

          {/* AI Chat panel moved to topbar drawer — see AIChatDrawer below */}
        </aside>

        {/* Resize-bjælke — kun desktop */}
        <div
          onMouseDown={onSidebarDragStart}
          className="hidden lg:flex w-1.5 cursor-col-resize items-center justify-center group hover:bg-blue-500/20 transition-colors shrink-0"
          title={s.resizeHandle}
        >
          <div className="w-0.5 h-10 rounded-full bg-slate-700 group-hover:bg-blue-400 transition-colors" />
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Top bar */}
        <header className="relative z-10 bg-[#0f172a] border-b border-white/8 px-3 sm:px-6 py-4 flex items-center gap-4 shrink-0">
          <div className="flex items-center gap-4">
            <button
              className="lg:hidden text-slate-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-lg"
              onClick={() => setSidebarOpen(true)}
              aria-label="Åbn navigationsmenu"
            >
              <Menu size={22} />
            </button>
            {/* Global adressesøgning med DAWA autocomplete — disabled without active subscription */}
            <div className="relative hidden sm:block">
              <Search
                className={`absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none ${isFunctional ? 'text-slate-500' : 'text-slate-700'}`}
                size={16}
              />
              <input
                ref={searchInputRef}
                type="text"
                value={søgning}
                disabled={!isFunctional}
                onChange={(e) => {
                  setSøgning(e.target.value);
                  setSøgÅben(true);
                  setMarkeret(-1);
                  const rect = searchInputRef.current?.getBoundingClientRect();
                  if (rect)
                    setSearchRect({
                      top: rect.bottom + 6,
                      left: rect.left,
                      width: Math.max(rect.width, 520),
                    });
                }}
                onFocus={() => {
                  setSøgÅben(true);
                  setRecentSearches(getRecentSearches());
                  const rect = searchInputRef.current?.getBoundingClientRect();
                  if (rect)
                    setSearchRect({
                      top: rect.bottom + 6,
                      left: rect.left,
                      width: Math.max(rect.width, 520),
                    });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setMarkeret((m) => Math.min(m + 1, Math.min(resultater.length, 24) - 1)); // max 24 = 8 per category
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
                  isFunctional
                    ? s.searchPlaceholder
                    : lang === 'da'
                      ? 'Søgning kræver betalt abonnement'
                      : 'Search requires paid subscription'
                }
                className={`pl-10 pr-8 py-2 border rounded-xl text-sm focus:outline-none w-80 transition-colors ${
                  isFunctional
                    ? 'bg-white/5 border-white/10 text-slate-300 placeholder-slate-600 focus:border-blue-500/60'
                    : 'bg-white/3 border-white/5 text-slate-600 placeholder-slate-700 cursor-not-allowed'
                }`}
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
                    aria-label="Ryd søgning"
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
                    className="bg-slate-900 border border-slate-700/60 rounded-2xl shadow-2xl overflow-hidden max-h-[88vh] overflow-y-auto"
                  >
                    {/* Group results by type — max 8 per category */}
                    {(() => {
                      const adresser = resultater.filter((r) => r.type === 'address').slice(0, 8);
                      const virksomheder = resultater
                        .filter((r) => r.type === 'company')
                        .slice(0, 8);
                      const personer = resultater.filter((r) => r.type === 'person').slice(0, 8);
                      /** Flat list for keyboard navigation index */
                      const flat = [...adresser, ...virksomheder, ...personer];

                      const sections: {
                        key: string;
                        label: string;
                        headerColor: string;
                        items: UnifiedSearchResult[];
                      }[] = [];
                      if (adresser.length > 0)
                        sections.push({
                          key: 'addr',
                          label: s.sectionAddresses,
                          headerColor: 'text-emerald-400',
                          items: adresser,
                        });
                      if (virksomheder.length > 0)
                        sections.push({
                          key: 'comp',
                          label: s.sectionCompanies,
                          headerColor: 'text-blue-400',
                          items: virksomheder,
                        });
                      if (personer.length > 0)
                        sections.push({
                          key: 'pers',
                          label: s.sectionOwners,
                          headerColor: 'text-purple-400',
                          items: personer,
                        });

                      let globalIdx = 0;

                      return sections.map((sec, si) => (
                        <div key={sec.key}>
                          <div
                            className={`px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${sec.headerColor} bg-slate-800/40 ${si > 0 ? 'border-t border-slate-700/30' : ''}`}
                          >
                            {sec.label}
                          </div>
                          {sec.items.map((r) => {
                            const idx = globalIdx++;
                            const isActive = idx === markeret;

                            /** Type-specific hover/active colors */
                            const hoverBg =
                              r.type === 'company'
                                ? 'hover:bg-blue-600/10'
                                : r.type === 'person'
                                  ? 'hover:bg-purple-600/10'
                                  : 'hover:bg-emerald-600/10';
                            const activeBg =
                              r.type === 'company'
                                ? 'bg-blue-600/20'
                                : r.type === 'person'
                                  ? 'bg-purple-600/20'
                                  : 'bg-emerald-600/10';
                            const accentColor =
                              r.type === 'company'
                                ? 'text-blue-400'
                                : r.type === 'person'
                                  ? 'text-purple-400'
                                  : 'text-emerald-400';
                            const iconBgActive =
                              r.type === 'company'
                                ? 'bg-blue-600/30'
                                : r.type === 'person'
                                  ? 'bg-purple-600/30'
                                  : 'bg-emerald-600/30';
                            const arrowIdle =
                              r.type === 'company'
                                ? 'text-slate-600 group-hover:text-blue-400'
                                : r.type === 'person'
                                  ? 'text-slate-600 group-hover:text-purple-400'
                                  : 'text-slate-600 group-hover:text-emerald-400';

                            /** Icon per type */
                            const ResultIcon =
                              r.type === 'company'
                                ? Briefcase
                                : r.type === 'person'
                                  ? Users
                                  : r.meta?.dawaType === 'vejnavn'
                                    ? Navigation
                                    : MapPin;

                            return (
                              <button
                                key={`${r.type}-${r.id}-${idx}`}
                                type="button"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  vælgResultat(flat[idx]);
                                }}
                                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors group ${isActive ? activeBg : hoverBg}`}
                              >
                                <div
                                  className={`p-1 rounded-md flex-shrink-0 transition-colors ${isActive ? iconBgActive : iconBgActive.replace('/30', '/15')}`}
                                >
                                  <ResultIcon size={11} className={accentColor} />
                                </div>
                                <div className="flex-1 min-w-0">
                                  {r.type === 'company' ? (
                                    <>
                                      <div className="flex items-center gap-1.5">
                                        <p className="text-white text-xs font-medium truncate">
                                          {r.title}
                                        </p>
                                        {r.meta?.active && (
                                          <span
                                            className={`inline-flex items-center px-1 py-0 rounded text-[8px] font-medium flex-shrink-0 ${r.meta.active === 'true' ? 'bg-emerald-600/20 text-emerald-400' : 'bg-red-600/20 text-red-400'}`}
                                          >
                                            {r.meta.active === 'true'
                                              ? lang === 'da'
                                                ? 'Aktiv'
                                                : 'Active'
                                              : lang === 'da'
                                                ? 'Ophørt'
                                                : 'Inactive'}
                                          </span>
                                        )}
                                      </div>
                                      <p className="text-slate-400 text-[10px] truncate">
                                        CVR {r.id}
                                        {r.meta?.industry ? ` \u00b7 ${r.meta.industry}` : ''}
                                        {r.meta?.city ? ` \u00b7 ${r.meta.city}` : ''}
                                      </p>
                                    </>
                                  ) : r.type === 'person' ? (
                                    <>
                                      <p className="text-white text-xs font-medium truncate">
                                        {r.title}
                                      </p>
                                      {r.subtitle && (
                                        <p className="text-slate-400 text-[10px] truncate">
                                          {r.subtitle}
                                        </p>
                                      )}
                                    </>
                                  ) : (
                                    <>
                                      <p className="text-white text-xs font-medium truncate">
                                        {r.title}
                                      </p>
                                      <p className="text-slate-400 text-[10px] truncate">
                                        {r.meta?.dawaType === 'vejnavn'
                                          ? s.typeRoad
                                          : s.typeProperty}
                                        {r.subtitle ? ` \u00b7 ${r.subtitle}` : ''}
                                      </p>
                                    </>
                                  )}
                                </div>
                                <ArrowRight
                                  size={11}
                                  className={isActive ? accentColor : arrowIdle}
                                />
                              </button>
                            );
                          })}
                        </div>
                      ));
                    })()}
                  </div>,
                  document.body
                )}

              {/* Recent searches — shown when focused with empty search and no results */}
              {søgÅben &&
                resultater.length === 0 &&
                søgning.trim().length < 2 &&
                recentSearches.length > 0 &&
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
                    className="bg-slate-900 border border-slate-700/60 rounded-2xl shadow-2xl overflow-hidden max-h-[50vh] overflow-y-auto"
                  >
                    <div className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 bg-slate-800/40">
                      {lang === 'da' ? 'Seneste søgninger' : 'Recent searches'}
                    </div>
                    {recentSearches.slice(0, 6).map((rs, i) => (
                      <button
                        key={i}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          if (rs.resultHref) {
                            setSøgning('');
                            setSøgÅben(false);
                            router.push(rs.resultHref);
                          } else {
                            setSøgning(rs.query);
                          }
                        }}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-800/80 transition-colors"
                      >
                        <Search size={12} className="text-slate-600 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-slate-300 truncate">
                            {rs.resultTitle ?? rs.query}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>,
                  document.body
                )}
            </div>
          </div>
          {/* Recent entity tags — direkte til højre for søgefeltet — hidden on mobile */}
          <div className="hidden sm:contents">
            <RecentEntityTagBar currentPath={pathname} variant="inline" />
          </div>
          {/* Spacer — skubber DA/EN til højre */}
          <div className="flex-1" />
          <div className="flex items-center gap-3 flex-shrink-0">
            {/* Language toggle */}
            <div className="flex items-center bg-white/10 rounded-full p-1 gap-1">
              <button
                onClick={() => setLang('da')}
                aria-label="Vælg dansk"
                aria-pressed={lang === 'da'}
                className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  lang === 'da' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                DA
              </button>
              <button
                onClick={() => setLang('en')}
                aria-label="Select English"
                aria-pressed={lang === 'en'}
                className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  lang === 'en' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                EN
              </button>
            </div>
            <NotifikationsDropdown lang={lang} />

            {/* AI Chat button — always visible in topbar */}
            <button
              onClick={() => {
                if (pathname === '/dashboard/chat') {
                  // Already on full-page chat — no drawer needed
                } else {
                  chatCtx.setDrawerOpen(!chatCtx.drawerOpen);
                }
              }}
              className={`relative flex items-center gap-1.5 text-sm font-medium transition-colors px-3 py-1.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                pathname === '/dashboard/chat' || chatCtx.drawerOpen
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}
              aria-label="AI Chat"
              title="AI Chat"
            >
              <Sparkles size={14} />
              <span className="hidden sm:inline">AI Chat</span>
            </button>

            {/* Profile dropdown */}
            <div className="relative" ref={profileRef}>
              <button
                onClick={() => setProfileOpen((o) => !o)}
                aria-label={userProfile ? `Brugermenu for ${userProfile.name}` : 'Brugermenu'}
                aria-expanded={profileOpen}
                className="w-9 h-9 bg-blue-600 hover:bg-blue-500 rounded-full flex items-center justify-center text-white text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0f172a]"
              >
                {userProfile?.initials ?? '..'}
              </button>

              {profileOpen && (
                <div className="absolute right-0 top-11 w-52 bg-[#1e293b] border border-white/10 rounded-2xl shadow-2xl overflow-hidden z-50">
                  <div className="px-4 py-3 border-b border-white/10">
                    <p className="text-white text-sm font-medium">{userProfile?.name ?? ''}</p>
                    <p className="text-slate-400 text-xs mt-0.5 truncate">
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
                      {s.settings}
                    </Link>
                  </div>
                  <div className="py-1.5 border-t border-white/10">
                    <button
                      onClick={async () => {
                        clearCacheUserId();
                        await signOut();
                      }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/5 transition-colors"
                    >
                      <LogOut size={15} />
                      {s.logOut}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* 2FA recommendation banner — only for email/password users without TOTP */}
        {show2FaBanner && (
          <div className="relative z-0 flex items-center justify-between gap-3 bg-amber-500/10 border-b border-amber-500/30 px-4 py-2.5 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <AlertCircle size={15} className="text-amber-400 shrink-0" />
              <p className="text-amber-300 text-sm truncate">
                {lang === 'da'
                  ? 'Din konto er ikke beskyttet med to-faktor-godkendelse (2FA). '
                  : 'Your account is not protected with two-factor authentication (2FA). '}
                <a
                  href="/login/mfa/enroll"
                  className="underline font-medium hover:text-amber-200 transition-colors"
                >
                  {lang === 'da' ? 'Opsæt 2FA nu' : 'Set up 2FA now'}
                </a>
              </p>
            </div>
            <button
              onClick={() => {
                sessionStorage.setItem('bizzassist_2fa_banner_dismissed', '1');
                setShow2FaBanner(false);
              }}
              className="text-amber-500 hover:text-amber-300 text-lg leading-none shrink-0 transition-colors"
              aria-label="Luk"
            >
              ×
            </button>
          </div>
        )}

        {/* Page content — gated by subscription for non-free pages */}
        <main id="main-content" className="relative z-0 flex-1 flex overflow-y-auto">
          {pathname === '/dashboard' ||
          pathname.startsWith('/dashboard/settings') ||
          pathname.startsWith('/dashboard/admin') ||
          pathname === '/dashboard/tokens' ? (
            children
          ) : (
            <SubscriptionGate isFunctional={isFunctional}>{children}</SubscriptionGate>
          )}
        </main>
      </div>

      {/* ── AI Chat Drawer (slide-in from right) ─────────────────────────
           Always mounted so streaming survives navigation to /dashboard/chat.
           Hidden via translate-x-full + pointer-events-none when closed or on chat page. */}
      {/* Backdrop (mobile only, visible only when drawer is open and not on chat page) */}
      {chatCtx.drawerOpen && pathname !== '/dashboard/chat' && (
        <div
          className="fixed inset-0 z-40 bg-black/30 sm:hidden"
          onClick={() => chatCtx.setDrawerOpen(false)}
          role="presentation"
        />
      )}
      {/* Drawer panel — never unmounted, only visually hidden */}
      <div
        className={`fixed top-0 right-0 h-full z-40 w-full sm:w-[420px] bg-[#0f172a] border-l border-white/10 shadow-2xl flex flex-col transform transition-transform duration-300 ease-in-out ${
          chatCtx.drawerOpen && pathname !== '/dashboard/chat'
            ? 'translate-x-0'
            : 'translate-x-full pointer-events-none'
        }`}
        aria-hidden={!chatCtx.drawerOpen || pathname === '/dashboard/chat'}
      >
        <ErrorBoundary
          lang={lang}
          fallback={
            <div className="p-4 text-center">
              <p className="text-sm text-slate-400 mb-3">Chat er midlertidigt utilgængelig</p>
              <button
                onClick={() => window.location.reload()}
                className="text-xs text-blue-400 hover:text-blue-300 border border-slate-700 rounded-lg px-3 py-1.5 transition-colors"
              >
                Prøv igen
              </button>
            </div>
          }
        >
          <AIChatPanel />
        </ErrorBoundary>
      </div>

      {/* Plan-selection / pending-approval overlay — shown based on subscription state */}
      {overlayMode && <PlanSelectionOverlay lang={lang} mode={overlayMode} />}

      {/* Onboarding modal — shown once for new users */}
      <OnboardingModal />

      {/* Session timeout warning — vises 5 min. inden idle-logout */}
      <SessionTimeoutWarning
        show={showSessionWarning}
        secondsLeft={secondsLeft}
        onExtend={extendSession}
        onTimeout={async () => {
          clearCacheUserId();
          await signOut();
        }}
      />

      {/* Floating feedback button — always visible for beta users */}
      <FeedbackButton />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan colour helpers (mirrors select-plan/page.tsx)
// ---------------------------------------------------------------------------
const OVERLAY_PLAN_COLORS: Record<string, { border: string; ring: string; badge: string }> = {
  amber: {
    border: 'border-amber-500/40',
    ring: 'ring-amber-500/30',
    badge: 'text-amber-400 bg-amber-500/10',
  },
  slate: {
    border: 'border-slate-400/40',
    ring: 'ring-slate-400/30',
    badge: 'text-slate-400 bg-slate-500/10',
  },
  blue: {
    border: 'border-blue-500/40',
    ring: 'ring-blue-500/30',
    badge: 'text-blue-400 bg-blue-500/10',
  },
  purple: {
    border: 'border-purple-500/40',
    ring: 'ring-purple-500/30',
    badge: 'text-purple-400 bg-purple-500/10',
  },
};

interface OverlayPlanOption {
  id: string;
  nameDa: string;
  nameEn: string;
  priceDkk: number;
  aiTokensPerMonth: number;
  aiEnabled: boolean;
  requiresApproval: boolean;
  freeTrialDays: number;
  color: string;
  stripePriceId?: string | null;
}

/**
 * PlanSelectionOverlay — fullscreen modal shown to authenticated users who cannot yet access the dashboard.
 * Cannot be closed; presents either plan selection or a "pending approval" waiting screen.
 *
 * @param lang  - Current UI language ('da' | 'en')
 * @param mode  - 'select_plan' shows plan cards; 'pending_approval' shows waiting message
 */
function PlanSelectionOverlay({
  lang,
  mode,
}: {
  lang: 'da' | 'en';
  mode: 'select_plan' | 'pending_approval';
}) {
  const da = lang === 'da';
  const [plans, setPlans] = useState<OverlayPlanOption[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Fetch available plans on mount (only needed for select_plan mode) */
  useEffect(() => {
    if (mode !== 'select_plan') {
      setPlansLoading(false);
      return;
    }
    fetch('/api/plans')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: OverlayPlanOption[]) => {
        setPlans(data);
        if (data.length > 0) setSelectedPlan(data[0].id);
      })
      .catch(() => {})
      .finally(() => setPlansLoading(false));
  }, [mode]);

  /**
   * Handles plan selection.
   * Paid plans → Stripe checkout.
   * Free/demo plans → selectFreePlan server action.
   */
  const handleSelect = async () => {
    if (!selectedPlan) return;
    setError(null);
    setSubmitting(true);
    const plan = plans.find((p) => p.id === selectedPlan);
    try {
      if (plan && plan.priceDkk > 0) {
        // Warn early if Stripe price ID is missing — avoids a round-trip that will always fail
        if (!plan.stripePriceId) {
          const msg = da
            ? `Stripe-pris ikke konfigureret for "${da ? plan.nameDa : plan.nameEn}". Kontakt administrator.`
            : `Stripe price not configured for "${plan.nameEn}". Contact administrator.`;
          logger.error('[PlanOverlay] Stripe price ID missing for plan', selectedPlan);
          setError(msg);
          setSubmitting(false);
          return;
        }
        const res = await fetch('/api/stripe/create-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId: selectedPlan }),
        });
        const json = await res.json();
        if (!res.ok || !json.url) {
          const apiErr = (json.error as string | undefined) ?? '';
          logger.error('[PlanOverlay] Stripe checkout failed:', res.status, apiErr);
          setError(
            apiErr ||
              (da ? 'Noget gik galt. Prøv igen.' : 'Something went wrong. Please try again.')
          );
          setSubmitting(false);
          return;
        }
        window.location.href = json.url;
      } else {
        const result = await selectFreePlan(selectedPlan);
        if (result?.error) {
          logger.error('[PlanOverlay] selectFreePlan failed:', result.error);
          setError(da ? 'Noget gik galt. Prøv igen.' : 'Something went wrong. Please try again.');
          setSubmitting(false);
          return;
        }
        // Always reload — layout re-checks subscription and shows
        // pending_approval overlay if plan requires admin approval, or
        // removes the overlay if it does not.
        window.location.reload();
      }
    } catch {
      setError(da ? 'Noget gik galt. Prøv igen.' : 'Something went wrong. Please try again.');
      setSubmitting(false);
    }
  };

  // ── Pending-approval mode ────────────────────────────────────────────────
  if (mode === 'pending_approval') {
    return (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center"
        style={{ backdropFilter: 'blur(4px)', background: 'rgba(10,16,32,0.75)' }}
      >
        <div className="w-full max-w-md mx-4">
          <div className="bg-[#1e293b] border border-white/10 rounded-2xl p-8 shadow-2xl text-center">
            {/* Wait icon */}
            <div className="w-16 h-16 bg-amber-500/10 border border-amber-500/30 rounded-2xl flex items-center justify-center mx-auto mb-5">
              <Clock size={28} className="text-amber-400" />
            </div>

            <h1 className="text-xl font-bold text-white mb-3">
              {da ? 'Demo-anmodning modtaget!' : 'Demo request received!'}
            </h1>
            <p className="text-slate-400 text-sm leading-relaxed mb-6">
              {da
                ? 'En administrator vil gennemgå din anmodning snarest muligt. Du modtager en e-mail, når din adgang er aktiveret.'
                : 'An administrator will review your request as soon as possible. You will receive an email when your access has been activated.'}
            </p>

            {/* Support link */}
            <a
              href={`mailto:${companyInfo.supportEmail}`}
              className="inline-flex items-center gap-2 text-blue-400 hover:text-blue-300 text-sm transition-colors mb-6"
            >
              {da ? 'Kontakt support' : 'Contact support'}
            </a>

            {/* Sign out */}
            <div className="border-t border-white/10 pt-5">
              <button
                type="button"
                onClick={async () => {
                  clearCacheUserId();
                  await signOut();
                }}
                className="text-slate-400 hover:text-slate-200 text-xs transition-colors"
              >
                {da ? 'Log ud' : 'Sign out'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Select-plan mode ──────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ backdropFilter: 'blur(4px)', background: 'rgba(10,16,32,0.75)' }}
    >
      <div className="w-full max-w-lg mx-4">
        <div className="bg-[#1e293b] border border-white/10 rounded-2xl p-8 shadow-2xl">
          {/* Header */}
          <div className="text-center mb-8">
            <div className="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center mx-auto mb-4">
              <span className="text-white font-bold text-xl">B</span>
            </div>
            <h1 className="text-2xl font-bold text-white mb-2">
              {da ? 'Velkommen til BizzAssist!' : 'Welcome to BizzAssist!'}
            </h1>
            <p className="text-slate-400 text-sm">
              {da
                ? 'Vælg en plan for at komme i gang og få adgang til alle funktioner.'
                : 'Choose a plan to get started and unlock all features.'}
            </p>
          </div>

          {/* Error banner */}
          {error && (
            <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-6">
              <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-red-300 text-sm">{error}</p>
            </div>
          )}

          {/* Plan cards */}
          {plansLoading ? (
            <div className="flex items-center justify-center gap-2 text-slate-400 py-8">
              <Loader2 size={14} className="animate-spin" />
              <span className="text-xs">{da ? 'Henter planer…' : 'Loading plans…'}</span>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 mb-6">
              {plans.map((plan) => {
                const isSelected = selectedPlan === plan.id;
                const colors = OVERLAY_PLAN_COLORS[plan.color] ?? OVERLAY_PLAN_COLORS.slate;
                return (
                  <button
                    key={plan.id}
                    type="button"
                    onClick={() => setSelectedPlan(plan.id)}
                    disabled={submitting}
                    className={`text-left rounded-xl p-3 border-2 transition-all disabled:opacity-50 ${
                      isSelected
                        ? `${colors.border} bg-white/5 ring-2 ${colors.ring}`
                        : 'border-white/10 hover:border-white/20 bg-white/[0.02]'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-white text-sm font-semibold">
                        {da ? plan.nameDa : plan.nameEn}
                      </span>
                      {isSelected && <CheckCircle2 size={14} className="text-blue-400" />}
                    </div>
                    <p className="text-white text-base font-bold">
                      {plan.priceDkk === 0 ? (da ? 'Gratis' : 'Free') : `${plan.priceDkk} kr`}
                      {plan.priceDkk > 0 && (
                        <span className="text-slate-400 text-xs font-normal">/md</span>
                      )}
                    </p>
                    {plan.aiEnabled && (
                      <div
                        className={`mt-1.5 inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full ${colors.badge}`}
                      >
                        <Zap size={10} />
                        {plan.aiTokensPerMonth >= 1_000_000
                          ? da
                            ? 'Ubegrænset AI'
                            : 'Unlimited AI'
                          : `${Math.round(plan.aiTokensPerMonth / 1000)}K AI`}
                      </div>
                    )}
                    {plan.requiresApproval && (
                      <div className="mt-1.5 inline-flex items-center gap-1 text-xs text-slate-400">
                        <Clock size={10} />
                        {da ? 'Kræver godkendelse' : 'Requires approval'}
                      </div>
                    )}
                    {!plan.requiresApproval && plan.freeTrialDays > 0 && (
                      <div className="mt-1.5 inline-flex items-center gap-1 text-xs text-green-400">
                        <CheckCircle2 size={10} />
                        {da
                          ? `${plan.freeTrialDays} dages gratis prøve`
                          : `${plan.freeTrialDays}-day free trial`}
                      </div>
                    )}
                    {/* Warn when a paid plan has no Stripe price configured */}
                    {plan.priceDkk > 0 && !plan.stripePriceId && (
                      <div className="mt-1.5 inline-flex items-center gap-1 text-xs text-amber-400">
                        <AlertCircle size={10} />
                        {da ? 'Betaling ikke konfigureret' : 'Payment not configured'}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* CTA */}
          {!plansLoading && plans.length > 0 && (
            <button
              type="button"
              onClick={handleSelect}
              disabled={submitting || !selectedPlan}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 px-4 rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {submitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  {da ? 'Behandler…' : 'Processing…'}
                </>
              ) : (
                (() => {
                  const plan = plans.find((p) => p.id === selectedPlan);
                  if (!plan) return da ? 'Vælg plan' : 'Select plan';
                  if (plan.priceDkk > 0) {
                    return da
                      ? `Gå til betaling — ${plan.priceDkk} kr/md`
                      : `Proceed to payment — ${plan.priceDkk} kr/mo`;
                  }
                  return da ? 'Kom i gang' : 'Get started';
                })()
              )}
            </button>
          )}

          <p className="text-center text-slate-600 text-xs mt-4">
            {da
              ? 'Du kan opgradere eller annullere dit abonnement til enhver tid.'
              : 'You can upgrade or cancel your subscription at any time.'}
          </p>
        </div>
      </div>
    </div>
  );
}
