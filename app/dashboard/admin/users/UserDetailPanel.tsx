/**
 * UserDetailPanel + helper components for the admin users page.
 * BIZZ-661: Extraheret fra UsersClient.tsx.
 * @module app/dashboard/admin/users/UserDetailPanel
 */
'use client';

import { memo, useState, useRef, useEffect, useCallback } from 'react';
import {
  X,
  ChevronDown,
  Shield,
  Crown,
  Zap,
  AlertTriangle,
  CheckCircle,
  XCircle,
  CreditCard,
  Clock,
  Users,
  Plus,
  RotateCcw,
  Coins,
  Trash2,
  Activity,
  Search,
  MessageSquare,
  Building2,
  Home,
  User,
} from 'lucide-react';
import {
  PLAN_LIST,
  PLANS,
  resolvePlan,
  formatTokens,
  type SubStatus,
  type PlanId,
} from '@/app/lib/subscriptions';

/** User from the admin API — includes subscription from Supabase app_metadata */
export interface AdminUser {
  id: string;
  email: string;
  fullName: string;
  createdAt: string;
  lastSignIn: string | null;
  emailConfirmed: boolean;
  isAdmin: boolean;
  /** BIZZ-1947: false when the user has no tenant_membership (all API calls return 401/empty). */
  hasTenant: boolean;
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
export function StatusBadge({ status, da }: { status: SubStatus; da: boolean }) {
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
export function PlanIcon({ planId, size = 14 }: { planId: string; size?: number }) {
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
export async function adminAction(
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

/** Activity data returned by /api/admin/users/[id]/activity */
interface UserActivityData {
  eventCounts: Record<string, number>;
  timeline: Array<{ event_type: string; payload: Record<string, unknown>; created_at: string }>;
  chatSessionCount: number;
  aiTokensUsed: number;
  recentChats: Array<{ id: string; title: string | null; created_at: string }>;
  activeDays7: number;
  activeDays30: number;
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
export const UserDetailPanel = memo(function UserDetailPanel({
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
  const [activeTab, setActiveTab] = useState<'settings' | 'activity'>('settings');
  const [activityData, setActivityData] = useState<UserActivityData | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);

  /** Fetch activity data when tab switches to activity */
  const fetchActivity = useCallback(async () => {
    if (activityData) return;
    setActivityLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/activity`);
      if (res.ok) {
        const data = await res.json();
        setActivityData(data);
      }
    } catch {
      // Non-fatal — activity tab simply stays empty
    } finally {
      setActivityLoading(false);
    }
  }, [user.id, activityData]);

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
                      <p className="text-slate-400 text-[10px]">
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
        <div className="sticky top-0 bg-slate-900/95 backdrop-blur-sm border-b border-slate-700/50 px-6 py-4 z-10">
          <div className="flex items-center justify-between mb-3">
            <h2 id="user-panel-title" className="text-white font-bold text-base">
              {da ? 'Rediger bruger' : 'Edit user'}
            </h2>
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700/50 rounded-lg transition-colors"
              aria-label={da ? 'Luk panel' : 'Close panel'}
            >
              <X size={18} />
            </button>
          </div>
          {/* Tab switcher */}
          <div role="tablist" className="flex gap-1 bg-slate-800/50 rounded-lg p-0.5">
            <button
              role="tab"
              aria-selected={activeTab === 'settings'}
              onClick={() => setActiveTab('settings')}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                activeTab === 'settings'
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <CreditCard size={12} />
              {da ? 'Indstillinger' : 'Settings'}
            </button>
            <button
              role="tab"
              aria-selected={activeTab === 'activity'}
              onClick={() => {
                setActiveTab('activity');
                void fetchActivity();
              }}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                activeTab === 'activity'
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Activity size={12} />
              {da ? 'Aktivitet' : 'Activity'}
            </button>
          </div>
        </div>

        {/* ─── Activity tab ─── */}
        {activeTab === 'activity' && (
          <div role="tabpanel" className="px-6 py-5 space-y-4">
            {activityLoading && (
              <div className="flex items-center justify-center py-8">
                <div className="w-5 h-5 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
              </div>
            )}
            {!activityLoading && activityData && (
              <>
                {/* Overview stats */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                    <p className="text-slate-400 text-[10px] uppercase tracking-wider mb-1">
                      {da ? 'Aktive dage (7d)' : 'Active days (7d)'}
                    </p>
                    <p className="text-white text-lg font-bold">{activityData.activeDays7}</p>
                  </div>
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                    <p className="text-slate-400 text-[10px] uppercase tracking-wider mb-1">
                      {da ? 'Aktive dage (30d)' : 'Active days (30d)'}
                    </p>
                    <p className="text-white text-lg font-bold">{activityData.activeDays30}</p>
                  </div>
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                    <p className="text-slate-400 text-[10px] uppercase tracking-wider mb-1">
                      {da ? 'AI tokens (30d)' : 'AI tokens (30d)'}
                    </p>
                    <p className="text-white text-lg font-bold">
                      {activityData.aiTokensUsed > 1000
                        ? `${Math.round(activityData.aiTokensUsed / 1000)}k`
                        : activityData.aiTokensUsed}
                    </p>
                  </div>
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3">
                    <p className="text-slate-400 text-[10px] uppercase tracking-wider mb-1">
                      {da ? 'AI samtaler (30d)' : 'AI chats (30d)'}
                    </p>
                    <p className="text-white text-lg font-bold">{activityData.chatSessionCount}</p>
                  </div>
                </div>

                {/* Event breakdown */}
                {Object.keys(activityData.eventCounts).length > 0 && (
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 space-y-2">
                    <p className="text-slate-400 text-xs font-medium uppercase tracking-wider mb-2">
                      {da ? 'Handlinger (30d)' : 'Actions (30d)'}
                    </p>
                    {Object.entries(activityData.eventCounts)
                      .sort(([, a], [, b]) => b - a)
                      .map(([type, count]) => (
                        <div key={type} className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            {type === 'address_search' && (
                              <Search size={12} className="text-blue-400" />
                            )}
                            {type === 'property_open' && (
                              <Home size={12} className="text-emerald-400" />
                            )}
                            {type === 'company_open' && (
                              <Building2 size={12} className="text-amber-400" />
                            )}
                            {type === 'owner_open' && (
                              <User size={12} className="text-violet-400" />
                            )}
                            {type === 'ai_chat' && (
                              <MessageSquare size={12} className="text-cyan-400" />
                            )}
                            {![
                              'address_search',
                              'property_open',
                              'company_open',
                              'owner_open',
                              'ai_chat',
                            ].includes(type) && <Activity size={12} className="text-slate-400" />}
                            <span className="text-slate-300 text-xs">
                              {type.replace(/_/g, ' ')}
                            </span>
                          </div>
                          <span className="text-white text-xs font-medium">{count}</span>
                        </div>
                      ))}
                  </div>
                )}

                {/* Recent timeline */}
                {activityData.timeline.length > 0 && (
                  <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 space-y-2">
                    <p className="text-slate-400 text-xs font-medium uppercase tracking-wider mb-2">
                      {da ? 'Seneste aktivitet' : 'Recent activity'}
                    </p>
                    <div className="max-h-64 overflow-y-auto space-y-1.5">
                      {activityData.timeline.slice(0, 20).map((event, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between py-1 border-b border-slate-700/20 last:border-0"
                        >
                          <span className="text-slate-300 text-[11px]">
                            {event.event_type.replace(/_/g, ' ')}
                          </span>
                          <span className="text-slate-400 text-[10px]">
                            {new Date(event.created_at).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
                              day: 'numeric',
                              month: 'short',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Empty state */}
                {activityData.timeline.length === 0 &&
                  Object.keys(activityData.eventCounts).length === 0 && (
                    <p className="text-slate-400 text-sm text-center py-8">
                      {da
                        ? 'Ingen aktivitet registreret de seneste 30 dage.'
                        : 'No activity recorded in the last 30 days.'}
                    </p>
                  )}
              </>
            )}
          </div>
        )}

        {/* ─── Settings tab ─── */}
        <div
          className={`px-6 py-5 space-y-6 ${actionLoading ? 'opacity-60 pointer-events-none' : ''}`}
          style={{ display: activeTab === 'settings' ? undefined : 'none' }}
        >
          {/* ─── User info ─── */}
          <div>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 bg-blue-500/10 rounded-xl flex items-center justify-center">
                <Users size={18} className="text-blue-400" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-white font-semibold text-sm truncate">{user.email}</p>
                <p className="text-slate-400 text-xs">
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
              <p className="text-slate-400 text-[11px]">
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
                <p className="text-slate-400 text-xs">
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
                    <p className="text-slate-400 text-[10px]">
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
                      <p className="text-slate-400 text-[10px]">
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
                <span className="text-slate-400">|</span>
                <button
                  onClick={handleResetUsage}
                  className="flex items-center gap-1 text-slate-400 hover:text-slate-300 text-xs font-medium transition-colors"
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
                    <span className="text-slate-400 font-normal">
                      {isUnlimited ? ' / ∞' : ` / ${formatTokens(totalTokens)}`}
                    </span>
                  </p>
                  {isUnlimited ? (
                    <span className="text-purple-400 text-xs font-medium">∞</span>
                  ) : (
                    <p className="text-slate-400 text-xs">{usagePercent.toFixed(0)}%</p>
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
                    <span className="text-slate-400">{da ? 'Plan-tokens' : 'Plan tokens'}</span>
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
                      <span className="text-slate-400 flex items-center gap-1">
                        <Coins size={10} className="text-amber-400" />
                        {da ? 'Bonus-tokens' : 'Bonus tokens'}
                      </span>
                      <span className="text-amber-400">+{formatTokens(sub.bonusTokens ?? 0)}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-400">
                      {da ? 'Brugt denne måned' : 'Used this month'}
                    </span>
                    <span className="text-white font-medium">
                      {formatTokens(sub.tokensUsedThisMonth)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-400">{da ? 'Periode start' : 'Period start'}</span>
                    <span className="text-slate-400">
                      {new Date(sub.periodStart).toLocaleDateString(da ? 'da-DK' : 'en-GB')}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-slate-400 text-xs">
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
