'use client';

/**
 * Indstillinger-side — /dashboard/settings
 *
 * Tabs (stil som ejendomsdetaljer):
 *   - Følger: oversigt over fulgte ejendomme/virksomheder/personer med unfollow
 *   - Sikkerhed: 2FA-opsætning via Supabase MFA
 *
 * Datakilde: localStorage (trackedEjendomme.ts) + Supabase via /api/tracked
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Bell,
  BellOff,
  Building2,
  Briefcase,
  User,
  ChevronRight,
  ArrowLeft,
  Shield,
  Trash2,
  CreditCard,
  Zap,
  Crown,
  CheckCircle,
  Clock,
  Loader2,
  Eye,
  EyeOff,
  Pencil,
  KeyRound,
  ExternalLink,
  AlertTriangle,
} from 'lucide-react';
import {
  hentTrackedEjendomme,
  untrackEjendom,
  type TrackedEjendom,
} from '@/app/lib/trackedEjendomme';
import { useLanguage } from '@/app/context/LanguageContext';
import SecuritySettingsPage from './security/page';
import {
  PLAN_LIST,
  resolvePlan,
  formatTokens,
  type UserSubscription,
  type PlanDef,
} from '@/app/lib/subscriptions';
import { useSubscription } from '@/app/context/SubscriptionContext';

// ─── Profile Tab Component ──────────────────────────────────────────────────

/**
 * Profile tab — lets the user edit their display name and change password.
 * Uses Supabase Auth API directly for both operations.
 */
