'use client';

/**
 * Admin brugeradministration — /dashboard/admin/users
 *
 * Viser alle registrerede brugere og deres abonnementsstatus.
 * Admin kan:
 *   - Godkende / afvise demo-abonnementer
 *   - Aktivere / deaktivere brugere
 *   - Ændre abonnementsplan
 *   - Tildele ekstra AI-tokens
 *   - Nulstille månedligt tokenforbrug
 *   - Oprette nye brugere
 *   - Slette brugere
 *
 * Kun tilgængelig for admin-brugere (app_metadata.isAdmin).
 * Alle data læses/skrives direkte til Supabase — ingen localStorage.
 *
 * @see app/api/admin/users/route.ts — user CRUD API
 * @see app/api/admin/subscription/route.ts — subscription mutations API
 */

import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Users,
  CheckCircle,
  XCircle,
  Clock,
  Shield,
  Crown,
  Zap,
  AlertTriangle,
  X,
  Plus,
  RotateCcw,
  ChevronDown,
  Coins,
  Trash2,
  BarChart3,
  CreditCard,
  Settings,
  Search,
  Bot,
  ShieldCheck,
  Wrench,
  Activity,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import {
  PLANS,
  PLAN_LIST,
  resolvePlan,
  formatTokens,
  type SubStatus,
  type PlanId,
} from '@/app/lib/subscriptions';

// ─── Types ──────────────────────────────────────────────────────────────────

/** User from the admin API — includes subscription from Supabase app_metadata */
interface AdminUser {
  id: string;
  email: string;
  fullName: string;
  createdAt: string;
  lastSignIn: string | null;
  emailConfirmed: boolean;
  isAdmin: boolean;
  subscription: {
    planId: PlanId;
    status: SubStatus;
    createdAt: string;
    approvedAt: string | null;
    tokensUsedThisMonth: number;
    periodStart: string;
    bonusTokens: number;
    isPaid?: boolean;
  } | null;
}

// ─── Helper components ──────────────────────────────────────────────────────

/**
 * Status badge component for subscription status.
 *
 * @param status - Subscription status
 * @param da - Whether to use Danish labels
 */
