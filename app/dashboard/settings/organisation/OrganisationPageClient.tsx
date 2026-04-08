'use client';

/**
 * Organisation settings page — /dashboard/settings/organisation
 *
 * Allows tenant admins to manage company-level settings:
 *   1. Virksomhedsoplysninger — edit company name, view CVR + creation date
 *   2. Team                  — list members, invite new users
 *   3. Abonnement            — current plan summary + links to billing
 *
 * Data sources:
 *   - /api/subscription        — tenant + subscription data
 *   - /api/admin/users         — team member list (admin-only; gracefully hidden otherwise)
 *   - /api/tenants/update      — PATCH to update tenant name
 *
 * @module dashboard/settings/organisation
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Users,
  CreditCard,
  Pencil,
  CheckCircle,
  AlertCircle,
  Loader2,
  Mail,
  ChevronDown,
  ExternalLink,
  Shield,
  Crown,
  Eye,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { useSubscription } from '@/app/context/SubscriptionContext';
import { resolvePlan, type UserSubscription } from '@/app/lib/subscriptions';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Tab identifiers for this page */
type OrgTab = 'virksomhed' | 'team' | 'abonnement';

/** A team member row from /api/admin/users */
interface TeamMember {
  id: string;
  email: string;
  fullName: string;
  createdAt: string;
  isAdmin: boolean;
  subscription: {
    planId: string;
    status: string;
  } | null;
}

/** Response shape from /api/subscription */
interface SubscriptionResponse {
  email?: string;
  fullName?: string;
  isAdmin?: boolean;
  tenant?: {
    id: string;
    name: string;
    cvrNumber: string | null;
    createdAt: string;
  };
  subscription?: UserSubscription;
}

// ─── Role badge helper ────────────────────────────────────────────────────────

/**
 * Renders a role badge for a team member.
 *
 * @param isAdmin - Whether the user has admin privileges
 * @param da - Whether to use Danish strings
 * @returns JSX badge element
 */
function RoleBadge({ isAdmin, da }: { isAdmin: boolean; da: boolean }) {
  return isAdmin ? (
    <span className="flex items-center gap-1 px-2 py-0.5 bg-amber-500/15 text-amber-400 text-xs rounded-full border border-amber-500/20">
      <Crown size={10} />
      {da ? 'Admin' : 'Admin'}
    </span>
  ) : (
    <span className="flex items-center gap-1 px-2 py-0.5 bg-slate-700/60 text-slate-400 text-xs rounded-full border border-white/8">
      <Eye size={10} />
      {da ? 'Bruger' : 'Member'}
    </span>
  );
}

// ─── Section: Virksomhedsoplysninger ─────────────────────────────────────────

/**
 * Virksomhedsoplysninger section.
 *
 * Displays the tenant name (editable), CVR number (read-only), and creation date.
 * Calls PATCH /api/tenants/update to persist changes.
 *
 * @param da - Whether to use Danish strings
 * @param isAdmin - Whether the current user has admin role
 */
