'use client';

/**
 * Admin billing overview — /dashboard/admin/billing
 *
 * Displays subscription billing status for all users:
 *   - Revenue KPIs (MRR, active subscribers, churn)
 *   - Filterable table by status: active, pending, cancelled, expired, no subscription
 *   - Per-user details: plan, status, payment state, last sign-in
 *   - Quick actions: approve, cancel, change plan
 *
 * Data fetched from /api/admin/users (same source as user management).
 * Only accessible by admin user.
 *
 * @see app/api/admin/users/route.ts — data source
 * @see app/api/admin/subscription/route.ts — mutation API
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  BarChart3,
  CreditCard,
  Users,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  UserX,
  RefreshCw,
  Filter,
  Settings,
  Bot,
  ShieldCheck,
  Wrench,
  Activity,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { PLANS, resolvePlan, type PlanId, type SubStatus } from '@/app/lib/subscriptions';

// ─── Types ──────────────────────────────────────────────────────────────────

interface AdminUser {
  id: string;
  email: string;
  fullName: string;
  createdAt: string;
  lastSignIn: string | null;
  emailConfirmed: boolean;
  subscription: {
    planId: PlanId;
    status: SubStatus;
    createdAt: string;
    approvedAt: string | null;
    tokensUsedThisMonth: number;
    periodStart: string;
    bonusTokens: number;
  } | null;
}

type FilterType = 'all' | 'active' | 'pending' | 'cancelled' | 'expired' | 'none';

// ─── Component ──────────────────────────────────────────────────────────────

export default function BillingClient() {
  const { lang } = useLanguage();
  const router = useRouter();
  const da = lang === 'da';

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [planPrices, setPlanPrices] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterType>('all');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  /** Fetch all users and plan prices from admin API. */
  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [usersRes, plansRes] = await Promise.all([
        fetch('/api/admin/users'),
        fetch('/api/admin/plans'),
      ]);
      if (!usersRes.ok) throw new Error(`HTTP ${usersRes.status}`);
      const data: AdminUser[] = await usersRes.json();
      setUsers(data);

      if (plansRes.ok) {
        const plansData: { id: string; priceDkk: number }[] = await plansRes.json();
        const prices: Record<string, number> = {};
        for (const p of plansData) prices[p.id] = p.priceDkk;
        setPlanPrices(prices);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  /** Perform a subscription action via API. */
  const doAction = async (email: string, action: string, extra?: Record<string, unknown>) => {
    setActionLoading(email);
    try {
      const res = await fetch('/api/admin/subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, action, ...extra }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await fetchUsers();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionLoading(null);
    }
  };

  // ── Translations ──
  const t = {
    back: da ? 'Tilbage' : 'Back',
    title: da ? 'Abonnement & Fakturering' : 'Subscriptions & Billing',
    subtitle: da
      ? 'Overblik over alle brugeres betalingsstatus'
      : "Overview of all users' payment status",
    refresh: da ? 'Opdater' : 'Refresh',
    users: da ? 'Brugere' : 'Users',
    analytics: da ? 'Analyse' : 'Analytics',
    billing: da ? 'Fakturering' : 'Billing',
    loading: da ? 'Henter data…' : 'Loading data…',
    errorMsg: da ? 'Fejl ved hentning' : 'Error fetching data',
    mrr: da ? 'Månedlig omsætning' : 'Monthly revenue',
    activeSubscribers: da ? 'Aktive abonnenter' : 'Active subscribers',
    pendingApproval: da ? 'Afventer godkendelse' : 'Pending approval',
    churnedUsers: da ? 'Stoppede brugere' : 'Churned users',
    noSubscription: da ? 'Uden abonnement' : 'No subscription',
    all: da ? 'Alle' : 'All',
    active: da ? 'Aktive' : 'Active',
    pending: da ? 'Afventer' : 'Pending',
    cancelled: da ? 'Stoppet' : 'Cancelled',
    expired: da ? 'Udløbet' : 'Expired',
    none: da ? 'Ingen plan' : 'No plan',
    user: da ? 'Bruger' : 'User',
    plan: da ? 'Plan' : 'Plan',
    status: da ? 'Status' : 'Status',
    since: da ? 'Siden' : 'Since',
    lastSeen: da ? 'Sidst set' : 'Last seen',
    actions: da ? 'Handlinger' : 'Actions',
    approve: da ? 'Godkend' : 'Approve',
    cancel: da ? 'Deaktiver' : 'Deactivate',
    reactivate: da ? 'Genaktiver' : 'Reactivate',
    never: da ? 'Aldrig' : 'Never',
    noPlan: da ? 'Ingen' : 'None',
    dkk: 'DKK',
  };

  // ── Computed stats ──
  const stats = useMemo(() => {
    const active = users.filter((u) => u.subscription?.status === 'active');
    const pending = users.filter((u) => u.subscription?.status === 'pending');
    const cancelled = users.filter(
      (u) => u.subscription?.status === 'cancelled' || u.subscription?.status === 'expired'
    );
    const noSub = users.filter((u) => !u.subscription);

    const mrr = active.reduce((sum, u) => {
      const planId = u.subscription!.planId;
      const price = planPrices[planId] ?? PLANS[planId as PlanId]?.priceDkk ?? 0;
      return sum + price;
    }, 0);

    return {
      active: active.length,
      pending: pending.length,
      cancelled: cancelled.length,
      noSub: noSub.length,
      mrr,
    };
  }, [users, planPrices]);

  // ── Filtered users ──
  const filtered = useMemo(() => {
    switch (filter) {
      case 'active':
        return users.filter((u) => u.subscription?.status === 'active');
      case 'pending':
        return users.filter((u) => u.subscription?.status === 'pending');
      case 'cancelled':
        return users.filter((u) => u.subscription?.status === 'cancelled');
      case 'expired':
        return users.filter((u) => u.subscription?.status === 'expired');
      case 'none':
        return users.filter((u) => !u.subscription);
      default:
        return users;
    }
  }, [users, filter]);

  /** Format date to short locale string. */
  const fmtDate = (iso: string | null) => {
    if (!iso) return t.never;
    return new Date(iso).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  // ── Status badge ──
  const statusBadge = (status: SubStatus | null) => {
    if (!status) {
      return (
        <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-500 border border-slate-500/20">
          <UserX size={10} /> {t.noPlan}
        </span>
      );
    }
    const cfg: Record<SubStatus, { label: string; cls: string; icon: React.ReactNode }> = {
      active: {
        label: t.active,
        cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
        icon: <CheckCircle size={10} />,
      },
      pending: {
        label: t.pending,
        cls: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
        icon: <Clock size={10} />,
      },
      cancelled: {
        label: t.cancelled,
        cls: 'bg-red-500/15 text-red-400 border-red-500/20',
        icon: <XCircle size={10} />,
      },
      expired: {
        label: t.expired,
        cls: 'bg-slate-500/15 text-slate-400 border-slate-500/20',
        icon: <AlertTriangle size={10} />,
      },
    };
    const c = cfg[status] ?? cfg.expired;
    return (
      <span
        className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${c.cls}`}
      >
        {c.icon} {c.label}
      </span>
    );
  };

  // ── Filter tabs ──
  const filterTabs: { key: FilterType; label: string; count: number }[] = [
    { key: 'all', label: t.all, count: users.length },
    { key: 'active', label: t.active, count: stats.active },
    { key: 'pending', label: t.pending, count: stats.pending },
    { key: 'cancelled', label: t.cancelled, count: stats.cancelled },
    { key: 'none', label: t.none, count: stats.noSub },
  ];

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ─── Header ─── */}
      <div className="sticky top-0 z-20 px-3 sm:px-6 pt-5 pb-0 border-b border-slate-700/50 bg-slate-900/95 backdrop-blur-sm">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
          >
            <ArrowLeft size={16} /> {t.back}
          </button>
        </div>
        <div className="flex items-center gap-3 mb-1">
          <CreditCard size={22} className="text-blue-400" />
          <div>
            <h1 className="text-white text-xl font-bold">{t.title}</h1>
            <p className="text-slate-400 text-sm">{t.subtitle}</p>
          </div>
        </div>

        {/* Tab navigation */}
        <div className="flex gap-1 -mb-px overflow-x-auto mt-4">
          <Link
            href="/dashboard/admin/users"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
          >
            <Users size={14} /> {t.users}
          </Link>
          <span className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-blue-500 text-blue-300 font-medium cursor-default">
            <CreditCard size={14} /> {t.billing}
          </span>
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
            <BarChart3 size={14} /> {t.analytics}
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
      </div>

      {/* ─── Content ─── */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-5">
        {/* Loading / Error states */}
        {loading && users.length === 0 && (
          <div className="text-center py-20">
            <RefreshCw size={24} className="animate-spin text-blue-400 mx-auto mb-3" />
            <p className="text-slate-500 text-sm">{t.loading}</p>
          </div>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-6">
            <p className="text-red-400 text-sm">
              {t.errorMsg}: {error}
            </p>
          </div>
        )}

        {users.length > 0 && (
          <>
            {/* KPI cards + refresh button */}
            <div className="flex items-start gap-3 mb-6">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 flex-1">
                <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-4">
                  <p className="text-slate-400 text-xs uppercase tracking-wide">{t.mrr}</p>
                  <p className="text-white text-2xl font-bold">
                    {stats.mrr.toLocaleString('da-DK')}{' '}
                    <span className="text-sm font-normal text-slate-500">{t.dkk}</span>
                  </p>
                </div>
                <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-4">
                  <p className="text-slate-400 text-xs uppercase tracking-wide">
                    {t.activeSubscribers}
                  </p>
                  <p className="text-white text-2xl font-bold">{stats.active}</p>
                </div>
                <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-4">
                  <p className="text-slate-400 text-xs uppercase tracking-wide">
                    {t.pendingApproval}
                  </p>
                  <p className="text-white text-2xl font-bold">{stats.pending}</p>
                </div>
                <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-4">
                  <p className="text-slate-400 text-xs uppercase tracking-wide">{t.churnedUsers}</p>
                  <p className="text-white text-2xl font-bold">{stats.cancelled}</p>
                </div>
              </div>
              <button
                onClick={fetchUsers}
                disabled={loading}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 border border-blue-500/60 text-white text-sm font-medium rounded-lg transition-colors shrink-0 self-center disabled:opacity-50"
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> {t.refresh}
              </button>
            </div>

            {/* Filter pills */}
            <div className="flex items-center gap-1.5 mb-4 overflow-x-auto">
              <Filter size={14} className="text-slate-600 mr-1 shrink-0" />
              {filterTabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setFilter(tab.key)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                    filter === tab.key
                      ? 'bg-blue-600/20 text-blue-300 border border-blue-500/30'
                      : 'bg-slate-800/40 text-slate-400 border border-slate-700/40 hover:text-white'
                  }`}
                >
                  {tab.label} ({tab.count})
                </button>
              ))}
            </div>

            {/* Users table */}
            <div className="bg-slate-900/30 border border-slate-700/40 rounded-xl overflow-hidden">
              {/* Header row */}
              <div className="grid grid-cols-[1fr_100px_90px_100px_90px_120px] gap-3 px-5 py-3 border-b border-slate-700/40 text-slate-500 text-xs uppercase tracking-wide">
                <span>{t.user}</span>
                <span>{t.plan}</span>
                <span>{t.status}</span>
                <span>{t.since}</span>
                <span>{t.lastSeen}</span>
                <span className="text-right">{t.actions}</span>
              </div>

              {/* User rows */}
              {filtered.length === 0 ? (
                <div className="px-5 py-8 text-center text-slate-600 text-sm">
                  {da ? 'Ingen brugere i denne kategori' : 'No users in this category'}
                </div>
              ) : (
                filtered.map((u) => {
                  const sub = u.subscription;
                  const plan = sub ? resolvePlan(sub.planId) : null;
                  const planName = plan ? (da ? plan.nameDa : plan.nameEn) : t.noPlan;
                  const planColor = plan?.color ?? 'slate';
                  const isLoading = actionLoading === u.email;

                  return (
                    <div
                      key={u.id}
                      className="grid grid-cols-[1fr_100px_90px_100px_90px_120px] gap-3 px-5 py-3 border-b border-slate-700/20 text-white hover:bg-slate-800/40 items-center text-sm"
                    >
                      {/* User */}
                      <div className="min-w-0">
                        <p className="text-white text-xs font-medium truncate">{u.email}</p>
                        {u.fullName && (
                          <p className="text-slate-500 text-[11px] truncate">{u.fullName}</p>
                        )}
                      </div>

                      {/* Plan */}
                      <span className={`text-xs font-medium text-${planColor}-400`}>
                        {planName}
                        {plan && plan.priceDkk > 0 && (
                          <span className="text-slate-600 font-normal ml-1">{plan.priceDkk},-</span>
                        )}
                      </span>

                      {/* Status */}
                      {statusBadge(sub?.status ?? null)}

                      {/* Since */}
                      <span className="text-slate-500 text-[11px]">
                        {fmtDate(sub?.createdAt ?? u.createdAt)}
                      </span>

                      {/* Last seen */}
                      <span className="text-slate-600 text-[11px]">{fmtDate(u.lastSignIn)}</span>

                      {/* Actions */}
                      <div className="flex justify-end gap-1.5">
                        {isLoading ? (
                          <RefreshCw size={12} className="animate-spin text-slate-500" />
                        ) : (
                          <>
                            {sub?.status === 'pending' && (
                              <button
                                onClick={() => doAction(u.email, 'approve')}
                                className="text-[10px] px-2 py-1 rounded bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-colors"
                              >
                                {t.approve}
                              </button>
                            )}
                            {sub?.status === 'active' && (
                              <button
                                onClick={() =>
                                  doAction(u.email, 'changeStatus', { status: 'cancelled' })
                                }
                                className="text-[10px] px-2 py-1 rounded bg-red-600/20 text-red-400 border border-red-500/30 hover:bg-red-500/20 transition-colors"
                              >
                                {t.cancel}
                              </button>
                            )}
                            {(sub?.status === 'cancelled' || sub?.status === 'expired') && (
                              <button
                                onClick={() =>
                                  doAction(u.email, 'changeStatus', { status: 'active' })
                                }
                                className="text-[10px] px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 border border-blue-500/60 text-white transition-colors"
                              >
                                {t.reactivate}
                              </button>
                            )}
                            {!sub && (
                              <Link
                                href="/dashboard/admin/users"
                                className="text-[10px] px-2 py-1 rounded bg-slate-800/40 text-slate-400 border border-slate-700/40 hover:text-white transition-colors"
                              >
                                {t.users}
                              </Link>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