function StatusBadge({ status, da }: { status: SubStatus; da: boolean }) {
  const config: Record<SubStatus, { label: string; color: string; icon: React.ReactNode }> = {
    pending: {
      label: da ? 'Afventer' : 'Pending',
      color: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
      icon: <Clock size={12} />,
    },
    active: {
      label: da ? 'Aktiv' : 'Active',
      color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
      icon: <CheckCircle size={12} />,
    },
    cancelled: {
      label: da ? 'Deaktiveret' : 'Deactivated',
      color: 'bg-red-500/20 text-red-400 border-red-500/30',
      icon: <XCircle size={12} />,
    },
    expired: {
      label: da ? 'Udlobet' : 'Expired',
      color: 'bg-slate-500/20 text-slate-400 border-slate-500/30',
      icon: <AlertTriangle size={12} />,
    },
    // BIZZ-541: payment-problem states — separate labels + warning colors
    past_due: {
      label: da ? 'Betaling fejlet (grace)' : 'Payment failed (grace)',
      color: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
      icon: <AlertTriangle size={12} />,
    },
    payment_failed: {
      label: da ? 'Betaling fejlet' : 'Payment failed',
      color: 'bg-red-500/20 text-red-400 border-red-500/30',
      icon: <AlertTriangle size={12} />,
    },
  };
  const c = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${c.color}`}
    >
      {c.icon} {c.label}
    </span>
  );
}

/** Plan icon based on plan type */
function PlanIcon({ planId, size = 14 }: { planId: string; size?: number }) {
  switch (planId) {
    case 'enterprise':
      return <Crown size={size} className="text-purple-400" />;
    case 'professionel':
      return <Zap size={size} className="text-blue-400" />;
    case 'basis':
      return <Shield size={size} className="text-slate-400" />;
    default:
      return <Clock size={size} className="text-amber-400" />;
  }
}

// ─── Admin API helpers ──────────────────────────────────────────────────────

/**
 * Call the admin subscription API to perform an action.
 * All mutations go directly to Supabase app_metadata.
 */
async function adminAction(
  email: string,
  action: string,
  data?: Record<string, unknown>
): Promise<boolean> {
  try {
    const res = await fetch('/api/admin/subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, action, ...data }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── User detail panel ──────────────────────────────────────────────────────

/**
 * User detail panel — slide-out panel for editing a user's subscription.
 * All actions are performed directly on Supabase via the admin API.
 * Wrapped in React.memo because it receives onClose/onRefresh callbacks as props.
 *
 * @param user - The user to edit
 * @param da - Whether to use Danish labels
 * @param onClose - Close handler
 * @param onRefresh - Refresh data handler
 */
const UserDetailPanel = memo(function UserDetailPanel({
  user,
  da,
  onClose,
  onRefresh,
  allPlans,
}: {
  user: AdminUser;
  da: boolean;
  onClose: () => void;
  onRefresh: () => void;
  allPlans: typeof PLAN_LIST;
}) {
  const sub = user.subscription;
  const plan = sub ? resolvePlan(sub.planId) : PLANS.demo;
  const isUnlimited = plan.aiTokensPerMonth === -1;
  const totalTokens = isUnlimited ? -1 : plan.aiTokensPerMonth + (sub?.bonusTokens ?? 0);
  const usagePercent = isUnlimited
    ? 0
    : totalTokens > 0
      ? Math.min(100, ((sub?.tokensUsedThisMonth ?? 0) / totalTokens) * 100)
      : 0;

  const [showPlanPicker, setShowPlanPicker] = useState(false);
  const [tokenAmount, setTokenAmount] = useState('');
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);

  /** Close panel on Escape key */
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  /**
   * Focus trap: Tab/Shift+Tab cycles through focusable children only.
   * First focusable element receives focus on mount.
   */
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = panel.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', trap);
    first?.focus();
    return () => document.removeEventListener('keydown', trap);
  }, []);

  /** Execute an admin action and refresh — awaits refresh so loading state stays active until data is fresh */
  const doAction = async (action: string, data?: Record<string, unknown>) => {
    setActionLoading(true);
    await adminAction(user.email, action, data);
    await onRefresh();
    setActionLoading(false);
  };

  /** Handle plan change — 'none' removes the subscription entirely */
  const handlePlanChange = (planId: string) => {
    if (planId === 'none') {
      doAction('removePlan', {});
    } else {
      doAction('changePlan', { planId });
    }
    setShowPlanPicker(false);
  };

  /** Handle status toggle */
  const handleToggleStatus = () => {
    const newStatus = sub?.status === 'active' ? 'cancelled' : 'active';
    doAction('changeStatus', { status: newStatus });
  };

  /** Handle approve */
  const handleApprove = () => doAction('approve');

  /** Handle reject */
  const handleReject = () => doAction('reject');

  /** Handle adding bonus tokens */
  const handleAddTokens = () => {
    const amount = parseInt(tokenAmount, 10);
    if (!amount || amount <= 0) return;
    doAction('addTokens', { tokens: amount });
    setTokenAmount('');
    setShowTokenInput(false);
  };

  /** Handle resetting token usage */
  const handleResetUsage = () => doAction('resetTokens');

  /** Toggle payment status */
  const handleTogglePaid = () => doAction('markPaid', { isPaid: !sub?.isPaid });

  /** Toggle admin role */
  const handleToggleAdmin = () => doAction('toggleAdmin', { isAdmin: !user.isAdmin });

  if (!sub) {
    return (
      <div className="fixed inset-0 z-50 flex justify-end">
        <div className="absolute inset-0 bg-black/60" onClick={onClose} role="presentation" />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="user-panel-title"
          className="relative w-full max-w-md bg-slate-900 border-l border-slate-700/50 overflow-y-auto"
        >
          <div className="sticky top-0 bg-slate-900/95 backdrop-blur-sm border-b border-slate-700/50 px-6 py-4 flex items-center justify-between z-10">
            <h2 id="user-panel-title" className="text-white font-bold text-base">
              {user.email}
            </h2>
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700/50 rounded-lg transition-colors"
            >
              <X size={18} />
            </button>
          </div>
          <div
            className={`px-6 py-5 space-y-5 ${actionLoading ? 'opacity-60 pointer-events-none' : ''}`}
          >
            <p className="text-slate-400 text-sm">
              {da ? 'Denne bruger har intet abonnement.' : 'This user has no subscription.'}
            </p>

            {/* Assign plan */}
            <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 space-y-3">
              <p className="text-white text-sm font-semibold">
                {da ? 'Tildel plan' : 'Assign plan'}
              </p>
              <div className="space-y-1.5">
                {allPlans.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      doAction('set', {
                        planId: p.id,
                        status: 'active',
                        approvedAt: new Date().toISOString(),
                        isPaid: p.priceDkk === 0,
                      });
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left bg-slate-800/40 hover:bg-slate-800/80 border border-transparent transition-colors"
                  >
                    <PlanIcon planId={p.id} />
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-xs font-medium">{da ? p.nameDa : p.nameEn}</p>
                      <p className="text-slate-500 text-[10px]">
                        {p.priceDkk === 0 ? (da ? 'Gratis' : 'Free') : `${p.priceDkk} kr/md`}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Admin toggle */}
            <button
              onClick={handleToggleAdmin}
              className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                user.isAdmin
                  ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30 hover:bg-purple-500/30'
                  : 'bg-slate-700/60 text-slate-300 border border-slate-600/40 hover:bg-slate-700'
              }`}
            >
              <Shield size={14} />
              {user.isAdmin
                ? da
                  ? 'Fjern admin-rolle'
                  : 'Remove admin role'
                : da
                  ? 'Giv admin-rolle'
                  : 'Grant admin role'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} role="presentation" />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-panel-title"
        className="relative w-full max-w-md bg-slate-900 border-l border-slate-700/50 overflow-y-auto"
      >
        {/* Header */}
        <div className="sticky top-0 bg-slate-900/95 backdrop-blur-sm border-b border-slate-700/50 px-6 py-4 flex items-center justify-between z-10">
          <h2 id="user-panel-title" className="text-white font-bold text-base">
            {da ? 'Rediger bruger' : 'Edit user'}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700/50 rounded-lg transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div
          className={`px-6 py-5 space-y-6 ${actionLoading ? 'opacity-60 pointer-events-none' : ''}`}
        >
          {/* ─── User info ─── */}
          <div>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 bg-blue-500/10 rounded-xl flex items-center justify-center">
                <Users size={18} className="text-blue-400" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-white font-semibold text-sm truncate">{user.email}</p>
                <p className="text-slate-500 text-xs">
                  {user.fullName && <span className="text-slate-400">{user.fullName} · </span>}
                  {da ? 'Oprettet' : 'Created'}{' '}
                  {new Date(user.createdAt).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </p>
              </div>
              {user.isAdmin && (
                <span className="bg-blue-500/20 text-blue-400 border border-blue-500/30 px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0">
                  Admin
                </span>
              )}
            </div>
          </div>

          {/* ─── Status section ─── */}
          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-slate-400 text-xs font-medium uppercase tracking-wider">Status</p>
              <StatusBadge status={sub.status as SubStatus} da={da} />
            </div>

            {/* Pending — approve/reject buttons */}
            {sub.status === 'pending' && (
              <div className="flex gap-2">
                <button
                  onClick={handleApprove}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg transition-colors"
                >
                  <CheckCircle size={13} />
                  {da ? 'Godkend' : 'Approve'}
                </button>
                <button
                  onClick={handleReject}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-red-600/20 hover:bg-red-600/40 text-red-400 text-xs font-medium rounded-lg transition-colors border border-red-500/30"
                >
                  <XCircle size={13} />
                  {da ? 'Afvis' : 'Reject'}
                </button>
              </div>
            )}

            {/* Active / Cancelled — toggle button */}
            {(sub.status === 'active' || sub.status === 'cancelled') && (
              <button
                onClick={handleToggleStatus}
                className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                  sub.status === 'active'
                    ? 'bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-500/30'
                    : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                }`}
              >
                {sub.status === 'active' ? (
                  <>
                    <XCircle size={13} /> {da ? 'Deaktiver bruger' : 'Deactivate user'}
                  </>
                ) : (
                  <>
                    <CheckCircle size={13} /> {da ? 'Aktiver bruger' : 'Activate user'}
                  </>
                )}
              </button>
            )}

            {/* Payment status toggle */}
            <button
              onClick={handleTogglePaid}
              disabled={actionLoading}
              className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                sub.isPaid
                  ? 'bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-400 border border-emerald-500/30'
                  : 'bg-amber-600/20 hover:bg-amber-600/40 text-amber-400 border border-amber-500/30'
              }`}
            >
              <CreditCard size={13} />
              {sub.isPaid
                ? da
                  ? 'Betalt ✓'
                  : 'Paid ✓'
                : da
                  ? 'Markér som betalt'
                  : 'Mark as paid'}
            </button>

            {/* Admin role toggle */}
            <button
              onClick={handleToggleAdmin}
              disabled={actionLoading}
              className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                user.isAdmin
                  ? 'bg-purple-600/20 hover:bg-purple-600/40 text-purple-400 border border-purple-500/30'
                  : 'bg-slate-600/20 hover:bg-slate-600/40 text-slate-400 border border-slate-500/30'
              }`}
            >
              <Shield size={13} />
              {user.isAdmin ? (da ? 'Admin ✓' : 'Admin ✓') : da ? 'Gør til admin' : 'Make admin'}
            </button>

            {sub.approvedAt && (
              <p className="text-slate-600 text-[11px]">
                {da ? 'Godkendt' : 'Approved'}{' '}
                {new Date(sub.approvedAt).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}
              </p>
            )}
          </div>

          {/* ─── Plan section ─── */}
          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-slate-400 text-xs font-medium uppercase tracking-wider">
                {da ? 'Abonnement' : 'Plan'}
              </p>
              <button
                onClick={() => setShowPlanPicker(!showPlanPicker)}
                className="flex items-center gap-1 text-blue-400 hover:text-blue-300 text-xs font-medium transition-colors"
              >
                {da ? 'Skift plan' : 'Change plan'}
                <ChevronDown
                  size={12}
                  className={`transition-transform ${showPlanPicker ? 'rotate-180' : ''}`}
                />
              </button>
            </div>

            {/* Current plan */}
            <div className="flex items-center gap-3">
              <div
                className={`w-9 h-9 rounded-lg flex items-center justify-center ${
                  plan.id === 'enterprise'
                    ? 'bg-purple-500/10'
                    : plan.id === 'professionel'
                      ? 'bg-blue-500/10'
                      : plan.id === 'basis'
                        ? 'bg-slate-500/10'
                        : 'bg-amber-500/10'
                }`}
              >
                <PlanIcon planId={plan.id} size={16} />
              </div>
              <div>
                <p className="text-white text-sm font-semibold">{da ? plan.nameDa : plan.nameEn}</p>
                <p className="text-slate-500 text-xs">
                  {plan.priceDkk === 0 ? (da ? 'Gratis' : 'Free') : `${plan.priceDkk} kr/md`}
                </p>
              </div>
            </div>

            {/* Plan picker dropdown */}
            {showPlanPicker && (
              <div className="space-y-1.5 pt-1">
                {/* Remove plan option */}
                <button
                  onClick={() => handlePlanChange('none')}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors bg-red-500/5 hover:bg-red-500/10 border border-red-500/20"
                >
                  <X size={14} className="text-red-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-red-300 text-xs font-medium">
                      {da ? 'Fjern plan' : 'Remove plan'}
                    </p>
                    <p className="text-slate-500 text-[10px]">
                      {da ? 'Fjerner brugerens abonnement' : "Removes the user's subscription"}
                    </p>
                  </div>
                </button>
                {allPlans.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => handlePlanChange(p.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                      p.id === sub.planId
                        ? 'bg-blue-500/10 border border-blue-500/30'
                        : 'bg-slate-800/40 hover:bg-slate-800/80 border border-transparent'
                    }`}
                  >
                    <PlanIcon planId={p.id} />
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-xs font-medium">{da ? p.nameDa : p.nameEn}</p>
                      <p className="text-slate-500 text-[10px]">
                        {p.priceDkk === 0 ? (da ? 'Gratis' : 'Free') : `${p.priceDkk} kr/md`}
                        {p.aiEnabled
                          ? ` · ${p.aiTokensPerMonth === -1 ? (da ? 'Ubegrænset' : 'Unlimited') : formatTokens(p.aiTokensPerMonth) + ' tokens'}`
                          : ''}
                      </p>
                    </div>
                    {p.id === sub.planId && (
                      <CheckCircle size={14} className="text-blue-400 shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ─── AI Tokens section ─── */}
          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-slate-400 text-xs font-medium uppercase tracking-wider">
                AI Tokens
              </p>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setShowTokenInput(!showTokenInput)}
                  className="flex items-center gap-1 text-blue-400 hover:text-blue-300 text-xs font-medium transition-colors"
                >
                  <Plus size={12} />
                  {da ? 'Tildel' : 'Add'}
                </button>
                <span className="text-slate-700">|</span>
                <button
                  onClick={handleResetUsage}
                  className="flex items-center gap-1 text-slate-500 hover:text-slate-300 text-xs font-medium transition-colors"
                >
                  <RotateCcw size={11} />
                  {da ? 'Nulstil' : 'Reset'}
                </button>
              </div>
            </div>

            {/* Token usage bar */}
            {plan.aiEnabled ? (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-white text-sm font-semibold">
                    {formatTokens(sub.tokensUsedThisMonth)}
                    <span className="text-slate-500 font-normal">
                      {isUnlimited ? ' / ∞' : ` / ${formatTokens(totalTokens)}`}
                    </span>
                  </p>
                  {isUnlimited ? (
                    <span className="text-purple-400 text-xs font-medium">∞</span>
                  ) : (
                    <p className="text-slate-500 text-xs">{usagePercent.toFixed(0)}%</p>
                  )}
                </div>
                <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                  {isUnlimited ? (
                    <div className="h-full rounded-full bg-purple-500 w-full" />
                  ) : (
                    <div
                      className={`h-full rounded-full transition-all ${
                        usagePercent > 90
                          ? 'bg-red-500'
                          : usagePercent > 70
                            ? 'bg-amber-500'
                            : 'bg-blue-500'
                      }`}
                      style={{ width: `${usagePercent}%` }}
                    />
                  )}
                </div>

                {/* Breakdown */}
                <div className="mt-2 space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-500">{da ? 'Plan-tokens' : 'Plan tokens'}</span>
                    <span className="text-slate-400">
                      {isUnlimited
                        ? da
                          ? 'Ubegrænset'
                          : 'Unlimited'
                        : formatTokens(plan.aiTokensPerMonth)}
                    </span>
                  </div>
                  {!isUnlimited && (sub.bonusTokens ?? 0) > 0 && (
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-500 flex items-center gap-1">
                        <Coins size={10} className="text-amber-400" />
                        {da ? 'Bonus-tokens' : 'Bonus tokens'}
                      </span>
                      <span className="text-amber-400">+{formatTokens(sub.bonusTokens ?? 0)}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-500">
                      {da ? 'Brugt denne måned' : 'Used this month'}
                    </span>
                    <span className="text-white font-medium">
                      {formatTokens(sub.tokensUsedThisMonth)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-500">{da ? 'Periode start' : 'Period start'}</span>
                    <span className="text-slate-400">
                      {new Date(sub.periodStart).toLocaleDateString(da ? 'da-DK' : 'en-GB')}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-slate-500 text-xs">
                {da ? 'AI er ikke inkluderet i denne plan.' : 'AI is not included in this plan.'}
              </p>
            )}

            {/* Add tokens input */}
            {showTokenInput && (
              <div className="flex gap-2 pt-1">
                <input
                  type="number"
                  min="1"
                  step="1000"
                  value={tokenAmount}
                  onChange={(e) => setTokenAmount(e.target.value)}
                  placeholder={da ? 'Antal tokens...' : 'Number of tokens...'}
                  className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-xs placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddTokens();
                  }}
                  autoFocus
                />
                <button
                  onClick={handleAddTokens}
                  disabled={!tokenAmount || parseInt(tokenAmount, 10) <= 0}
                  className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-xs font-medium rounded-lg transition-colors"
                >
                  {da ? 'Tilføj' : 'Add'}
                </button>
              </div>
            )}

            {/* Quick-add buttons */}
            {showTokenInput && (
              <div className="flex flex-wrap gap-1.5">
                {[5000, 10000, 25000, 50000, 100000].map((amount) => (
                  <button
                    key={amount}
                    onClick={() => {
                      doAction('addTokens', { tokens: amount });
                      setShowTokenInput(false);
                    }}
                    className="px-2.5 py-1 bg-slate-800/60 hover:bg-slate-700 border border-slate-700/50 text-slate-300 text-[10px] font-medium rounded-md transition-colors"
                  >
                    +{formatTokens(amount)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ─── Delete user (danger zone) ─── */}
          {!user.isAdmin && (
            <div className="border border-red-500/20 rounded-xl p-4">
              <p className="text-red-400 text-xs font-medium uppercase tracking-wider mb-2">
                {da ? 'Farezone' : 'Danger zone'}
              </p>
              <button
                onClick={async () => {
                  const confirmed = window.confirm(
                    da
                      ? `Er du sikker på at du vil slette ${user.email} permanent? Dette kan ikke fortrydes.`
                      : `Are you sure you want to permanently delete ${user.email}? This cannot be undone.`
                  );
                  if (!confirmed) return;
                  await fetch('/api/admin/users', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: user.email }),
                  });
                  onClose();
                  onRefresh();
                }}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-red-600/20 hover:bg-red-600/40 text-red-400 text-xs font-medium rounded-lg transition-colors border border-red-500/30"
              >
                <Trash2 size={13} />
                {da ? 'Slet bruger permanent' : 'Delete user permanently'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

// ─── Main page ──────────────────────────────────────────────────────────────

/**
 * Admin user management page.
 *
 * All data is fetched from Supabase via /api/admin/users.
 * All mutations go directly to Supabase via /api/admin/subscription.
 * No localStorage is used — what you see is what the database has.
 */
export default function UsersClient() {
  const router = useRouter();
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  /** Tracks which pending-row action is in flight (email + action, e.g. "foo@bar.com-approve") */
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  /** Add user form state */
  const [showAddUser, setShowAddUser] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newFullName, setNewFullName] = useState('');
  const [newPlan, setNewPlan] = useState<PlanId>('demo');
  const [newStatus, setNewStatus] = useState<'pending' | 'active'>('active');
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  /** Search & filter state */
  const [searchQuery, setSearchQuery] = useState('');
  const [planFilter, setPlanFilter] = useState<string>('all');

  /** All plans (hardcoded + DB custom plans) for plan pickers */
  const [allPlans, setAllPlans] = useState(PLAN_LIST);

  /** Check admin access via API — no localStorage needed */
  useEffect(() => {
    fetch('/api/subscription')
      .then((res) => res.json())
      .then((data) => {
        if (data?.isAdmin) {
          setIsAdmin(true);
        } else {
          setIsAdmin(false);
          router.replace('/dashboard');
        }
      })
      .catch(() => {
        setIsAdmin(false);
        router.replace('/dashboard');
      });

    // Fetch all plans (including custom DB plans)
    fetch('/api/plans')
      .then((res) => res.json())
      .then((plans) => {
        if (Array.isArray(plans) && plans.length > 0) {
          setAllPlans(plans);
        }
      })
      .catch(() => {});
  }, [router]);

  /** Load all users from Supabase via API */
  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/users');
      if (res.ok) {
        const data: AdminUser[] = await res.json();
        setUsers(data);
      }
    } catch {
      // API unavailable
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (isAdmin) refresh();
  }, [refresh, isAdmin]);

  /** Block rendering until admin check completes */
  if (isAdmin === null || isAdmin === false) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <Shield size={32} className="mx-auto mb-3 text-slate-600" />
          <p className="text-slate-400 text-sm">
            {da ? 'Kontrollerer adgang...' : 'Checking access...'}
          </p>
        </div>
      </div>
    );
  }

  /** Selected user for the detail panel */
  const selectedUser = users.find((u) => u.email === selectedEmail) ?? null;

  // Apply search + plan filter
  const q = searchQuery.toLowerCase().trim();
  const filtered = users.filter((u) => {
    // Search filter
    if (q && !u.email.toLowerCase().includes(q) && !u.fullName?.toLowerCase().includes(q)) {
      return false;
    }
    // Plan filter
    if (planFilter === 'none') return !u.subscription;
    if (planFilter !== 'all') return u.subscription?.planId === planFilter;
    return true;
  });

  // Separate filtered users by subscription state
  const withSub = filtered.filter((u) => u.subscription);
  const pending = withSub.filter((u) => u.subscription?.status === 'pending');
  const others = withSub.filter((u) => u.subscription?.status !== 'pending');
  const noSub = filtered.filter((u) => !u.subscription);

  /** Stats */
  const activeCount = withSub.filter((u) => u.subscription?.status === 'active').length;
  const totalTokensUsed = withSub.reduce(
    (sum, u) => sum + (u.subscription?.tokensUsedThisMonth ?? 0),
    0
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ─── Header ─── */}
      <div className="sticky top-0 z-20 px-3 sm:px-6 pt-5 pb-0 border-b border-slate-700/50 bg-slate-900/30 backdrop-blur-sm">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
          >
            <ArrowLeft size={16} /> {da ? 'Tilbage' : 'Back'}
          </button>
        </div>
        <div className="flex items-center gap-3 mb-1">
          <Users size={22} className="text-blue-400" />
          <div>
            <h1 className="text-white text-xl font-bold">
              {da ? 'Brugeradministration' : 'User Management'}
            </h1>
            <p className="text-slate-400 text-sm">
              {da
                ? `${users.length} brugere · ${activeCount} aktive · ${pending.length} afventer · ${noSub.length} uden abonnement`
                : `${users.length} users · ${activeCount} active · ${pending.length} pending · ${noSub.length} no subscription`}
            </p>
          </div>
        </div>

        {/* Tab navigation */}
        <div className="flex gap-1 -mb-px overflow-x-auto mt-4">
          <span className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-blue-500 text-blue-300 font-medium cursor-default">
            <Users size={14} /> {da ? 'Brugere' : 'Users'}
          </span>
          <Link
            href="/dashboard/admin/billing"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
          >
            <CreditCard size={14} /> {da ? 'Fakturering' : 'Billing'}
          </Link>
          <Link
            href="/dashboard/admin/plans"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
          >
            <Settings size={14} /> {da ? 'Planer' : 'Plans'}
          </Link>
          <Link
            href="/dashboard/admin/analytics"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
          >
            <BarChart3 size={14} /> {da ? 'Analyse' : 'Analytics'}
          </Link>
          <Link
            href="/dashboard/admin/ai-media-agents"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap"
          >
            <Bot size={14} /> {da ? 'AI-agenter' : 'AI Agents'}
          </Link>
          <Link
            href="/dashboard/admin/security"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap"
          >
            <ShieldCheck size={14} /> {da ? 'Sikkerhed' : 'Security'}
          </Link>
          <Link
            href="/dashboard/admin/service-manager"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap"
          >
            <Wrench size={14} /> Service Manager
          </Link>
          <Link
            href="/dashboard/admin/service-management"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap"
          >
            <Activity size={14} /> {da ? 'Infrastruktur' : 'Infrastructure'}
          </Link>
        </div>

        {/* Search + plan filter */}
        <div className="flex gap-3 mt-4 items-center">
          <div className="relative flex-1 max-w-xs">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={da ? 'Søg navn eller email…' : 'Search name or email…'}
              className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg pl-9 pr-3 py-2 text-white text-xs placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <select
            value={planFilter}
            onChange={(e) => setPlanFilter(e.target.value)}
            className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-3 py-2 text-white text-xs focus:border-blue-500 focus:outline-none"
          >
            <option value="all">{da ? 'Alle planer' : 'All plans'}</option>
            <option value="none">{da ? 'Uden plan' : 'No plan'}</option>
            {allPlans.map((p) => (
              <option key={p.id} value={p.id}>
                {da ? p.nameDa : p.nameEn}
              </option>
            ))}
          </select>
        </div>

        {/* Quick stats + add user button */}
        <div className="flex gap-3 mt-3">
          <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl px-3 py-2.5 flex-1">
            <p className="text-slate-500 text-xs uppercase tracking-wide">
              {da ? 'Aktive' : 'Active'}
            </p>
            <p className="text-emerald-400 text-sm font-bold">{activeCount}</p>
          </div>
          <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl px-3 py-2.5 flex-1">
            <p className="text-slate-500 text-xs uppercase tracking-wide">
              {da ? 'Afventer' : 'Pending'}
            </p>
            <p className="text-amber-400 text-sm font-bold">{pending.length}</p>
          </div>
          <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl px-3 py-2.5 flex-1">
            <p className="text-slate-500 text-xs uppercase tracking-wide">
              {da ? 'Tokens brugt' : 'Tokens used'}
            </p>
            <p className="text-blue-400 text-sm font-bold">{formatTokens(totalTokensUsed)}</p>
          </div>
          <button
            onClick={() => setShowAddUser(!showAddUser)}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 border border-blue-500/60 text-white text-sm font-medium rounded-lg transition-colors shrink-0 self-center"
          >
            <Plus size={14} />
            {da ? 'Tilføj bruger' : 'Add user'}
          </button>
        </div>

        {/* Add user form — creates user in Supabase Auth + sets subscription */}
        {showAddUser && (
          <div className="mt-3 bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 space-y-3">
            <p className="text-white text-sm font-semibold">
              {da
                ? 'Opret ny bruger (via admin — omgår rate-limits)'
                : 'Create new user (via admin — bypasses rate limits)'}
            </p>
            {createError && (
              <p className="text-red-400 text-xs bg-red-600/10 border border-red-500/30 rounded-lg px-3 py-2">
                {createError}
              </p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <input
                type="email"
                value={newEmail}
                onChange={(e) => {
                  setNewEmail(e.target.value);
                  setCreateError(null);
                }}
                placeholder={da ? 'bruger@email.dk' : 'user@email.com'}
                className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-xs placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
                autoFocus
              />
              <input
                type="text"
                value={newFullName}
                onChange={(e) => setNewFullName(e.target.value)}
                placeholder={da ? 'Fulde navn (valgfrit)' : 'Full name (optional)'}
                className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-xs placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
              />
              <input
                type="text"
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  setCreateError(null);
                }}
                placeholder={da ? 'Adgangskode (min. 6 tegn)' : 'Password (min. 6 chars)'}
                className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-xs placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
              />
              <div className="flex gap-2">
                <select
                  value={newPlan}
                  onChange={(e) => setNewPlan(e.target.value as PlanId)}
                  className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-2 py-2 text-white text-xs focus:border-blue-500 focus:outline-none"
                >
                  {allPlans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {da ? p.nameDa : p.nameEn}
                    </option>
                  ))}
                </select>
                <select
                  value={newStatus}
                  onChange={(e) => setNewStatus(e.target.value as 'pending' | 'active')}
                  className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-2 py-2 text-white text-xs focus:border-blue-500 focus:outline-none"
                >
                  <option value="active">{da ? 'Aktiv' : 'Active'}</option>
                  <option value="pending">{da ? 'Afventer' : 'Pending'}</option>
                </select>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setShowAddUser(false);
                  setCreateError(null);
                }}
                className="px-3 py-2 text-slate-400 hover:text-white text-xs font-medium rounded-lg transition-colors"
              >
                {da ? 'Annuller' : 'Cancel'}
              </button>
              <button
                onClick={async () => {
                  if (!newEmail.includes('@')) {
                    setCreateError(da ? 'Ugyldig email' : 'Invalid email');
                    return;
                  }
                  if (newPassword.length < 6) {
                    setCreateError(
                      da
                        ? 'Adgangskode skal være mindst 6 tegn'
                        : 'Password must be at least 6 characters'
                    );
                    return;
                  }

                  setCreateLoading(true);
                  setCreateError(null);

                  const now = new Date().toISOString();
                  const email = newEmail.trim().toLowerCase();
                  const subscription = {
                    planId: newPlan,
                    status: newStatus,
                    createdAt: now,
                    approvedAt: newStatus === 'active' ? now : null,
                    tokensUsedThisMonth: 0,
                    periodStart: now,
                    bonusTokens: 0,
                  };

                  try {
                    // Create user in Supabase Auth via admin API
                    const res = await fetch('/api/admin/users', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        email,
                        password: newPassword,
                        fullName: newFullName.trim() || undefined,
                        subscription,
                      }),
                    });
                    const data = await res.json();

                    if (!res.ok) {
                      setCreateError(data.error || 'Unknown error');
                      setCreateLoading(false);
                      return;
                    }

                    // Send notification email (best-effort)
                    fetch('/api/notify-signup', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        fullName: newFullName.trim() || email.split('@')[0],
                        email,
                        planId: newPlan,
                        status: newStatus,
                      }),
                    }).catch(() => {});

                    setNewEmail('');
                    setNewPassword('');
                    setNewFullName('');
                    setShowAddUser(false);
                    refresh();
                  } catch {
                    setCreateError(da ? 'Netværksfejl' : 'Network error');
                  }
                  setCreateLoading(false);
                }}
                disabled={createLoading || !newEmail.includes('@') || newPassword.length < 6}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-xs font-medium rounded-lg transition-colors"
              >
                {createLoading
                  ? da
                    ? 'Opretter…'
                    : 'Creating…'
                  : da
                    ? 'Opret bruger'
                    : 'Create user'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ─── Content ─── */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-5 space-y-6">
        {/* Pending approvals section */}
        {pending.length > 0 && (
          <div>
            <h2 className="text-white font-semibold text-base mb-4 flex items-center gap-2">
              <Clock size={16} className="text-amber-400" />
              {da ? 'Afventer godkendelse' : 'Pending approval'}
              <span className="bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded-full text-[10px] font-bold">
                {pending.length}
              </span>
            </h2>
            <div className="space-y-2">
              {pending.map((u) => {
                const plan = resolvePlan(u.subscription!.planId);
                return (
                  <div
                    key={u.email}
                    onClick={() => setSelectedEmail(u.email)}
                    className="bg-slate-800/40 border border-amber-500/30 rounded-xl px-5 py-4 flex items-center justify-between gap-4 cursor-pointer hover:bg-slate-800/60 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-white font-semibold text-sm truncate">{u.email}</p>
                        <StatusBadge status={u.subscription!.status as SubStatus} da={da} />
                      </div>
                      <div className="flex items-center gap-2 text-xs text-slate-400">
                        <PlanIcon planId={u.subscription!.planId} />
                        <span>{da ? plan.nameDa : plan.nameEn}</span>
                        <span className="text-slate-600">·</span>
                        <span>
                          {da ? 'Oprettet' : 'Created'}{' '}
                          {new Date(u.createdAt).toLocaleDateString(da ? 'da-DK' : 'en-GB')}
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          const key = `${u.email}-approve`;
                          setPendingAction(key);
                          await adminAction(u.email, 'approve');
                          await refresh();
                          setPendingAction(null);
                        }}
                        disabled={pendingAction !== null}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg transition-colors"
                      >
                        {pendingAction === `${u.email}-approve` ? (
                          <RotateCcw size={13} className="animate-spin" />
                        ) : (
                          <CheckCircle size={13} />
                        )}
                        {da ? 'Godkend' : 'Approve'}
                      </button>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          const key = `${u.email}-reject`;
                          setPendingAction(key);
                          await adminAction(u.email, 'reject');
                          await refresh();
                          setPendingAction(null);
                        }}
                        disabled={pendingAction !== null}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/20 hover:bg-red-600/40 disabled:opacity-50 disabled:cursor-not-allowed text-red-400 text-xs font-medium rounded-lg transition-colors border border-red-500/30"
                      >
                        {pendingAction === `${u.email}-reject` ? (
                          <RotateCcw size={13} className="animate-spin" />
                        ) : (
                          <XCircle size={13} />
                        )}
                        {da ? 'Afvis' : 'Reject'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* All users section */}
        <div>
          <h2 className="text-white font-semibold text-base mb-4 flex items-center gap-2">
            <Users size={16} className="text-blue-400" />
            {da ? 'Alle brugere' : 'All users'}
          </h2>
          {others.length === 0 && pending.length === 0 ? (
            <div className="text-center py-16">
              <Users size={32} className="mx-auto mb-3 text-slate-600" />
              <p className="text-slate-400 text-sm">
                {da ? 'Ingen registrerede brugere endnu.' : 'No registered users yet.'}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {others.map((u) => {
                const sub = u.subscription!;
                const plan = resolvePlan(sub.planId);
                const isUnlim = plan.aiTokensPerMonth === -1;
                const totalT = isUnlim ? -1 : plan.aiTokensPerMonth + (sub.bonusTokens ?? 0);
                const usedPct = isUnlim
                  ? 0
                  : totalT > 0
                    ? (sub.tokensUsedThisMonth / totalT) * 100
                    : 0;
                return (
                  <div
                    key={u.email}
                    onClick={() => setSelectedEmail(u.email)}
                    className="bg-slate-800/40 border border-slate-700/40 rounded-xl px-5 py-4 flex items-center justify-between gap-4 cursor-pointer hover:bg-slate-800/60 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-white text-sm font-medium truncate">{u.email}</p>
                        {u.isAdmin && (
                          <span className="bg-purple-500/20 text-purple-400 border border-purple-500/30 px-1.5 py-0.5 rounded-full text-[10px] font-bold">
                            Admin
                          </span>
                        )}
                        <StatusBadge status={sub.status as SubStatus} da={da} />
                        {plan.priceDkk > 0 && !sub.isPaid && (
                          <span className="bg-amber-500/20 text-amber-400 border border-amber-500/30 px-1.5 py-0.5 rounded-full text-[10px] font-bold">
                            {da ? 'Ikke betalt' : 'Unpaid'}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-slate-500 mt-0.5">
                        <PlanIcon planId={sub.planId} />
                        <span>{da ? plan.nameDa : plan.nameEn}</span>
                        {plan.priceDkk > 0 && (
                          <>
                            <span className="text-slate-600">·</span>
                            <span>{plan.priceDkk} kr/md</span>
                          </>
                        )}
                        <span className="text-slate-600">·</span>
                        <span>
                          {da ? 'Siden' : 'Since'}{' '}
                          {new Date(u.createdAt).toLocaleDateString(da ? 'da-DK' : 'en-GB')}
                        </span>
                      </div>
                    </div>

                    {/* Token mini-bar (if AI plan) */}
                    {plan.aiEnabled && (
                      <div className="w-32 shrink-0">
                        <p className="text-slate-500 text-[10px] text-right mb-1">
                          {isUnlim
                            ? `${formatTokens(sub.tokensUsedThisMonth)} / ∞`
                            : `${formatTokens(sub.tokensUsedThisMonth)} / ${formatTokens(totalT)}`}
                        </p>
                        <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                          {isUnlim ? (
                            <div className="h-full rounded-full bg-purple-500 w-full" />
                          ) : (
                            <div
                              className={`h-full rounded-full ${
                                usedPct > 90
                                  ? 'bg-red-500'
                                  : usedPct > 70
                                    ? 'bg-amber-500'
                                    : 'bg-blue-500'
                              }`}
                              style={{ width: `${Math.min(100, usedPct)}%` }}
                            />
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Unsubscribed users from Supabase Auth */}
        {noSub.length > 0 && (
          <div>
            <h2 className="text-white font-semibold text-base mb-4 flex items-center gap-2">
              <AlertTriangle size={16} className="text-red-400" />
              {da ? 'Uden abonnement' : 'No subscription'}
              <span className="bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded-full text-[10px] font-bold">
                {noSub.length}
              </span>
            </h2>
            <div className="space-y-2">
              {noSub.map((u) => (
                <div
                  key={u.id}
                  onClick={() => setSelectedEmail(u.email)}
                  className="bg-slate-800/40 border border-red-500/30 rounded-xl px-5 py-4 flex items-center justify-between gap-4 cursor-pointer hover:bg-slate-800/60 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="text-white font-semibold text-sm truncate">{u.email}</p>
                      {u.fullName && (
                        <span className="text-slate-500 text-xs truncate">({u.fullName})</span>
                      )}
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-red-500/20 text-red-400 border-red-500/30">
                        <XCircle size={12} /> {da ? 'Intet abonnement' : 'No subscription'}
                      </span>
                      {!u.emailConfirmed && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-slate-500/20 text-slate-400 border-slate-500/30">
                          {da ? 'Email ikke bekræftet' : 'Email not confirmed'}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span>
                        {da ? 'Oprettet' : 'Created'}{' '}
                        {new Date(u.createdAt).toLocaleDateString(da ? 'da-DK' : 'en-GB')}
                      </span>
                      {u.lastSignIn && (
                        <>
                          <span className="text-slate-600">·</span>
                          <span>
                            {da ? 'Sidst logget ind' : 'Last sign in'}{' '}
                            {new Date(u.lastSignIn).toLocaleDateString(da ? 'da-DK' : 'en-GB')}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={async () => {
                        const confirmed = window.confirm(
                          da
                            ? `Er du sikker på at du vil slette ${u.email} permanent?`
                            : `Are you sure you want to permanently delete ${u.email}?`
                        );
                        if (!confirmed) return;
                        await fetch('/api/admin/users', {
                          method: 'DELETE',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ email: u.email }),
                        });
                        refresh();
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/20 hover:bg-red-600/40 text-red-400 text-xs font-medium rounded-lg transition-colors border border-red-500/30"
                    >
                      <Trash2 size={13} />
                      {da ? 'Slet' : 'Delete'}
                    </button>
                    <button
                      onClick={async () => {
                        await adminAction(u.email, 'set', {
                          planId: 'demo',
                          status: 'pending',
                          createdAt: u.createdAt,
                        });
                        refresh();
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600/20 hover:bg-amber-600/40 text-amber-400 text-xs font-medium rounded-lg transition-colors border border-amber-500/30"
                    >
                      <Clock size={13} />
                      {da ? 'Opret demo' : 'Create demo'}
                    </button>
                    <button
                      onClick={async () => {
                        await adminAction(u.email, 'set', {
                          planId: 'demo',
                          status: 'active',
                          createdAt: u.createdAt,
                          approvedAt: new Date().toISOString(),
                        });
                        refresh();
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg transition-colors"
                    >
                      <CheckCircle size={13} />
                      {da ? 'Aktiver demo' : 'Activate demo'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {loading && (
          <div className="text-center py-16 text-slate-400 text-sm">
            {da ? 'Indlaeser...' : 'Loading...'}
          </div>
        )}
      </div>

      {/* ─── User detail panel (slide-out) ─── */}
      {selectedUser && (
        <UserDetailPanel
          user={selectedUser}
          da={da}
          onClose={() => setSelectedEmail(null)}
          onRefresh={refresh}
          allPlans={allPlans}
        />
      )}
    </div>
  );
}
