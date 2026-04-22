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

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Users,
  CheckCircle,
  XCircle,
  Clock,
  Shield,
  AlertTriangle,
  Plus,
  RotateCcw,
  Trash2,
  Search,
} from 'lucide-react';
import { AdminNavTabs } from '../AdminNavTabs';
import { useLanguage } from '@/app/context/LanguageContext';
import {
  PLAN_LIST,
  resolvePlan,
  formatTokens,
  type SubStatus,
  type PlanId,
} from '@/app/lib/subscriptions';
import {
  UserDetailPanel,
  StatusBadge,
  PlanIcon,
  adminAction,
  type AdminUser,
} from './UserDetailPanel';

// ─── Types ──────────────────────────────────────────────────────────────────

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
  // BIZZ-755: sort state — 4 columns, toggleable direction
  const [sortBy, setSortBy] = useState<'email' | 'name' | 'plan' | 'status'>('email');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

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

  // BIZZ-755: sort the filtered list before splitting into sub-sections.
  const sorted = [...filtered].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortBy === 'email') return a.email.localeCompare(b.email) * dir;
    if (sortBy === 'name') return (a.fullName ?? '').localeCompare(b.fullName ?? '') * dir;
    if (sortBy === 'plan')
      return (a.subscription?.planId ?? 'zzz').localeCompare(b.subscription?.planId ?? 'zzz') * dir;
    if (sortBy === 'status')
      return (a.subscription?.status ?? 'zzz').localeCompare(b.subscription?.status ?? 'zzz') * dir;
    return 0;
  });

  // Separate filtered+sorted users by subscription state
  const withSub = sorted.filter((u) => u.subscription);
  const pending = withSub.filter((u) => u.subscription?.status === 'pending');
  const others = withSub.filter((u) => u.subscription?.status !== 'pending');
  const noSub = sorted.filter((u) => !u.subscription);

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

        {/* Tab navigation — BIZZ-737: shared component */}
        <AdminNavTabs activeTab="users" da={da} />

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
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-white font-semibold text-base flex items-center gap-2">
              <Users size={16} className="text-blue-400" />
              {da ? 'Alle brugere' : 'All users'}
            </h2>
            {/* BIZZ-755: sort dropdown (column + direction) */}
            <div className="flex items-center gap-2">
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as 'email' | 'name' | 'plan' | 'status')}
                className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-2 py-1 text-white text-xs focus:border-blue-500 focus:outline-none"
                aria-label={da ? 'Sortér efter' : 'Sort by'}
              >
                <option value="email">Email</option>
                <option value="name">{da ? 'Navn' : 'Name'}</option>
                <option value="plan">{da ? 'Plan' : 'Plan'}</option>
                <option value="status">Status</option>
              </select>
              <button
                onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}
                className="px-2 py-1 bg-slate-800/60 border border-slate-700/50 rounded-lg text-white text-xs hover:border-slate-500 transition-colors"
                aria-label={da ? 'Skift sorteringsretning' : 'Toggle sort direction'}
              >
                {sortDir === 'asc' ? '↑' : '↓'}
              </button>
            </div>
          </div>
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
