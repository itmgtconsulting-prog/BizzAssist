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
 *
 * Kun tilgængelig for admin-brugere (jjrchefen@hotmail.com).
 * Data gemmes i localStorage som demo — flyttes til Supabase når klar.
 *
 * @see app/lib/subscriptions.ts — plan-definitioner og subscription helpers
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
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
  RefreshCw,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import {
  getAllSubscriptions,
  getSubscription,
  approveSubscription,
  rejectSubscription,
  updateSubscriptionPlan,
  updateSubscriptionStatus,
  addBonusTokens,
  resetTokenUsage,
  registerSubscription,
  removeSubscription,
  PLANS,
  PLAN_LIST,
  ADMIN_EMAIL,
  formatTokens,
  type UserSubscription,
  type SubStatus,
  type PlanId,
} from '@/app/lib/subscriptions';

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

/**
 * User detail panel — slide-out panel for editing a user's subscription.
 *
 * @param sub - The user subscription to edit
 * @param da - Whether to use Danish labels
 * @param onClose - Close handler
 * @param onRefresh - Refresh data handler
 */
function UserDetailPanel({
  sub,
  da,
  onClose,
  onRefresh,
}: {
  sub: UserSubscription;
  da: boolean;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const plan = PLANS[sub.planId];
  const isUnlimited = plan.aiTokensPerMonth === -1;
  const totalTokens = isUnlimited ? -1 : plan.aiTokensPerMonth + (sub.bonusTokens ?? 0);
  const usagePercent = isUnlimited
    ? 0
    : totalTokens > 0
      ? Math.min(100, (sub.tokensUsedThisMonth / totalTokens) * 100)
      : 0;

  const [showPlanPicker, setShowPlanPicker] = useState(false);
  const [tokenAmount, setTokenAmount] = useState('');
  const [showTokenInput, setShowTokenInput] = useState(false);

  /** Handle plan change — updates localStorage + syncs to Supabase */
  const handlePlanChange = (planId: PlanId) => {
    const updated = updateSubscriptionPlan(sub.email, planId);
    if (updated) syncToSupabase(sub.email, updated);
    setShowPlanPicker(false);
    onRefresh();
  };

  /** Handle status toggle — updates localStorage + syncs to Supabase */
  const handleToggleStatus = () => {
    const updated =
      sub.status === 'active'
        ? updateSubscriptionStatus(sub.email, 'cancelled')
        : updateSubscriptionStatus(sub.email, 'active');
    if (updated) syncToSupabase(sub.email, updated);
    onRefresh();
  };

  /** Handle approve — updates localStorage + syncs to Supabase */
  const handleApprove = () => {
    const updated = approveSubscription(sub.email);
    if (updated) syncToSupabase(sub.email, updated);
    onRefresh();
  };

  /** Handle reject — updates localStorage + syncs to Supabase */
  const handleReject = () => {
    const updated = rejectSubscription(sub.email);
    if (updated) syncToSupabase(sub.email, updated);
    onRefresh();
  };

  /** Handle adding bonus tokens — updates localStorage + syncs to Supabase */
  const handleAddTokens = () => {
    const amount = parseInt(tokenAmount, 10);
    if (!amount || amount <= 0) return;
    const updated = addBonusTokens(sub.email, amount);
    if (updated) syncToSupabase(sub.email, updated);
    setTokenAmount('');
    setShowTokenInput(false);
    onRefresh();
  };

  /** Handle resetting token usage — updates localStorage + syncs to Supabase */
  const handleResetUsage = () => {
    const updated = resetTokenUsage(sub.email);
    if (updated) syncToSupabase(sub.email, updated);
    onRefresh();
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-md bg-slate-900 border-l border-slate-700/50 overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-slate-900/95 backdrop-blur-sm border-b border-slate-700/50 px-6 py-4 flex items-center justify-between z-10">
          <h2 className="text-white font-bold text-base">{da ? 'Rediger bruger' : 'Edit user'}</h2>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700/50 rounded-lg transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* ─── User info ─── */}
          <div>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 bg-blue-500/10 rounded-xl flex items-center justify-center">
                <Users size={18} className="text-blue-400" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-white font-semibold text-sm truncate">{sub.email}</p>
                <p className="text-slate-500 text-xs">
                  {da ? 'Oprettet' : 'Created'}{' '}
                  {new Date(sub.createdAt).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </p>
              </div>
              {sub.email === ADMIN_EMAIL && (
                <span className="bg-blue-500/20 text-blue-400 border border-blue-500/30 px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0">
                  Admin
                </span>
              )}
            </div>
          </div>

          {/* ─── Status section ─── */}
          <div className="bg-white/5 border border-white/8 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-slate-400 text-xs font-medium uppercase tracking-wider">Status</p>
              <StatusBadge status={sub.status} da={da} />
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
          <div className="bg-white/5 border border-white/8 rounded-xl p-4 space-y-3">
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
                {PLAN_LIST.map((p) => (
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
          <div className="bg-white/5 border border-white/8 rounded-xl p-4 space-y-3">
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
                      addBonusTokens(sub.email, amount);
                      setShowTokenInput(false);
                      onRefresh();
                    }}
                    className="px-2.5 py-1 bg-slate-800/60 hover:bg-slate-700 border border-slate-700/50 text-slate-300 text-[10px] font-medium rounded-md transition-colors"
                  >
                    +{formatTokens(amount)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ─── Features overview ─── */}
          <div className="bg-white/5 border border-white/8 rounded-xl p-4">
            <p className="text-slate-400 text-xs font-medium uppercase tracking-wider mb-3">
              {da ? 'Funktioner' : 'Features'}
            </p>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">
                  {da ? 'Ubegransede sogninger' : 'Unlimited searches'}
                </span>
                <CheckCircle size={13} className="text-emerald-400" />
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">AI</span>
                {plan.aiEnabled ? (
                  <CheckCircle size={13} className="text-emerald-400" />
                ) : (
                  <XCircle size={13} className="text-slate-600" />
                )}
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">
                  {da ? 'Eksport (PDF/CSV)' : 'Export (PDF/CSV)'}
                </span>
                {plan.exportEnabled ? (
                  <CheckCircle size={13} className="text-emerald-400" />
                ) : (
                  <XCircle size={13} className="text-slate-600" />
                )}
              </div>
            </div>
          </div>

          {/* ─── Delete user (danger zone) ─── */}
          {sub.email !== ADMIN_EMAIL && (
            <div className="border border-red-500/20 rounded-xl p-4">
              <p className="text-red-400 text-xs font-medium uppercase tracking-wider mb-2">
                {da ? 'Farezone' : 'Danger zone'}
              </p>
              <button
                onClick={async () => {
                  const confirmed = window.confirm(
                    da
                      ? `Er du sikker på at du vil slette ${sub.email} permanent? Dette kan ikke fortrydes.`
                      : `Are you sure you want to permanently delete ${sub.email}? This cannot be undone.`
                  );
                  if (!confirmed) return;
                  // Remove from localStorage
                  removeSubscription(sub.email);
                  // Remove from Supabase Auth
                  await fetch('/api/admin/users', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: sub.email }),
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
}

/**
 * Sync a subscription to Supabase app_metadata so it persists across browsers.
 * Fires-and-forgets — localStorage is the immediate source, Supabase is the backup.
 *
 * @param email - User email
 * @param sub - Subscription data to sync
 */
async function syncToSupabase(email: string, sub: UserSubscription): Promise<boolean> {
  try {
    const res = await fetch('/api/admin/subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        planId: sub.planId,
        status: sub.status,
        createdAt: sub.createdAt,
        approvedAt: sub.approvedAt,
        tokensUsedThisMonth: sub.tokensUsedThisMonth,
        periodStart: sub.periodStart,
        bonusTokens: sub.bonusTokens ?? 0,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[syncToSupabase] Failed for', email, '— status:', res.status, err);
      return false;
    }
    console.log('[syncToSupabase] OK for', email);
    return true;
  } catch (err) {
    console.error('[syncToSupabase] Network error for', email, err);
    return false;
  }
}

/** Supabase Auth user from API */
interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  createdAt: string;
  lastSignIn: string | null;
  emailConfirmed: boolean;
}

/**
 * Admin user management page.
 *
 * Lists all registered users with their subscription details.
 * Fetches users from Supabase Auth and merges with localStorage subscriptions.
 * Users without a subscription are shown separately so admin can assign one.
 * Click on a user to open the edit panel with full admin controls.
 */
export default function AdminUsersPage() {
  const router = useRouter();
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [subs, setSubs] = useState<UserSubscription[]>([]);
  /** Auth users from Supabase that have NO subscription */
  const [unsubscribedUsers, setUnsubscribedUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  /** Add user form state */
  const [showAddUser, setShowAddUser] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newFullName, setNewFullName] = useState('');
  const [newPlan, setNewPlan] = useState<PlanId>('demo');
  const [newStatus, setNewStatus] = useState<'pending' | 'active'>('active');
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  /** Check admin access — redirect non-admin users to dashboard */
  useEffect(() => {
    const currentSub = getSubscription();
    if (!currentSub || currentSub.email !== ADMIN_EMAIL) {
      setIsAdmin(false);
      router.replace('/dashboard');
    } else {
      setIsAdmin(true);
    }
  }, [router]);

  /** Load subscriptions from localStorage + auth users from Supabase API */
  const refresh = useCallback(async () => {
    // Local subscriptions
    const allSubs = getAllSubscriptions();
    setSubs(allSubs);

    // Fetch Supabase Auth users
    try {
      const res = await fetch('/api/admin/users');
      if (res.ok) {
        const authUsers: AuthUser[] = await res.json();
        const subEmails = new Set(allSubs.map((s) => s.email.toLowerCase()));
        // Filter to only users WITHOUT a subscription
        const noSub = authUsers.filter((u) => !subEmails.has(u.email.toLowerCase()));
        setUnsubscribedUsers(noSub);
      }
    } catch {
      // API unavailable — just show localStorage data
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

  /** Currently selected subscription for the detail panel */
  const selectedSub = subs.find((s) => s.email === selectedEmail) ?? null;

  // Separate pending from others for priority display
  const pending = subs.filter((s) => s.status === 'pending');
  const others = subs.filter((s) => s.status !== 'pending');

  /** Stats */
  const activeCount = subs.filter((s) => s.status === 'active').length;
  const totalTokensUsed = subs.reduce((sum, s) => sum + s.tokensUsedThisMonth, 0);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ─── Header ─── */}
      <div className="px-6 pt-5 pb-4 border-b border-slate-700/50 bg-slate-900/30">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
          >
            <ArrowLeft size={16} /> {da ? 'Tilbage' : 'Back'}
          </button>
        </div>
        <div className="flex items-center gap-3">
          <Users size={22} className="text-blue-400" />
          <div>
            <h1 className="text-white text-xl font-bold">
              {da ? 'Brugeradministration' : 'User Management'}
            </h1>
            <p className="text-slate-400 text-sm">
              {da
                ? `${subs.length + unsubscribedUsers.length} brugere · ${activeCount} aktive · ${pending.length} afventer · ${unsubscribedUsers.length} uden abonnement`
                : `${subs.length + unsubscribedUsers.length} users · ${activeCount} active · ${pending.length} pending · ${unsubscribedUsers.length} no subscription`}
            </p>
          </div>
        </div>

        {/* Quick stats + add user button */}
        <div className="flex gap-3 mt-3">
          <div className="bg-white/5 border border-white/8 rounded-lg px-3 py-2 flex-1">
            <p className="text-slate-500 text-[10px] uppercase tracking-wider">
              {da ? 'Aktive' : 'Active'}
            </p>
            <p className="text-emerald-400 text-sm font-bold">{activeCount}</p>
          </div>
          <div className="bg-white/5 border border-white/8 rounded-lg px-3 py-2 flex-1">
            <p className="text-slate-500 text-[10px] uppercase tracking-wider">
              {da ? 'Afventer' : 'Pending'}
            </p>
            <p className="text-amber-400 text-sm font-bold">{pending.length}</p>
          </div>
          <div className="bg-white/5 border border-white/8 rounded-lg px-3 py-2 flex-1">
            <p className="text-slate-500 text-[10px] uppercase tracking-wider">
              {da ? 'Tokens brugt' : 'Tokens used'}
            </p>
            <p className="text-blue-400 text-sm font-bold">{formatTokens(totalTokensUsed)}</p>
          </div>
          <button
            onClick={async () => {
              const allSubs = getAllSubscriptions();
              let ok = 0;
              let fail = 0;
              for (const sub of allSubs) {
                const success = await syncToSupabase(sub.email, sub);
                if (success) ok++;
                else fail++;
              }
              alert(
                da
                  ? `Synkroniseret ${ok} af ${allSubs.length} abonnementer til Supabase.${fail > 0 ? ` ${fail} fejlede.` : ''}`
                  : `Synced ${ok} of ${allSubs.length} subscriptions to Supabase.${fail > 0 ? ` ${fail} failed.` : ''}`
              );
            }}
            className="flex items-center gap-1.5 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium rounded-lg transition-colors shrink-0 self-center"
          >
            <RefreshCw size={14} />
            {da ? 'Synk til Supabase' : 'Sync to Supabase'}
          </button>
          <button
            onClick={() => setShowAddUser(!showAddUser)}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors shrink-0 self-center"
          >
            <Plus size={14} />
            {da ? 'Tilføj bruger' : 'Add user'}
          </button>
        </div>

        {/* Add user form — creates user in Supabase Auth + sets subscription */}
        {showAddUser && (
          <div className="mt-3 bg-white/5 border border-white/8 rounded-xl p-4 space-y-3">
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
                  {PLAN_LIST.map((p) => (
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
                    // Create user in Supabase Auth via admin API (bypasses rate limits)
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

                    // Also save to localStorage for admin panel view
                    const sub: UserSubscription = { email, ...subscription };
                    registerSubscription(sub);

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
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
        {/* Pending approvals section */}
        {pending.length > 0 && (
          <div>
            <h2 className="text-amber-400 text-sm font-semibold uppercase tracking-wider mb-3 flex items-center gap-2">
              <Clock size={14} />
              {da ? 'Afventer godkendelse' : 'Pending approval'}
              <span className="bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded-full text-[10px] font-bold">
                {pending.length}
              </span>
            </h2>
            <div className="space-y-2">
              {pending.map((sub) => {
                const plan = PLANS[sub.planId];
                return (
                  <div
                    key={sub.email}
                    onClick={() => setSelectedEmail(sub.email)}
                    className="bg-amber-500/5 border border-amber-500/20 rounded-xl px-5 py-4 flex items-center justify-between gap-4 cursor-pointer hover:bg-amber-500/10 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-white font-semibold text-sm truncate">{sub.email}</p>
                        <StatusBadge status={sub.status} da={da} />
                      </div>
                      <div className="flex items-center gap-2 text-xs text-slate-400">
                        <PlanIcon planId={sub.planId} />
                        <span>{da ? plan.nameDa : plan.nameEn}</span>
                        <span className="text-slate-600">·</span>
                        <span>
                          {da ? 'Oprettet' : 'Created'}{' '}
                          {new Date(sub.createdAt).toLocaleDateString(da ? 'da-DK' : 'en-GB')}
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const u = approveSubscription(sub.email);
                          if (u) syncToSupabase(sub.email, u);
                          refresh();
                        }}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg transition-colors"
                      >
                        <CheckCircle size={13} />
                        {da ? 'Godkend' : 'Approve'}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const u = rejectSubscription(sub.email);
                          if (u) syncToSupabase(sub.email, u);
                          refresh();
                        }}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/20 hover:bg-red-600/40 text-red-400 text-xs font-medium rounded-lg transition-colors border border-red-500/30"
                      >
                        <XCircle size={13} />
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
          <h2 className="text-slate-400 text-sm font-semibold uppercase tracking-wider mb-3 flex items-center gap-2">
            <Users size={14} />
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
              {others.map((sub) => {
                const plan = PLANS[sub.planId];
                const isUnlim = plan.aiTokensPerMonth === -1;
                const totalT = isUnlim ? -1 : plan.aiTokensPerMonth + (sub.bonusTokens ?? 0);
                const usedPct = isUnlim
                  ? 0
                  : totalT > 0
                    ? (sub.tokensUsedThisMonth / totalT) * 100
                    : 0;
                return (
                  <div
                    key={sub.email}
                    onClick={() => setSelectedEmail(sub.email)}
                    className="bg-white/5 border border-white/8 rounded-xl px-5 py-4 flex items-center justify-between gap-4 cursor-pointer hover:bg-white/8 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-white text-sm font-medium truncate">{sub.email}</p>
                        {sub.email === ADMIN_EMAIL && (
                          <span className="bg-blue-500/20 text-blue-400 border border-blue-500/30 px-1.5 py-0.5 rounded-full text-[10px] font-bold">
                            Admin
                          </span>
                        )}
                        <StatusBadge status={sub.status} da={da} />
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
                          {new Date(sub.createdAt).toLocaleDateString(da ? 'da-DK' : 'en-GB')}
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
        {unsubscribedUsers.length > 0 && (
          <div>
            <h2 className="text-red-400 text-sm font-semibold uppercase tracking-wider mb-3 flex items-center gap-2">
              <AlertTriangle size={14} />
              {da ? 'Uden abonnement' : 'No subscription'}
              <span className="bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded-full text-[10px] font-bold">
                {unsubscribedUsers.length}
              </span>
            </h2>
            <div className="space-y-2">
              {unsubscribedUsers.map((authUser) => (
                <div
                  key={authUser.id}
                  className="bg-red-500/5 border border-red-500/20 rounded-xl px-5 py-4 flex items-center justify-between gap-4"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="text-white font-semibold text-sm truncate">{authUser.email}</p>
                      {authUser.fullName && (
                        <span className="text-slate-500 text-xs truncate">
                          ({authUser.fullName})
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-red-500/20 text-red-400 border-red-500/30">
                        <XCircle size={12} /> {da ? 'Intet abonnement' : 'No subscription'}
                      </span>
                      {!authUser.emailConfirmed && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-slate-500/20 text-slate-400 border-slate-500/30">
                          {da ? 'Email ikke bekræftet' : 'Email not confirmed'}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span>
                        {da ? 'Oprettet' : 'Created'}{' '}
                        {new Date(authUser.createdAt).toLocaleDateString(da ? 'da-DK' : 'en-GB')}
                      </span>
                      {authUser.lastSignIn && (
                        <>
                          <span className="text-slate-600">·</span>
                          <span>
                            {da ? 'Sidst logget ind' : 'Last sign in'}{' '}
                            {new Date(authUser.lastSignIn).toLocaleDateString(
                              da ? 'da-DK' : 'en-GB'
                            )}
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
                            ? `Er du sikker på at du vil slette ${authUser.email} permanent?`
                            : `Are you sure you want to permanently delete ${authUser.email}?`
                        );
                        if (!confirmed) return;
                        await fetch('/api/admin/users', {
                          method: 'DELETE',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ email: authUser.email }),
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
                        const now = new Date().toISOString();
                        const sub: UserSubscription = {
                          email: authUser.email,
                          planId: 'demo',
                          status: 'pending',
                          createdAt: authUser.createdAt,
                          approvedAt: null,
                          tokensUsedThisMonth: 0,
                          periodStart: now,
                        };
                        registerSubscription(sub);
                        const ok = await syncToSupabase(authUser.email, sub);
                        if (!ok)
                          alert(`Fejl: Kunne ikke synkronisere ${authUser.email} til Supabase`);
                        refresh();
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600/20 hover:bg-amber-600/40 text-amber-400 text-xs font-medium rounded-lg transition-colors border border-amber-500/30"
                    >
                      <Clock size={13} />
                      {da ? 'Opret demo' : 'Create demo'}
                    </button>
                    <button
                      onClick={async () => {
                        const now = new Date().toISOString();
                        const sub: UserSubscription = {
                          email: authUser.email,
                          planId: 'demo',
                          status: 'active',
                          createdAt: authUser.createdAt,
                          approvedAt: now,
                          tokensUsedThisMonth: 0,
                          periodStart: now,
                        };
                        registerSubscription(sub);
                        const ok = await syncToSupabase(authUser.email, sub);
                        if (!ok)
                          alert(`Fejl: Kunne ikke synkronisere ${authUser.email} til Supabase`);
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
      {selectedSub && (
        <UserDetailPanel
          sub={selectedSub}
          da={da}
          onClose={() => setSelectedEmail(null)}
          onRefresh={refresh}
        />
      )}
    </div>
  );
}