function ProfileTab({ lang }: { lang: 'da' | 'en' }) {
  const da = lang === 'da';

  // ── Profile state ──
  const [fullName, setFullName] = useState('');
  const [originalName, setOriginalName] = useState('');
  const [nameLoading, setNameLoading] = useState(false);
  const [nameSuccess, setNameSuccess] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  // ── Password state ──
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showCurrentPw, setShowCurrentPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [pwLoading, setPwLoading] = useState(false);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  /** Load current user data from server-side API */
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/subscription');
        if (res.ok) {
          const data = await res.json();
          if (data.fullName) {
            setFullName(data.fullName);
            setOriginalName(data.fullName);
          }
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  /** Save display name via server-side API */
  const handleSaveName = async () => {
    if (fullName.trim() === originalName.trim()) return;
    setNameLoading(true);
    setNameError(null);
    setNameSuccess(false);

    try {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName: fullName.trim() }),
      });

      if (!res.ok) {
        setNameError(da ? 'Kunne ikke opdatere navn.' : 'Could not update name.');
      } else {
        setNameSuccess(true);
        setOriginalName(fullName.trim());
        setTimeout(() => setNameSuccess(false), 3000);
      }
    } catch {
      setNameError(da ? 'Netværksfejl.' : 'Network error.');
    }
    setNameLoading(false);
  };

  /** Change password via server-side API */
  const handleChangePassword = async () => {
    setPwError(null);
    setPwSuccess(false);

    if (newPw.length < 6) {
      setPwError(
        da
          ? 'Ny adgangskode skal være mindst 6 tegn.'
          : 'New password must be at least 6 characters.'
      );
      return;
    }
    if (newPw !== confirmPw) {
      setPwError(da ? 'Adgangskoderne matcher ikke.' : 'Passwords do not match.');
      return;
    }

    setPwLoading(true);

    try {
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      });
      const data = await res.json();

      if (!res.ok) {
        if (data.error === 'wrong_password') {
          setPwError(da ? 'Nuværende adgangskode er forkert.' : 'Current password is incorrect.');
        } else if (data.error === 'same_password') {
          setPwError(
            da
              ? 'Den nye adgangskode skal være anderledes end den nuværende.'
              : 'New password must be different from the current one.'
          );
        } else if (data.error === 'password_too_short') {
          setPwError(
            da
              ? 'Ny adgangskode skal være mindst 6 tegn.'
              : 'New password must be at least 6 characters.'
          );
        } else {
          setPwError(da ? 'Kunne ikke ændre adgangskode.' : 'Could not change password.');
        }
      } else {
        setPwSuccess(true);
        setCurrentPw('');
        setNewPw('');
        setConfirmPw('');
        setTimeout(() => setPwSuccess(false), 3000);
      }
    } catch {
      setPwError(da ? 'Netværksfejl.' : 'Network error.');
    }
    setPwLoading(false);
  };

  const nameChanged = fullName.trim() !== originalName.trim();

  return (
    <div className="space-y-6 max-w-lg">
      {/* ── Display name ── */}
      <div className="bg-white/5 border border-white/8 rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <Pencil size={16} className="text-blue-400" />
          <h3 className="text-white font-semibold text-sm">{da ? 'Profilnavn' : 'Display name'}</h3>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-slate-400 text-xs font-medium mb-1.5">
              {da ? 'Fulde navn' : 'Full name'}
            </label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => {
                setFullName(e.target.value);
                setNameError(null);
                setNameSuccess(false);
              }}
              className="w-full bg-slate-800/60 border border-slate-600/50 rounded-lg px-3 py-2.5 text-white text-sm placeholder:text-slate-600 focus:border-blue-500 focus:outline-none transition-colors"
              placeholder={da ? 'Dit navn' : 'Your name'}
            />
          </div>

          {nameError && <p className="text-red-400 text-xs">{nameError}</p>}
          {nameSuccess && (
            <p className="text-emerald-400 text-xs flex items-center gap-1">
              <CheckCircle size={12} /> {da ? 'Navn opdateret!' : 'Name updated!'}
            </p>
          )}

          <button
            onClick={handleSaveName}
            disabled={!nameChanged || nameLoading}
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {nameLoading && <Loader2 size={14} className="animate-spin" />}
            {da ? 'Gem navn' : 'Save name'}
          </button>
        </div>
      </div>

      {/* ── Change password ── */}
      <div className="bg-white/5 border border-white/8 rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <KeyRound size={16} className="text-amber-400" />
          <h3 className="text-white font-semibold text-sm">
            {da ? 'Skift adgangskode' : 'Change password'}
          </h3>
        </div>

        <div className="space-y-3">
          {/* Current password */}
          <div>
            <label className="block text-slate-400 text-xs font-medium mb-1.5">
              {da ? 'Nuværende adgangskode' : 'Current password'}
            </label>
            <div className="relative">
              <input
                type={showCurrentPw ? 'text' : 'password'}
                value={currentPw}
                onChange={(e) => {
                  setCurrentPw(e.target.value);
                  setPwError(null);
                }}
                className="w-full bg-slate-800/60 border border-slate-600/50 rounded-lg px-3 py-2.5 pr-10 text-white text-sm placeholder:text-slate-600 focus:border-blue-500 focus:outline-none transition-colors"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowCurrentPw(!showCurrentPw)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              >
                {showCurrentPw ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {/* New password */}
          <div>
            <label className="block text-slate-400 text-xs font-medium mb-1.5">
              {da ? 'Ny adgangskode' : 'New password'}
            </label>
            <div className="relative">
              <input
                type={showNewPw ? 'text' : 'password'}
                value={newPw}
                onChange={(e) => {
                  setNewPw(e.target.value);
                  setPwError(null);
                }}
                className="w-full bg-slate-800/60 border border-slate-600/50 rounded-lg px-3 py-2.5 pr-10 text-white text-sm placeholder:text-slate-600 focus:border-blue-500 focus:outline-none transition-colors"
                placeholder={da ? 'Mindst 6 tegn' : 'At least 6 characters'}
              />
              <button
                type="button"
                onClick={() => setShowNewPw(!showNewPw)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              >
                {showNewPw ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {/* Confirm new password */}
          <div>
            <label className="block text-slate-400 text-xs font-medium mb-1.5">
              {da ? 'Bekræft ny adgangskode' : 'Confirm new password'}
            </label>
            <input
              type="password"
              value={confirmPw}
              onChange={(e) => {
                setConfirmPw(e.target.value);
                setPwError(null);
              }}
              className={`w-full bg-slate-800/60 border rounded-lg px-3 py-2.5 text-white text-sm placeholder:text-slate-600 focus:outline-none transition-colors ${
                confirmPw && confirmPw !== newPw
                  ? 'border-red-500/60 focus:border-red-500'
                  : 'border-slate-600/50 focus:border-blue-500'
              }`}
              placeholder={da ? 'Skriv adgangskoden igen' : 'Type password again'}
            />
            {confirmPw && confirmPw !== newPw && (
              <p className="text-red-400 text-xs mt-1">
                {da ? 'Adgangskoderne matcher ikke' : 'Passwords do not match'}
              </p>
            )}
          </div>

          {pwError && <p className="text-red-400 text-xs">{pwError}</p>}
          {pwSuccess && (
            <p className="text-emerald-400 text-xs flex items-center gap-1">
              <CheckCircle size={12} /> {da ? 'Adgangskode ændret!' : 'Password changed!'}
            </p>
          )}

          <button
            onClick={handleChangePassword}
            disabled={pwLoading || !currentPw || !newPw || newPw !== confirmPw}
            className="flex items-center gap-2 px-4 py-2.5 bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {pwLoading && <Loader2 size={14} className="animate-spin" />}
            {da ? 'Skift adgangskode' : 'Change password'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Tabs for indstillinger — samme stil som ejendomsdetaljer */
type SettingsTab = 'profil' | 'foelger' | 'abonnement' | 'sikkerhed';

/** Filter for entitetstype i Følger-tab */
type EntityFilter = 'all' | 'property' | 'company' | 'person';

/**
 * Indstillinger med tabs: Følger og Sikkerhed.
 * Tab-design matcher ejendomsdetalje-sidernes tab-bar.
 */
export default function SettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { lang } = useLanguage();
  const [tab, setTab] = useState<SettingsTab>('profil');
  const [filter, setFilter] = useState<EntityFilter>('all');
  const [tracked, setTracked] = useState<TrackedEjendom[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  /** Subscription context — server-authoritative */
  const { subscription: ctxSub, isAdmin: ctxIsAdmin } = useSubscription();
  const [subscription, setSubscription] = useState<UserSubscription | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  /** Seed local state from context on mount */
  useEffect(() => {
    if (ctxSub) setSubscription(ctxSub);
    setIsAdmin(ctxIsAdmin);
  }, [ctxSub, ctxIsAdmin]);

  /** Stripe billing details (next payment, card, cancellation) */
  const [billing, setBilling] = useState<{
    nextPaymentDate: string | null;
    cardLast4: string | null;
    cardBrand: string | null;
    cancelAtPeriodEnd: boolean;
    cancelAt: string | null;
    stripeStatus: string | null;
  } | null>(null);

  /** Plans fetched from API (only active plans) */
  const [availablePlans, setAvailablePlans] = useState<PlanDef[]>(PLAN_LIST);

  /** Stripe checkout / portal loading state */
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [stripeError, setStripeError] = useState<string | null>(null);

  /** Cancel subscription state */
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelSuccess, setCancelSuccess] = useState<string | null>(null);

  /** Payment result from URL params (after Stripe redirect) */
  const paymentResult = searchParams.get('payment') as 'success' | 'cancelled' | null;

  /** Open specific tab if ?tab= is present in URL */
  const VALID_TABS: SettingsTab[] = ['profil', 'foelger', 'abonnement', 'sikkerhed'];
  const tabParam = searchParams.get('tab') as SettingsTab | null;
  useEffect(() => {
    if (tabParam && VALID_TABS.includes(tabParam)) {
      setTab(tabParam);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabParam]);

  /** Genindlæs data fra localStorage + Supabase */
  const refresh = useCallback(async () => {
    const ls = hentTrackedEjendomme();
    setTracked(ls);

    try {
      const res = await fetch('/api/tracked');
      const data = await res.json();
      if (data.tracked?.length > 0) {
        setTracked(
          data.tracked.map((e: Record<string, unknown>) => ({
            id: e.entity_id as string,
            adresse: (e.label as string) || (e.entity_id as string),
            postnr: ((e.entity_data as Record<string, unknown>)?.postnr as string) || '',
            by: ((e.entity_data as Record<string, unknown>)?.by as string) || '',
            kommune: ((e.entity_data as Record<string, unknown>)?.kommune as string) || '',
            anvendelse: ((e.entity_data as Record<string, unknown>)?.anvendelse as string) || null,
            entityType:
              ((e.entity_data as Record<string, unknown>)?.entityType as string) || 'property',
            trackedSiden: new Date(e.created_at as string).getTime(),
          }))
        );
      }
    } catch {
      /* localStorage allerede sat */
    }

    // Load subscription from server (context has initial value, refresh from API)
    try {
      const subRes = await fetch('/api/subscription');
      if (subRes.ok) {
        const subJson = await subRes.json();
        if (subJson.subscription?.planId) {
          const freshSub: UserSubscription = {
            email: subJson.email ?? '',
            planId: subJson.subscription.planId,
            status: subJson.subscription.status ?? 'pending',
            createdAt: subJson.subscription.createdAt ?? '',
            approvedAt: subJson.subscription.approvedAt ?? null,
            tokensUsedThisMonth: subJson.subscription.tokensUsedThisMonth ?? 0,
            periodStart: subJson.subscription.periodStart ?? '',
            bonusTokens: subJson.subscription.bonusTokens ?? 0,
            isPaid: subJson.subscription.isPaid ?? false,
            cancelAtPeriodEnd: subJson.subscription.cancelAtPeriodEnd ?? false,
            cancelAt: subJson.subscription.cancelAt ?? null,
          };
          setSubscription(freshSub);
        } else {
          // API returned no subscription — clear local state
          setSubscription(null);
        }
        // Set admin flag from API response
        if (subJson.isAdmin) {
          setIsAdmin(true);
        } else {
          setIsAdmin(false);
        }
        // Store billing details from Stripe
        if (subJson.billing) {
          setBilling(subJson.billing);
        }
      }
    } catch {
      /* fallback to localStorage */
    }

    // Fetch active plans from API
    try {
      const planRes = await fetch('/api/plans');
      if (planRes.ok) {
        const planData = await planRes.json();
        setAvailablePlans(planData);
      }
    } catch {
      /* fallback to hardcoded PLAN_LIST */
    }
  }, []);

  useEffect(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener('ba-tracked-changed', handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener('ba-tracked-changed', handler);
      window.removeEventListener('storage', handler);
    };
  }, [refresh]);

  /** Auto-switch to subscription tab if returning from Stripe payment */
  useEffect(() => {
    if (paymentResult === 'success' || paymentResult === 'cancelled') {
      setTab('abonnement');
    }
    // Verify payment session and refresh subscription data
    if (paymentResult === 'success') {
      const sessionId = searchParams.get('session_id');
      const verify = async () => {
        if (sessionId) {
          try {
            await fetch('/api/stripe/verify-session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId }),
            });
          } catch {
            /* webhook will handle it eventually */
          }
        }
        // Refresh after verify (or after short delay if no session_id)
        await refresh();
      };
      const timer = setTimeout(verify, 500);
      return () => clearTimeout(timer);
    }
  }, [paymentResult, searchParams, refresh]);

  /**
   * Initiate Stripe Checkout for a given plan.
   * Calls /api/stripe/create-checkout and redirects to the Stripe-hosted page.
   */
  const handleCheckout = async (planId: string) => {
    setCheckoutLoading(planId);
    setStripeError(null);
    try {
      const res = await fetch('/api/stripe/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId }),
      });
      const data = await res.json();
      if (res.ok && data.url) {
        window.location.href = data.url;
      } else {
        console.error('[checkout] Error:', data.error);
        setStripeError(
          data.error || (da ? 'Kunne ikke oprette betaling' : 'Could not create checkout')
        );
        setCheckoutLoading(null);
      }
    } catch (err) {
      console.error('[checkout] Network error:', err);
      setStripeError(da ? 'Netværksfejl — prøv igen' : 'Network error — please try again');
      setCheckoutLoading(null);
    }
  };

  /**
   * Open the Stripe Customer Portal for billing management.
   * Calls /api/stripe/portal and redirects to the portal page.
   */
  const handlePortal = async () => {
    setPortalLoading(true);
    setStripeError(null);
    try {
      const res = await fetch('/api/stripe/portal', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.url) {
        window.location.href = data.url;
      } else {
        console.error('[portal] Error:', data.error);
        setStripeError(
          data.error || (da ? 'Kunne ikke åbne betalingsportal' : 'Could not open billing portal')
        );
      }
    } catch (err) {
      console.error('[portal] Network error:', err);
      setStripeError(da ? 'Netværksfejl — prøv igen' : 'Network error — please try again');
    }
    setPortalLoading(false);
  };

  /**
   * Cancel the user's Stripe subscription at the end of the current billing period.
   * Calls /api/stripe/cancel-subscription and refreshes subscription data.
   */
  const handleCancelSubscription = async () => {
    setCancelLoading(true);
    setStripeError(null);
    try {
      const res = await fetch('/api/stripe/cancel-subscription', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.ok) {
        const cancelDate = new Date(data.cancelAt).toLocaleDateString(
          lang === 'da' ? 'da-DK' : 'en-GB',
          { day: 'numeric', month: 'long', year: 'numeric' }
        );
        setCancelSuccess(cancelDate);
        setCancelConfirmOpen(false);
        await refresh();
      } else if (
        data.error?.includes('No Stripe customer') ||
        data.error?.includes('No active subscription')
      ) {
        // No Stripe subscription (admin-assigned plan) — cancel via self-service endpoint
        const cancelRes = await fetch('/api/subscription/cancel', { method: 'POST' });
        const cancelData = await cancelRes.json();
        if (cancelRes.ok && cancelData.ok) {
          setCancelSuccess(da ? 'nu' : 'now');
          setCancelConfirmOpen(false);
          await refresh();
        } else {
          setStripeError(
            cancelData.error ||
              (da ? 'Kunne ikke opsige abonnement' : 'Could not cancel subscription')
          );
        }
      } else {
        console.error('[cancel] Error:', data.error);
        setStripeError(
          data.error || (da ? 'Kunne ikke opsige abonnement' : 'Could not cancel subscription')
        );
      }
    } catch (err) {
      console.error('[cancel] Network error:', err);
      setStripeError(da ? 'Netværksfejl — prøv igen' : 'Network error — please try again');
    }
    setCancelLoading(false);
  };

  /** Stop tracking */
  const handleUntrack = async (id: string) => {
    untrackEjendom(id);
    window.dispatchEvent(new Event('ba-tracked-changed'));
    try {
      await fetch(`/api/tracked?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      /* ignorer */
    }
    setConfirmDelete(null);
    refresh();
  };

  /**
   * Filtrerede entiteter baseret på valgt filter.
   * Pt. er alle tracked entiteter ejendomme — klar til virksomheder/personer.
   */
  const filtered = tracked.filter((ej) => {
    if (filter === 'all') return true;
    // Brug entityType fra entity_data hvis tilgængelig, ellers antag 'property'
    const type = (ej as TrackedEjendom & { entityType?: string }).entityType || 'property';
    return type === filter;
  });

  /** Antal pr. type til badge-visning */
  const counts = {
    all: tracked.length,
    property: tracked.filter(
      (ej) =>
        ((ej as TrackedEjendom & { entityType?: string }).entityType || 'property') === 'property'
    ).length,
    company: tracked.filter(
      (ej) => (ej as TrackedEjendom & { entityType?: string }).entityType === 'company'
    ).length,
    person: tracked.filter(
      (ej) => (ej as TrackedEjendom & { entityType?: string }).entityType === 'person'
    ).length,
  };

  const da = lang === 'da';
  const t = {
    titel: da ? 'Indstillinger' : 'Settings',
    back: da ? 'Tilbage' : 'Back',
    profil: da ? 'Profil' : 'Profile',
    foelger: da ? 'Følger' : 'Tracked',
    abonnement: da ? 'Abonnement' : 'Subscription',
    sikkerhed: da ? 'Sikkerhed' : 'Security',
    alle: da ? 'Alle' : 'All',
    ejendomme: da ? 'Ejendomme' : 'Properties',
    virksomheder: da ? 'Virksomheder' : 'Companies',
    ejere: da ? 'Ejere' : 'Owners',
    ingenFulgte: da
      ? 'Du følger ingen ejendomme, virksomheder eller ejere endnu.'
      : 'You are not tracking any properties, companies or owners yet.',
    ingenFulgteHint: da
      ? 'Tryk "Følg" på en ejendoms- eller virksomhedsside for at modtage notifikationer om ændringer.'
      : 'Click "Follow" on a property or company page to receive change notifications.',
    stopFoelg: da ? 'Stop følg' : 'Unfollow',
    ja: da ? 'Ja, fjern' : 'Yes, remove',
    nej: da ? 'Annuller' : 'Cancel',
    fulgtSiden: da ? 'Fulgt siden' : 'Tracked since',
    overvaagetData: da
      ? 'Du får besked når følgende data ændres:'
      : 'You will be notified when the following data changes:',
    ingenIKategori: da ? 'Ingen fulgte i denne kategori.' : 'Nothing tracked in this category.',
    bbrDesc: da ? 'Areal, byggeår, status, anvendelse' : 'Area, build year, status, usage',
    valuation: da ? 'Vurdering' : 'Valuation',
    valuationDesc: da ? 'Ejendomsværdi, grundværdi' : 'Property value, land value',
    ownership: da ? 'Ejerskab' : 'Ownership',
    ownershipDesc: da ? 'Ejerskifte, nye ejere' : 'Ownership transfer, new owners',
    manageUsers: da ? 'Administrer brugere' : 'Manage users',
    yourSub: da ? 'Dit abonnement' : 'Your subscription',
    statusActive: da ? 'Aktiv' : 'Active',
    statusPending: da ? 'Afventer godkendelse' : 'Pending approval',
    statusCancelled: da ? 'Annulleret' : 'Cancelled',
    free: da ? 'Gratis' : 'Free',
    notIncluded: da ? 'Ikke inkluderet' : 'Not included',
    export: da ? 'Eksport' : 'Export',
    aiUsage: da ? 'AI-forbrug denne måned' : 'AI usage this month',
    pendingWarning: da
      ? 'Dit abonnement afventer godkendelse af en administrator. Du har begrænset adgang indtil det er godkendt.'
      : 'Your subscription is pending administrator approval. You have limited access until approved.',
    memberSince: da ? 'Medlem siden' : 'Member since',
    noSub: da ? 'Intet abonnement' : 'No subscription',
    noSubHint: da
      ? 'Du har endnu ikke valgt et abonnement. Kontakt en administrator for adgang.'
      : 'You have not selected a subscription yet. Contact an administrator for access.',
    availablePlans: da ? 'Tilgængelige planer' : 'Available plans',
    current: da ? 'Nuværende' : 'Current',
    unlimitedSearches: da ? 'Ubegrænsede søgninger' : 'Unlimited searches',
    noAI: da ? 'Ingen AI' : 'No AI',
    pdfExport: da ? 'PDF + CSV eksport' : 'PDF + CSV export',
    requiresApproval: da ? 'Kræver admin-godkendelse' : 'Requires admin approval',
    contactChange: da
      ? 'Demo-planen er gratis og kræver ingen betaling.'
      : 'The demo plan is free and requires no payment.',
    upgrade: da ? 'Opgrader' : 'Upgrade',
    downgrade: da ? 'Skift til denne' : 'Switch to this',
    soldOut: da ? 'Udsolgt' : 'Sold out',
    spotsLeft: da ? 'pladser tilbage' : 'spots left',
    switchPlan: da ? 'Skift plan' : 'Switch plan',
    manageBilling: da ? 'Administrer betaling' : 'Manage billing',
    paymentSuccess: da
      ? 'Betaling gennemført! Dit abonnement er nu aktivt.'
      : 'Payment successful! Your subscription is now active.',
    paymentCancelled: da
      ? 'Betalingen blev annulleret. Du kan prøve igen.'
      : 'Payment was cancelled. You can try again.',
    paymentFailed: da
      ? 'Der er et problem med din betaling. Opdater din betalingsmetode.'
      : 'There is a problem with your payment. Please update your payment method.',
    cancelSubscription: da ? 'Opsig abonnement' : 'Cancel subscription',
    cancelConfirmTitle: da ? 'Opsig dit abonnement?' : 'Cancel your subscription?',
    cancelConfirmBody: da
      ? 'Dit abonnement vil forblive aktivt indtil slutningen af den nuvaerende faktureringsperiode. Herefter mister du adgang til betalte funktioner.'
      : 'Your subscription will remain active until the end of the current billing period. After that, you will lose access to paid features.',
    cancelConfirmButton: da ? 'Ja, opsig abonnement' : 'Yes, cancel subscription',
    cancelKeep: da ? 'Behold abonnement' : 'Keep subscription',
    cancelledAt: da
      ? 'Dit abonnement er opsagt. Du har adgang indtil'
      : 'Your subscription has been cancelled. You have access until',
    nextPayment: da ? 'Næste betaling' : 'Next payment',
    paymentMethod: da ? 'Betalingsmetode' : 'Payment method',
    subscriptionDetails: da ? 'Abonnementsdetaljer' : 'Subscription details',
    plan: da ? 'Plan' : 'Plan',
    price: da ? 'Pris' : 'Price',
    status: da ? 'Status' : 'Status',
    approvedOn: da ? 'Godkendt' : 'Approved',
    cancelPending: da ? 'Opsigelse afventer — adgang til' : 'Cancellation pending — access until',
  };

  const tabs: { key: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { key: 'profil', label: t.profil, icon: <User size={14} /> },
    { key: 'foelger', label: t.foelger, icon: <Bell size={14} /> },
    { key: 'abonnement', label: t.abonnement, icon: <CreditCard size={14} /> },
    { key: 'sikkerhed', label: t.sikkerhed, icon: <Shield size={14} /> },
  ];

  const filterButtons: {
    key: EntityFilter;
    label: string;
    icon: React.ReactNode;
    count: number;
  }[] = [
    { key: 'all', label: t.alle, icon: null, count: counts.all },
    { key: 'property', label: t.ejendomme, icon: <Building2 size={13} />, count: counts.property },
    { key: 'company', label: t.virksomheder, icon: <Briefcase size={13} />, count: counts.company },
    { key: 'person', label: t.ejere, icon: <User size={13} />, count: counts.person },
  ];

  /** Ikon for entitetstype */
  const entityIcon = (ej: TrackedEjendom) => {
    const type = (ej as TrackedEjendom & { entityType?: string }).entityType || 'property';
    switch (type) {
      case 'company':
        return <Briefcase size={18} className="text-purple-400" />;
      case 'person':
        return <User size={18} className="text-amber-400" />;
      default:
        return <Building2 size={18} className="text-blue-400" />;
    }
  };

  /** Baggrundsfarve for entitetsikon */
  const entityIconBg = (ej: TrackedEjendom) => {
    const type = (ej as TrackedEjendom & { entityType?: string }).entityType || 'property';
    switch (type) {
      case 'company':
        return 'bg-purple-600/20';
      case 'person':
        return 'bg-amber-600/20';
      default:
        return 'bg-blue-600/20';
    }
  };

  /** Returnerer den korrekte dashboard-rute baseret på entitetstype */
  const entityRoute = (ej: TrackedEjendom): string => {
    const type = (ej as TrackedEjendom & { entityType?: string }).entityType || 'property';
    switch (type) {
      case 'company':
        return `/dashboard/companies/${ej.id}`;
      case 'person':
        return `/dashboard/owners/${ej.id}`;
      default:
        return `/dashboard/ejendomme/${ej.id}`;
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ─── Sticky header + tabs ─── */}
      <div className="px-6 pt-5 pb-0 border-b border-slate-700/50 bg-slate-900/30">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
          >
            <ArrowLeft size={16} /> {t.back}
          </button>
        </div>
        <h1 className="text-white text-xl font-bold mb-3">{t.titel}</h1>

        {/* Tab-bar — matcher ejendomsdetalje-stil */}
        <div className="flex gap-1 -mb-px">
          {tabs.map((item) => (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-all whitespace-nowrap ${
                tab === item.key
                  ? 'border-blue-500 text-blue-300'
                  : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600'
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Scrollbart indhold ─── */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {/* ═══ Profil tab ═══ */}
        {tab === 'profil' && <ProfileTab lang={lang} />}

        {/* ═══ Følger tab ═══ */}
        {tab === 'foelger' && (
          <>
            {/* Entitetstype-filter */}
            <div className="flex gap-2 mb-4 flex-wrap">
              {filterButtons.map((fb) => (
                <button
                  key={fb.key}
                  onClick={() => setFilter(fb.key)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    filter === fb.key
                      ? 'bg-blue-600/20 border border-blue-500/40 text-blue-300'
                      : 'bg-slate-800/60 border border-slate-700/40 text-slate-400 hover:text-white hover:border-slate-600'
                  }`}
                >
                  {fb.icon}
                  {fb.label}
                  {fb.count > 0 && (
                    <span
                      className={`ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                        filter === fb.key
                          ? 'bg-blue-500/30 text-blue-300'
                          : 'bg-slate-700/60 text-slate-500'
                      }`}
                    >
                      {fb.count}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Info-boks: hvad der overvåges */}
            {tracked.length > 0 && (
              <div className="mb-6 p-4 bg-blue-600/10 border border-blue-500/20 rounded-xl">
                <p className="text-blue-300 text-sm font-medium mb-2">{t.overvaagetData}</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="flex items-start gap-2">
                    <Building2 size={14} className="text-blue-400 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-white text-xs font-medium">BBR</p>
                      <p className="text-slate-400 text-[11px] leading-relaxed">{t.bbrDesc}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-blue-400 mt-0.5 flex-shrink-0 text-[13px]">kr</span>
                    <div>
                      <p className="text-white text-xs font-medium">{t.valuation}</p>
                      <p className="text-slate-400 text-[11px] leading-relaxed">
                        {t.valuationDesc}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-blue-400 mt-0.5 flex-shrink-0 text-[13px]">
                      <User size={13} />
                    </span>
                    <div>
                      <p className="text-white text-xs font-medium">{t.ownership}</p>
                      <p className="text-slate-400 text-[11px] leading-relaxed">
                        {t.ownershipDesc}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Liste */}
            {filtered.length === 0 ? (
              <div className="text-center py-16">
                <BellOff size={40} className="mx-auto mb-4 text-slate-600" />
                <p className="text-slate-400 text-sm mb-2">
                  {filter === 'all' ? t.ingenFulgte : t.ingenIKategori}
                </p>
                {filter === 'all' && (
                  <p className="text-slate-500 text-xs max-w-sm mx-auto leading-relaxed">
                    {t.ingenFulgteHint}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {filtered.map((ej) => (
                  <div
                    key={ej.id}
                    className="group flex items-center gap-4 p-4 bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/30 hover:border-slate-600/50 rounded-xl transition-all cursor-pointer"
                    onClick={() => router.push(entityRoute(ej))}
                  >
                    <div
                      className={`w-10 h-10 ${entityIconBg(ej)} rounded-xl flex items-center justify-center flex-shrink-0`}
                    >
                      {entityIcon(ej)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-white text-sm font-medium truncate">{ej.adresse}</p>
                      <p className="text-slate-500 text-xs mt-0.5 truncate">
                        {ej.postnr} {ej.by}
                        {ej.kommune ? ` · ${ej.kommune}` : ''}
                        {ej.anvendelse ? ` · ${ej.anvendelse}` : ''}
                      </p>
                      <p className="text-slate-600 text-[10px] mt-1">
                        {t.fulgtSiden}{' '}
                        {new Date(ej.trackedSiden).toLocaleDateString(
                          lang === 'da' ? 'da-DK' : 'en-GB',
                          {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          }
                        )}
                      </p>
                    </div>

                    {/* Unfollow */}
                    {confirmDelete === ej.id ? (
                      <div
                        className="flex items-center gap-2 flex-shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          onClick={() => handleUntrack(ej.id)}
                          className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 text-xs font-medium rounded-lg transition-colors"
                        >
                          {t.ja}
                        </button>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="px-3 py-1.5 bg-slate-700/50 hover:bg-slate-700 text-slate-400 text-xs font-medium rounded-lg transition-colors"
                        >
                          {t.nej}
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDelete(ej.id);
                          }}
                          className="p-2 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                          title={t.stopFoelg}
                        >
                          <Trash2 size={15} />
                        </button>
                        <ChevronRight size={16} className="text-slate-600" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ═══ Abonnement tab ═══ */}
        {tab === 'abonnement' && (
          <div className="space-y-6">
            {/* Payment result banner */}
            {paymentResult === 'success' && (
              <div className="flex items-center gap-3 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
                <CheckCircle size={18} className="text-emerald-400 shrink-0" />
                <p className="text-emerald-300 text-sm">{t.paymentSuccess}</p>
              </div>
            )}
            {paymentResult === 'cancelled' && (
              <div className="flex items-center gap-3 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
                <AlertTriangle size={18} className="text-amber-400 shrink-0" />
                <p className="text-amber-300 text-sm">{t.paymentCancelled}</p>
              </div>
            )}

            {/* Admin link (only for admin user) */}
            {isAdmin && (
              <button
                onClick={() => router.push('/dashboard/admin/users')}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 rounded-xl text-blue-400 text-sm font-medium transition-colors"
              >
                <Shield size={16} />
                {t.manageUsers}
              </button>
            )}

            {/* Current subscription */}
            {subscription ? (
              <div className="bg-white/5 border border-white/8 rounded-2xl p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-white font-semibold text-sm">{t.yourSub}</h3>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${
                      subscription.status === 'active'
                        ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                        : subscription.status === 'pending'
                          ? 'bg-amber-500/20 text-amber-400 border-amber-500/30'
                          : 'bg-red-500/20 text-red-400 border-red-500/30'
                    }`}
                  >
                    {subscription.status === 'active' && <CheckCircle size={12} />}
                    {subscription.status === 'pending' && <Clock size={12} />}
                    {subscription.status === 'active'
                      ? t.statusActive
                      : subscription.status === 'pending'
                        ? t.statusPending
                        : t.statusCancelled}
                  </span>
                </div>

                {(() => {
                  const plan = resolvePlan(subscription.planId);
                  const needsPayment = plan.priceDkk > 0 && !subscription.isPaid;
                  return (
                    <div className="space-y-4">
                      {/* Payment required banner — shown when plan costs money but user hasn't paid */}
                      {needsPayment && (
                        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 space-y-3">
                          <div className="flex items-start gap-3">
                            <AlertTriangle size={20} className="text-amber-400 shrink-0 mt-0.5" />
                            <div>
                              <p className="text-amber-300 font-semibold text-sm">
                                {da ? 'Betaling påkrævet' : 'Payment required'}
                              </p>
                              <p className="text-amber-300/70 text-xs mt-1">
                                {da
                                  ? 'Dit abonnement er aktivt, men der mangler betaling. Gennemfør betalingen for at få fuld adgang til søgning, AI og alle funktioner.'
                                  : 'Your subscription is active but payment is pending. Complete payment to unlock search, AI, and all features.'}
                              </p>
                            </div>
                          </div>
                          <button
                            onClick={() => handleCheckout(subscription.planId)}
                            disabled={checkoutLoading === subscription.planId}
                            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black text-sm font-bold rounded-xl transition-colors"
                          >
                            {checkoutLoading === subscription.planId ? (
                              <Loader2 size={16} className="animate-spin" />
                            ) : (
                              <CreditCard size={16} />
                            )}
                            {da
                              ? `Betal nu — ${plan.priceDkk} kr/md`
                              : `Pay now — ${plan.priceDkk} kr/month`}
                          </button>
                        </div>
                      )}

                      {/* Stripe error banner */}
                      {stripeError && (
                        <div className="flex items-center gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-xl">
                          <AlertTriangle size={18} className="text-red-400 shrink-0" />
                          <p className="text-red-300 text-sm">{stripeError}</p>
                        </div>
                      )}

                      <div className="flex items-center gap-3">
                        <div
                          className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                            plan.id === 'enterprise'
                              ? 'bg-purple-500/10 text-purple-400'
                              : plan.id === 'professionel'
                                ? 'bg-blue-500/10 text-blue-400'
                                : plan.id === 'basis'
                                  ? 'bg-slate-500/10 text-slate-400'
                                  : 'bg-amber-500/10 text-amber-400'
                          }`}
                        >
                          {plan.id === 'enterprise' ? (
                            <Crown size={18} />
                          ) : plan.id === 'professionel' ? (
                            <Zap size={18} />
                          ) : plan.id === 'basis' ? (
                            <Shield size={18} />
                          ) : (
                            <Clock size={18} />
                          )}
                        </div>
                        <div>
                          <p className="text-white font-semibold">
                            {da ? plan.nameDa : plan.nameEn}
                          </p>
                          <p className="text-slate-400 text-xs">
                            {plan.priceDkk === 0 ? t.free : `${plan.priceDkk} kr/md`}
                          </p>
                        </div>
                      </div>

                      {/* ─── Subscription details grid ─── */}
                      <div className="bg-slate-800/40 rounded-xl p-4 space-y-3">
                        <p className="text-slate-500 text-[10px] uppercase tracking-wider font-semibold">
                          {t.subscriptionDetails}
                        </p>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                          {/* Price */}
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                              {t.price}
                            </p>
                            <p className="text-white text-sm font-medium">
                              {plan.priceDkk === 0 ? t.free : `${plan.priceDkk} kr/md`}
                            </p>
                          </div>

                          {/* Status */}
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                              {t.status}
                            </p>
                            <p
                              className={`text-sm font-medium ${
                                subscription.status === 'active'
                                  ? 'text-emerald-400'
                                  : subscription.status === 'pending'
                                    ? 'text-amber-400'
                                    : 'text-red-400'
                              }`}
                            >
                              {subscription.status === 'active'
                                ? t.statusActive
                                : subscription.status === 'pending'
                                  ? t.statusPending
                                  : t.statusCancelled}
                            </p>
                          </div>

                          {/* Next payment date */}
                          {billing?.nextPaymentDate && !billing.cancelAtPeriodEnd && (
                            <div>
                              <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                                {t.nextPayment}
                              </p>
                              <p className="text-white text-sm font-medium">
                                {new Date(billing.nextPaymentDate).toLocaleDateString(
                                  da ? 'da-DK' : 'en-GB',
                                  { day: 'numeric', month: 'long', year: 'numeric' }
                                )}
                              </p>
                            </div>
                          )}

                          {/* Payment method */}
                          {billing?.cardLast4 && (
                            <div>
                              <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                                {t.paymentMethod}
                              </p>
                              <p className="text-white text-sm font-medium flex items-center gap-1.5">
                                <CreditCard size={14} className="text-slate-400" />
                                {(billing.cardBrand ?? 'card').charAt(0).toUpperCase() +
                                  (billing.cardBrand ?? 'card').slice(1)}{' '}
                                •••• {billing.cardLast4}
                              </p>
                            </div>
                          )}

                          {/* Approved date */}
                          {subscription.approvedAt && (
                            <div>
                              <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                                {t.approvedOn}
                              </p>
                              <p className="text-white text-sm font-medium">
                                {new Date(subscription.approvedAt).toLocaleDateString(
                                  da ? 'da-DK' : 'en-GB',
                                  { day: 'numeric', month: 'long', year: 'numeric' }
                                )}
                              </p>
                            </div>
                          )}

                          {/* AI */}
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                              AI
                            </p>
                            <p className="text-white text-sm font-medium">
                              {plan.aiEnabled
                                ? plan.aiTokensPerMonth === -1
                                  ? da
                                    ? 'Ubegrænset'
                                    : 'Unlimited'
                                  : `${formatTokens(plan.aiTokensPerMonth)} tokens/md`
                                : t.notIncluded}
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Cancellation pending banner */}
                      {(billing?.cancelAtPeriodEnd || subscription.cancelAtPeriodEnd) && (
                        <div className="flex items-center gap-3 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
                          <AlertTriangle size={18} className="text-amber-400 shrink-0" />
                          <p className="text-amber-300 text-sm">
                            {t.cancelPending}{' '}
                            {new Date(
                              billing?.nextPaymentDate ?? subscription.cancelAt ?? ''
                            ).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
                              day: 'numeric',
                              month: 'long',
                              year: 'numeric',
                            })}
                          </p>
                        </div>
                      )}

                      {/* AI token usage (if AI enabled) */}
                      {plan.aiEnabled && plan.aiTokensPerMonth > 0 && (
                        <div className="bg-slate-800/40 rounded-xl p-4">
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-slate-400 text-xs font-medium">{t.aiUsage}</p>
                            <p className="text-white text-xs font-semibold">
                              {formatTokens(subscription.tokensUsedThisMonth)} /{' '}
                              {formatTokens(plan.aiTokensPerMonth)}
                            </p>
                          </div>
                          <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${
                                subscription.tokensUsedThisMonth / plan.aiTokensPerMonth > 0.9
                                  ? 'bg-red-500'
                                  : subscription.tokensUsedThisMonth / plan.aiTokensPerMonth > 0.7
                                    ? 'bg-amber-500'
                                    : 'bg-blue-500'
                              }`}
                              style={{
                                width: `${Math.min(100, (subscription.tokensUsedThisMonth / plan.aiTokensPerMonth) * 100)}%`,
                              }}
                            />
                          </div>
                        </div>
                      )}

                      {/* Pending warning */}
                      {subscription.status === 'pending' && (
                        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3">
                          <p className="text-amber-300 text-sm">{t.pendingWarning}</p>
                        </div>
                      )}

                      {/* Payment failed warning */}
                      {subscription.status === ('payment_failed' as string) && (
                        <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
                          <p className="text-red-300 text-sm">{t.paymentFailed}</p>
                        </div>
                      )}

                      {/* Manage billing button — only for users who have already paid via Stripe */}
                      {subscription.planId !== 'demo' &&
                        subscription.status === 'active' &&
                        subscription.isPaid && (
                          <button
                            onClick={handlePortal}
                            disabled={portalLoading}
                            className="flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-slate-700/60 hover:bg-slate-700 disabled:opacity-50 text-white text-sm font-medium rounded-xl border border-slate-600/40 transition-colors"
                          >
                            {portalLoading ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <ExternalLink size={14} />
                            )}
                            {t.manageBilling}
                          </button>
                        )}

                      {/* Cancel subscription success banner */}
                      {cancelSuccess && (
                        <div className="flex items-center gap-3 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
                          <AlertTriangle size={18} className="text-amber-400 shrink-0" />
                          <p className="text-amber-300 text-sm">
                            {t.cancelledAt} {cancelSuccess}.
                          </p>
                        </div>
                      )}

                      {/* Cancel subscription — only for paid active subscriptions */}
                      {subscription.planId !== 'demo' &&
                        subscription.status === 'active' &&
                        subscription.isPaid && (
                          <>
                            {!cancelConfirmOpen ? (
                              <button
                                onClick={() => setCancelConfirmOpen(true)}
                                className="text-red-400/60 hover:text-red-400 text-xs font-medium transition-colors mt-1"
                              >
                                {t.cancelSubscription}
                              </button>
                            ) : (
                              <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4 space-y-3">
                                <p className="text-white text-sm font-semibold">
                                  {t.cancelConfirmTitle}
                                </p>
                                <p className="text-slate-400 text-xs">{t.cancelConfirmBody}</p>
                                <div className="flex items-center gap-3">
                                  <button
                                    onClick={handleCancelSubscription}
                                    disabled={cancelLoading}
                                    className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
                                  >
                                    {cancelLoading && (
                                      <Loader2 size={12} className="animate-spin" />
                                    )}
                                    {t.cancelConfirmButton}
                                  </button>
                                  <button
                                    onClick={() => setCancelConfirmOpen(false)}
                                    className="px-4 py-2 bg-slate-700/60 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-lg transition-colors"
                                  >
                                    {t.cancelKeep}
                                  </button>
                                </div>
                              </div>
                            )}
                          </>
                        )}

                      {/* Member since */}
                      <p className="text-slate-600 text-xs">
                        {t.memberSince}{' '}
                        {new Date(subscription.createdAt).toLocaleDateString(
                          lang === 'da' ? 'da-DK' : 'en-GB',
                          {
                            day: 'numeric',
                            month: 'long',
                            year: 'numeric',
                          }
                        )}
                      </p>
                    </div>
                  );
                })()}
              </div>
            ) : (
              <div className="text-center py-16">
                <CreditCard size={32} className="mx-auto mb-3 text-slate-600" />
                <p className="text-slate-400 text-sm mb-1">{t.noSub}</p>
                <p className="text-slate-500 text-xs max-w-sm mx-auto">{t.noSubHint}</p>
              </div>
            )}

            {/* Available plans */}
            <div>
              <h3 className="text-slate-400 text-sm font-semibold uppercase tracking-wider mb-3">
                {t.availablePlans}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {availablePlans.map((plan) => {
                  const isActive =
                    subscription?.planId === plan.id && subscription?.status === 'active';
                  const isSoldOut =
                    plan.maxSales != null && (plan.salesCount ?? 0) >= plan.maxSales;
                  const remaining =
                    plan.maxSales != null ? plan.maxSales - (plan.salesCount ?? 0) : null;
                  const showRemaining = remaining != null && remaining > 0 && remaining <= 10;
                  return (
                    <div
                      key={plan.id}
                      className={`bg-white/5 border rounded-2xl p-5 transition-all ${
                        isActive
                          ? 'border-blue-500/40 bg-blue-500/5'
                          : isSoldOut
                            ? 'border-white/5 opacity-60'
                            : 'border-white/8 hover:border-slate-600'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-white font-semibold text-sm">
                          {da ? plan.nameDa : plan.nameEn}
                        </p>
                        <div className="flex items-center gap-2">
                          {isSoldOut && !isActive && (
                            <span className="bg-red-500/20 text-red-400 border border-red-500/30 px-2 py-0.5 rounded-full text-[10px] font-bold">
                              {t.soldOut}
                            </span>
                          )}
                          {showRemaining && !isActive && !isSoldOut && (
                            <span className="bg-amber-500/20 text-amber-400 border border-amber-500/30 px-2 py-0.5 rounded-full text-[10px] font-bold">
                              {remaining} {t.spotsLeft}
                            </span>
                          )}
                          {isActive && (
                            <span className="bg-blue-500/20 text-blue-400 border border-blue-500/30 px-2 py-0.5 rounded-full text-[10px] font-bold">
                              {t.current}
                            </span>
                          )}
                        </div>
                      </div>
                      <p className="text-slate-400 text-xs mb-3">
                        {da ? plan.descDa : plan.descEn}
                      </p>
                      <p className="text-white text-lg font-bold">
                        {plan.priceDkk === 0 ? t.free : `${plan.priceDkk} kr`}
                        {plan.priceDkk > 0 && (
                          <span className="text-slate-500 text-xs font-normal">/md</span>
                        )}
                      </p>
                      <ul className="mt-3 space-y-1.5">
                        <li className="flex items-center gap-2 text-xs text-slate-400">
                          <CheckCircle size={12} className="text-emerald-400 shrink-0" />
                          {t.unlimitedSearches}
                        </li>
                        <li
                          className={`flex items-center gap-2 text-xs ${plan.aiEnabled ? 'text-slate-400' : 'text-slate-600'}`}
                        >
                          {plan.aiEnabled ? (
                            <CheckCircle size={12} className="text-emerald-400 shrink-0" />
                          ) : (
                            <span className="w-3 h-3 rounded-full border border-slate-600 shrink-0" />
                          )}
                          {plan.aiEnabled
                            ? `AI — ${formatTokens(plan.aiTokensPerMonth)} tokens/md`
                            : t.noAI}
                        </li>
                        {plan.requiresApproval && (
                          <li className="flex items-center gap-2 text-xs text-amber-400">
                            <Clock size={12} className="shrink-0" />
                            {t.requiresApproval}
                          </li>
                        )}
                      </ul>

                      {/* Switch plan button — show for non-current paid plans, or free plans without approval */}
                      {!isActive &&
                        !isSoldOut &&
                        (plan.priceDkk > 0 || !plan.requiresApproval) &&
                        (() => {
                          const currentPlanPrice =
                            availablePlans.find((p) => p.id === subscription?.planId)?.priceDkk ??
                            0;
                          const isUpgrade = plan.priceDkk > currentPlanPrice;
                          return (
                            <button
                              onClick={() => handleCheckout(plan.id)}
                              disabled={checkoutLoading === plan.id}
                              className={`mt-4 flex items-center justify-center gap-2 w-full px-4 py-2.5 disabled:opacity-50 text-white text-sm font-medium rounded-xl transition-colors ${
                                isUpgrade
                                  ? 'bg-blue-600 hover:bg-blue-500'
                                  : 'bg-slate-700 hover:bg-slate-600'
                              }`}
                            >
                              {checkoutLoading === plan.id ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Zap size={14} />
                              )}
                              {isUpgrade ? t.upgrade : t.downgrade}
                            </button>
                          );
                        })()}
                      {/* Sold out button (disabled) */}
                      {!isActive && isSoldOut && (plan.priceDkk > 0 || !plan.requiresApproval) && (
                        <button
                          disabled
                          className="mt-4 flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-slate-800 text-slate-500 text-sm font-medium rounded-xl cursor-not-allowed"
                        >
                          {t.soldOut}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-slate-600 text-xs mt-4 text-center">{t.contactChange}</p>
            </div>
          </div>
        )}

        {/* ═══ Sikkerhed tab ═══ */}
        {tab === 'sikkerhed' && <SecuritySettingsPage />}
      </div>
    </div>
  );
}