function VirksomhedSection({ da, isAdmin }: { da: boolean; isAdmin: boolean }) {
  const [tenantName, setTenantName] = useState('');
  const [originalName, setOriginalName] = useState('');
  const [cvrNumber, setCvrNumber] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  /** Load tenant data from subscription endpoint */
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/subscription');
        if (res.ok) {
          const data = (await res.json()) as SubscriptionResponse;
          if (data.tenant) {
            setTenantName(data.tenant.name ?? '');
            setOriginalName(data.tenant.name ?? '');
            setCvrNumber(data.tenant.cvrNumber ?? null);
            setCreatedAt(data.tenant.createdAt ?? null);
          }
        }
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  /**
   * Persist the updated company name via PATCH /api/tenants/update.
   */
  const handleSave = async () => {
    if (tenantName.trim() === originalName.trim() || !isAdmin) return;
    setSaving(true);
    setSaveStatus('idle');
    setSaveError(null);

    try {
      const res = await fetch('/api/tenants/update', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: tenantName.trim() }),
      });

      if (res.ok) {
        setOriginalName(tenantName.trim());
        setSaveStatus('success');
        setTimeout(() => setSaveStatus('idle'), 3000);
      } else {
        const data = (await res.json()) as { error?: string };
        setSaveError(
          data.error ?? (da ? 'Kunne ikke gemme ændringer.' : 'Could not save changes.')
        );
        setSaveStatus('error');
      }
    } catch {
      setSaveError(da ? 'Netværksfejl.' : 'Network error.');
      setSaveStatus('error');
    } finally {
      setSaving(false);
    }
  };

  const hasChange = tenantName.trim() !== originalName.trim();

  if (loading) {
    return (
      <div className="bg-white/5 border border-white/8 rounded-2xl p-6 animate-pulse">
        <div className="h-4 w-40 bg-slate-700 rounded mb-4" />
        <div className="h-9 w-full bg-slate-700 rounded-lg mb-3" />
        <div className="h-3 w-32 bg-slate-700/60 rounded" />
      </div>
    );
  }

  return (
    <div className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-5">
      <div className="flex items-center gap-2">
        <Building2 size={16} className="text-blue-400" />
        <h3 className="text-white font-semibold text-sm">
          {da ? 'Virksomhedsoplysninger' : 'Company details'}
        </h3>
      </div>

      {/* Company name */}
      <div>
        <label htmlFor="org-name" className="block text-slate-400 text-xs font-medium mb-1.5">
          {da ? 'Virksomhedsnavn' : 'Company name'}
        </label>
        <div className="flex gap-2">
          <input
            id="org-name"
            type="text"
            value={tenantName}
            onChange={(e) => {
              setTenantName(e.target.value);
              setSaveStatus('idle');
              setSaveError(null);
            }}
            disabled={!isAdmin || saving}
            className="flex-1 px-3 py-2.5 bg-slate-900/60 border border-white/10 focus:border-blue-500/60 rounded-lg text-white text-sm placeholder-slate-500 outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            placeholder={da ? 'Virksomhedens navn' : 'Company name'}
          />
          {isAdmin && (
            <button
              onClick={handleSave}
              disabled={!hasChange || saving}
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Pencil size={13} />}
              {da ? 'Gem' : 'Save'}
            </button>
          )}
        </div>

        {saveStatus === 'success' && (
          <p className="flex items-center gap-1.5 text-emerald-400 text-xs mt-2">
            <CheckCircle size={11} />
            {da ? 'Ændringer gemt.' : 'Changes saved.'}
          </p>
        )}
        {saveStatus === 'error' && saveError && (
          <p className="flex items-center gap-1.5 text-red-400 text-xs mt-2">
            <AlertCircle size={11} />
            {saveError}
          </p>
        )}
        {!isAdmin && (
          <p className="text-slate-500 text-xs mt-1">
            {da
              ? 'Kun administratorer kan ændre virksomhedsnavnet.'
              : 'Only administrators can change the company name.'}
          </p>
        )}
      </div>

      {/* CVR number */}
      <div>
        <label className="block text-slate-400 text-xs font-medium mb-1.5">
          {da ? 'CVR-nummer' : 'CVR number'}
        </label>
        <p className="text-white text-sm">
          {cvrNumber ?? (
            <span className="text-slate-500 italic">{da ? 'Ikke angivet' : 'Not provided'}</span>
          )}
        </p>
      </div>

      {/* Created date */}
      <div>
        <label className="block text-slate-400 text-xs font-medium mb-1.5">
          {da ? 'Oprettet' : 'Created'}
        </label>
        <p className="text-white text-sm">
          {createdAt
            ? new Date(createdAt).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })
            : '—'}
        </p>
      </div>
    </div>
  );
}

// ─── Section: Team ────────────────────────────────────────────────────────────

/**
 * Team section — lists all team members and allows admins to invite new users.
 *
 * Member list is fetched from /api/admin/users (admin endpoint).
 * If the caller is not an admin, a placeholder message is shown.
 *
 * @param da - Whether to use Danish strings
 * @param isAdmin - Whether the current user has admin privileges
 */
function TeamSection({ da, isAdmin }: { da: boolean; isAdmin: boolean }) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'tenant_admin' | 'tenant_member'>('tenant_member');
  const [inviting, setInviting] = useState(false);
  const [inviteStatus, setInviteStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [inviteError, setInviteError] = useState<string | null>(null);

  /** Fetch team members from admin endpoint */
  const fetchMembers = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    try {
      const res = await fetch('/api/admin/users');
      if (res.ok) {
        const data = (await res.json()) as { users: TeamMember[] };
        setMembers(data.users ?? []);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  /**
   * Invite a new user by email via /api/admin/users POST.
   */
  const handleInvite = async () => {
    const email = inviteEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      setInviteError(da ? 'Ugyldig e-mailadresse.' : 'Invalid email address.');
      setInviteStatus('error');
      return;
    }

    setInviting(true);
    setInviteStatus('idle');
    setInviteError(null);

    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          role: inviteRole,
          // Temporary password — user must change on first login
          password: Math.random().toString(36).slice(2) + 'Aa1!',
        }),
      });

      if (res.ok) {
        setInviteStatus('success');
        setInviteEmail('');
        setShowInvite(false);
        await fetchMembers();
        setTimeout(() => setInviteStatus('idle'), 4000);
      } else {
        const data = (await res.json()) as { error?: string };
        setInviteError(
          data.error ?? (da ? 'Kunne ikke invitere brugeren.' : 'Could not invite the user.')
        );
        setInviteStatus('error');
      }
    } catch {
      setInviteError(da ? 'Netværksfejl.' : 'Network error.');
      setInviteStatus('error');
    } finally {
      setInviting(false);
    }
  };

  return (
    <div className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users size={16} className="text-purple-400" />
          <h3 className="text-white font-semibold text-sm">{da ? 'Team' : 'Team'}</h3>
          {members.length > 0 && <span className="text-xs text-slate-500">({members.length})</span>}
        </div>

        {isAdmin && (
          <button
            onClick={() => {
              setShowInvite((v) => !v);
              setInviteStatus('idle');
              setInviteError(null);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/20 text-purple-300 text-xs font-medium rounded-lg transition-colors"
          >
            <Mail size={12} />
            {da ? 'Inviter bruger' : 'Invite user'}
          </button>
        )}
      </div>

      {/* Invite form */}
      {showInvite && isAdmin && (
        <div className="bg-slate-900/50 border border-white/8 rounded-xl p-4 space-y-3">
          <p className="text-slate-400 text-xs font-medium">
            {da ? 'Inviter ny bruger' : 'Invite new user'}
          </p>
          <div className="flex gap-2">
            <input
              id="invite-email"
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder={da ? 'bruger@virksomhed.dk' : 'user@company.com'}
              className="flex-1 px-3 py-2 bg-slate-800/70 border border-white/10 focus:border-purple-500/60 rounded-lg text-white text-sm placeholder-slate-500 outline-none transition-colors"
              disabled={inviting}
              aria-label={da ? 'E-mailadresse' : 'Email address'}
            />

            {/* Role select */}
            <div className="relative">
              <select
                id="invite-role"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'tenant_admin' | 'tenant_member')}
                disabled={inviting}
                aria-label={da ? 'Rolle' : 'Role'}
                className="appearance-none pl-3 pr-8 py-2 bg-slate-800/70 border border-white/10 focus:border-purple-500/60 rounded-lg text-white text-sm outline-none transition-colors cursor-pointer"
              >
                <option value="tenant_member">{da ? 'Bruger' : 'Member'}</option>
                <option value="tenant_admin">{da ? 'Admin' : 'Admin'}</option>
              </select>
              <ChevronDown
                size={12}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
              />
            </div>
          </div>

          {inviteStatus === 'error' && inviteError && (
            <p className="flex items-center gap-1.5 text-red-400 text-xs">
              <AlertCircle size={11} />
              {inviteError}
            </p>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleInvite}
              disabled={inviting || !inviteEmail.trim()}
              className="flex items-center gap-1.5 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {inviting && <Loader2 size={12} className="animate-spin" />}
              {da ? 'Send invitation' : 'Send invitation'}
            </button>
            <button
              onClick={() => setShowInvite(false)}
              className="px-4 py-2 text-slate-400 hover:text-slate-200 text-sm transition-colors"
            >
              {da ? 'Annuller' : 'Cancel'}
            </button>
          </div>
        </div>
      )}

      {inviteStatus === 'success' && !showInvite && (
        <p className="flex items-center gap-1.5 text-emerald-400 text-xs">
          <CheckCircle size={11} />
          {da ? 'Invitation sendt.' : 'Invitation sent.'}
        </p>
      )}

      {/* Members list */}
      {!isAdmin ? (
        <p className="text-slate-500 text-sm">
          {da
            ? 'Kun administratorer kan se teammedlemmer.'
            : 'Only administrators can view team members.'}
        </p>
      ) : loading ? (
        <div className="space-y-2 animate-pulse">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-12 bg-slate-700/40 rounded-xl" />
          ))}
        </div>
      ) : members.length === 0 ? (
        <p className="text-slate-500 text-sm">
          {da ? 'Ingen teammedlemmer fundet.' : 'No team members found.'}
        </p>
      ) : (
        <ul className="space-y-2" role="list">
          {members.map((member) => (
            <li
              key={member.id}
              className="flex items-center justify-between gap-3 px-4 py-3 bg-slate-900/40 border border-white/6 rounded-xl"
            >
              <div className="min-w-0">
                <p className="text-white text-sm font-medium truncate">
                  {member.fullName || member.email}
                </p>
                {member.fullName && (
                  <p className="text-slate-500 text-xs truncate">{member.email}</p>
                )}
              </div>
              <div className="shrink-0">
                <RoleBadge isAdmin={member.isAdmin} da={da} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Section: Abonnement ──────────────────────────────────────────────────────

/**
 * Abonnement section — shows current plan and links to billing.
 *
 * @param da - Whether to use Danish strings
 */
function AbonnementSection({ da }: { da: boolean }) {
  const { subscription: ctxSub } = useSubscription();

  const plan = ctxSub ? resolvePlan(ctxSub.planId) : null;

  const statusLabel = ctxSub
    ? ctxSub.status === 'active'
      ? da
        ? 'Aktiv'
        : 'Active'
      : ctxSub.status === 'pending'
        ? da
          ? 'Afventer godkendelse'
          : 'Pending approval'
        : da
          ? 'Annulleret'
          : 'Cancelled'
    : da
      ? 'Intet abonnement'
      : 'No subscription';

  const statusColor =
    ctxSub?.status === 'active'
      ? 'text-emerald-400'
      : ctxSub?.status === 'pending'
        ? 'text-amber-400'
        : 'text-red-400';

  const nextBillingDate = ctxSub?.periodStart
    ? (() => {
        const d = new Date(ctxSub.periodStart);
        d.setMonth(d.getMonth() + 1);
        return d.toLocaleDateString(da ? 'da-DK' : 'en-GB', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        });
      })()
    : null;

  return (
    <div className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-5">
      <div className="flex items-center gap-2">
        <CreditCard size={16} className="text-emerald-400" />
        <h3 className="text-white font-semibold text-sm">{da ? 'Abonnement' : 'Subscription'}</h3>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Plan */}
        <div>
          <p className="text-slate-400 text-xs font-medium mb-1">{da ? 'Plan' : 'Plan'}</p>
          <div className="flex items-center gap-1.5">
            <Crown size={13} className="text-amber-400" />
            <span className="text-white text-sm font-medium">
              {plan ? (da ? plan.nameDa : plan.nameEn) : '—'}
            </span>
          </div>
        </div>

        {/* Status */}
        <div>
          <p className="text-slate-400 text-xs font-medium mb-1">{da ? 'Status' : 'Status'}</p>
          <span className={`text-sm font-medium ${statusColor}`}>{statusLabel}</span>
        </div>

        {/* Next billing */}
        {nextBillingDate && (
          <div>
            <p className="text-slate-400 text-xs font-medium mb-1">
              {da ? 'Næste betaling' : 'Next payment'}
            </p>
            <span className="text-white text-sm">{nextBillingDate}</span>
          </div>
        )}

        {/* AI */}
        <div>
          <p className="text-slate-400 text-xs font-medium mb-1">
            {da ? 'AI-assistent' : 'AI assistant'}
          </p>
          <span className={`text-sm ${plan?.aiEnabled ? 'text-emerald-400' : 'text-slate-500'}`}>
            {plan?.aiEnabled
              ? da
                ? 'Inkluderet'
                : 'Included'
              : da
                ? 'Ikke inkluderet'
                : 'Not included'}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-3 pt-1">
        <a
          href="/dashboard/settings?tab=abonnement"
          className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/20 text-emerald-300 text-sm font-medium rounded-lg transition-colors"
        >
          <ExternalLink size={13} />
          {da ? 'Skift plan' : 'Change plan'}
        </a>
        <a
          href="/dashboard/settings?tab=abonnement"
          className="flex items-center gap-1.5 px-4 py-2 bg-slate-700/40 hover:bg-slate-700/60 border border-white/8 text-slate-300 text-sm font-medium rounded-lg transition-colors"
        >
          {da ? 'Administrer betaling' : 'Manage billing'}
        </a>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * Organisation settings page.
 *
 * Tab bar with three sections: Virksomhed, Team, Abonnement.
 * Follows the same visual pattern as /dashboard/settings.
 */
export default function OrganisationPageClient() {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const router = useRouter();
  const [tab, setTab] = useState<OrgTab>('virksomhed');
  const [isAdmin, setIsAdmin] = useState(false);

  /** Fetch admin status from subscription endpoint */
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/subscription');
        if (res.ok) {
          const data = (await res.json()) as SubscriptionResponse;
          setIsAdmin(data.isAdmin ?? false);
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const tabs: { key: OrgTab; label: string; icon: React.ReactNode }[] = [
    {
      key: 'virksomhed',
      label: da ? 'Virksomhed' : 'Company',
      icon: <Building2 size={14} />,
    },
    { key: 'team', label: da ? 'Team' : 'Team', icon: <Users size={14} /> },
    {
      key: 'abonnement',
      label: da ? 'Abonnement' : 'Subscription',
      icon: <CreditCard size={14} />,
    },
  ];

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ─── Sticky header + tabs ──────────────────────────────────────────── */}
      <div className="px-6 pt-5 pb-0 border-b border-slate-700/50 bg-slate-900/30">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
          >
            <ArrowLeft size={16} />
            {da ? 'Tilbage' : 'Back'}
          </button>
        </div>

        <div className="flex items-center gap-2 mb-3">
          <h1 className="text-white text-xl font-bold">
            {da ? 'Organisationsindstillinger' : 'Organisation settings'}
          </h1>
          {isAdmin && (
            <span className="flex items-center gap-1 px-2 py-0.5 bg-amber-500/15 text-amber-400 text-xs rounded-full border border-amber-500/20">
              <Shield size={10} />
              {da ? 'Admin' : 'Admin'}
            </span>
          )}
        </div>

        {/* Tab bar */}
        <div
          className="flex gap-1 -mb-px"
          role="tablist"
          aria-label={da ? 'Organisationsindstillinger faner' : 'Organisation settings tabs'}
        >
          {tabs.map((item) => (
            <button
              key={item.key}
              role="tab"
              aria-selected={tab === item.key}
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

      {/* ─── Scrollable content ─────────────────────────────────────────────── */}
      <div
        className="flex-1 overflow-y-auto px-6 py-5"
        role="tabpanel"
        aria-label={tabs.find((t) => t.key === tab)?.label}
      >
        <div className="max-w-2xl space-y-5">
          {tab === 'virksomhed' && <VirksomhedSection da={da} isAdmin={isAdmin} />}
          {tab === 'team' && <TeamSection da={da} isAdmin={isAdmin} />}
          {tab === 'abonnement' && <AbonnementSection da={da} />}
        </div>
      </div>
    </div>
  );
}
