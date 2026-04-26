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
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { useSubscription } from '@/app/context/SubscriptionContext';
import { resolvePlan, type UserSubscription } from '@/app/lib/subscriptions';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Tab identifiers for this page */
type OrgTab = 'virksomhed' | 'team' | 'abonnement';

/**
 * BIZZ-271: Self-serve team-API shapes. Member-objekt fra /api/team er
 * lighter-weight end det tidligere /api/admin/users (ingen subscription-info),
 * og rolle er full 3-valued (admin/member/viewer).
 */
interface TeamApiMember {
  user_id: string;
  email: string;
  full_name: string | null;
  role: 'tenant_admin' | 'tenant_member' | 'tenant_viewer';
  joined_at: string;
  is_self: boolean;
}

interface TeamApiInvitation {
  id: string;
  email: string;
  role: 'tenant_admin' | 'tenant_member' | 'tenant_viewer';
  invited_by: string | null;
  expires_at: string;
  created_at: string;
  accepted_at: string | null;
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

// BIZZ-271: RoleBadge-helper fjernet — TeamSection viser rolle inline med
// 3-valued select/badge i stedet for binær isAdmin-bool.

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
 * Team section — self-serve team management.
 *
 * BIZZ-271: Skiftet fra /api/admin/users (super-admin-only) til nyt
 * /api/team (tenant-admin). Tenant-admin kan invitere, ændre rolle og
 * fjerne medlemmer. Non-admin kan se listen + forlade teamet selv.
 *
 * @param da - Whether to use Danish strings
 * @param isAdmin - kept for API compatibility but API echo-bruges til
 *   authoritative rolle-info via viewer_role.
 */
function TeamSection({ da, isAdmin: _isAdminProp }: { da: boolean; isAdmin: boolean }) {
  void _isAdminProp;
  const [members, setMembers] = useState<TeamApiMember[]>([]);
  const [invitations, setInvitations] = useState<TeamApiInvitation[]>([]);
  const [viewerRole, setViewerRole] = useState<
    'tenant_admin' | 'tenant_member' | 'tenant_viewer' | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'tenant_admin' | 'tenant_member' | 'tenant_viewer'>(
    'tenant_member'
  );
  const [inviting, setInviting] = useState(false);
  const [inviteStatus, setInviteStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [inviteError, setInviteError] = useState<string | null>(null);
  /** Per-user "saving"-flag for role-change og remove. */
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const canAdmin = viewerRole === 'tenant_admin';

  const fetchTeam = useCallback(async () => {
    setLoading(true);
    setActionError(null);
    try {
      const res = await fetch('/api/team');
      if (res.ok) {
        const data = (await res.json()) as {
          members: TeamApiMember[];
          invitations: TeamApiInvitation[];
          viewer_role: 'tenant_admin' | 'tenant_member' | 'tenant_viewer';
        };
        setMembers(data.members ?? []);
        setInvitations(data.invitations ?? []);
        setViewerRole(data.viewer_role);
      }
    } catch {
      /* non-fatal — list-fetch fejl er ikke blokerende */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTeam();
  }, [fetchTeam]);

  /** Inviter via nyt /api/team/invite endpoint. */
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
      const res = await fetch('/api/team/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role: inviteRole }),
      });
      if (res.ok) {
        setInviteStatus('success');
        setInviteEmail('');
        setShowInvite(false);
        await fetchTeam();
        setTimeout(() => setInviteStatus('idle'), 4000);
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setInviteError(
          data.error ?? (da ? 'Kunne ikke sende invitation.' : 'Could not send invitation.')
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

  /** Ændre rolle for medlem. */
  const handleRoleChange = async (
    userId: string,
    newRole: 'tenant_admin' | 'tenant_member' | 'tenant_viewer'
  ) => {
    setBusyUserId(userId);
    setActionError(null);
    try {
      const res = await fetch(`/api/team/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(data.error ?? (da ? 'Kunne ikke ændre rolle.' : 'Could not change role.'));
      } else {
        await fetchTeam();
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusyUserId(null);
    }
  };

  /** Fjern medlem. */
  const handleRemove = async (userId: string, email: string) => {
    const confirmed = window.confirm(
      da ? `Fjern ${email} fra teamet?` : `Remove ${email} from the team?`
    );
    if (!confirmed) return;
    setBusyUserId(userId);
    setActionError(null);
    try {
      const res = await fetch(`/api/team/${encodeURIComponent(userId)}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(
          data.error ?? (da ? 'Kunne ikke fjerne medlem.' : 'Could not remove member.')
        );
      } else {
        await fetchTeam();
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusyUserId(null);
    }
  };

  /** Annuller pending invitation. */
  const handleRevoke = async (inviteId: string) => {
    const confirmed = window.confirm(da ? 'Annuller denne invitation?' : 'Revoke this invitation?');
    if (!confirmed) return;
    try {
      const res = await fetch(`/api/team/invitations/${encodeURIComponent(inviteId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(data.error ?? 'Kunne ikke annullere invitationen.');
      } else {
        await fetchTeam();
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Unknown error');
    }
  };

  /** Selv-leave tenant. */
  const handleLeave = async () => {
    const confirmed = window.confirm(
      da
        ? 'Er du sikker på at du vil forlade teamet? Du mister adgang til alle tenant-data.'
        : 'Are you sure you want to leave the team? You will lose access to all tenant data.'
    );
    if (!confirmed) return;
    try {
      const res = await fetch('/api/team/leave', { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(data.error ?? 'Kunne ikke forlade teamet.');
      } else {
        window.location.href = '/login';
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Unknown error');
    }
  };

  const roleLabel = (r: string) =>
    r === 'tenant_admin'
      ? da
        ? 'Admin'
        : 'Admin'
      : r === 'tenant_viewer'
        ? da
          ? 'Viewer'
          : 'Viewer'
        : da
          ? 'Medlem'
          : 'Member';

  return (
    <div className="bg-white/5 border border-white/8 rounded-2xl p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Users size={16} className="text-purple-400" />
          <h3 className="text-white font-semibold text-sm">{da ? 'Team' : 'Team'}</h3>
          {members.length > 0 && <span className="text-xs text-slate-500">({members.length})</span>}
        </div>
        <div className="flex items-center gap-2">
          {canAdmin && (
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
          {viewerRole && (
            <button
              onClick={handleLeave}
              className="px-3 py-1.5 bg-slate-800 hover:bg-rose-900/40 border border-slate-700 hover:border-rose-500/40 text-slate-300 hover:text-rose-200 text-xs rounded-lg transition-colors"
            >
              {da ? 'Forlad team' : 'Leave team'}
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <p className="flex items-center gap-1.5 text-red-400 text-xs">
          <AlertCircle size={11} />
          {actionError}
        </p>
      )}

      {/* Invite form */}
      {showInvite && canAdmin && (
        <div className="bg-slate-900/50 border border-white/8 rounded-xl p-4 space-y-3">
          <p className="text-slate-400 text-xs font-medium">
            {da ? 'Inviter ny bruger' : 'Invite new user'}
          </p>
          <div className="flex gap-2 flex-wrap">
            <input
              id="invite-email"
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder={da ? 'bruger@virksomhed.dk' : 'user@company.com'}
              className="flex-1 min-w-[200px] px-3 py-2 bg-slate-800/70 border border-white/10 focus:border-purple-500/60 rounded-lg text-white text-sm placeholder-slate-500 outline-none transition-colors"
              disabled={inviting}
              aria-label={da ? 'E-mailadresse' : 'Email address'}
            />
            <div className="relative">
              <select
                id="invite-role"
                value={inviteRole}
                onChange={(e) =>
                  setInviteRole(
                    e.target.value as 'tenant_admin' | 'tenant_member' | 'tenant_viewer'
                  )
                }
                disabled={inviting}
                aria-label={da ? 'Rolle' : 'Role'}
                className="appearance-none pl-3 pr-8 py-2 bg-slate-800/70 border border-white/10 focus:border-purple-500/60 rounded-lg text-white text-sm outline-none transition-colors cursor-pointer"
              >
                <option value="tenant_member">{da ? 'Medlem' : 'Member'}</option>
                <option value="tenant_admin">Admin</option>
                <option value="tenant_viewer">{da ? 'Viewer (read-only)' : 'Viewer'}</option>
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
      {loading ? (
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
          {members.map((m) => {
            const busy = busyUserId === m.user_id;
            return (
              <li
                key={m.user_id}
                className="flex items-center justify-between gap-3 px-4 py-3 bg-slate-900/40 border border-white/6 rounded-xl"
              >
                <div className="min-w-0">
                  <p className="text-white text-sm font-medium truncate">
                    {m.full_name || m.email}
                    {m.is_self && (
                      <span className="ml-1.5 text-[10px] text-slate-500">
                        ({da ? 'dig' : 'you'})
                      </span>
                    )}
                  </p>
                  {m.full_name && <p className="text-slate-500 text-xs truncate">{m.email}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {canAdmin && !m.is_self ? (
                    <select
                      value={m.role}
                      disabled={busy}
                      onChange={(e) =>
                        void handleRoleChange(
                          m.user_id,
                          e.target.value as 'tenant_admin' | 'tenant_member' | 'tenant_viewer'
                        )
                      }
                      className="appearance-none pl-2 pr-6 py-1 bg-slate-800/70 border border-white/10 focus:border-purple-500/60 rounded text-white text-xs outline-none transition-colors cursor-pointer"
                    >
                      <option value="tenant_admin">Admin</option>
                      <option value="tenant_member">{da ? 'Medlem' : 'Member'}</option>
                      <option value="tenant_viewer">Viewer</option>
                    </select>
                  ) : (
                    <span className="px-2 py-0.5 bg-slate-700/60 text-slate-300 text-xs rounded">
                      {roleLabel(m.role)}
                    </span>
                  )}
                  {canAdmin && !m.is_self && (
                    <button
                      onClick={() => void handleRemove(m.user_id, m.email)}
                      disabled={busy}
                      className="p-1 rounded text-slate-400 hover:text-rose-300 hover:bg-slate-800 disabled:opacity-50"
                      aria-label={da ? `Fjern ${m.email}` : `Remove ${m.email}`}
                      title={da ? 'Fjern medlem' : 'Remove member'}
                    >
                      {busy ? <Loader2 size={12} className="animate-spin" /> : '✕'}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Pending invitations — kun admins kan revoke */}
      {canAdmin && invitations.length > 0 && (
        <div>
          <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mt-4 mb-2">
            {da ? 'Afventende invitationer' : 'Pending invitations'} ({invitations.length})
          </p>
          <ul className="space-y-2" role="list">
            {invitations.map((inv) => (
              <li
                key={inv.id}
                className="flex items-center justify-between gap-3 px-4 py-2 bg-slate-900/40 border border-amber-500/20 rounded-xl"
              >
                <div className="min-w-0">
                  <p className="text-white text-sm truncate">{inv.email}</p>
                  <p className="text-slate-500 text-xs">
                    {roleLabel(inv.role)} · {da ? 'Udløber' : 'Expires'}{' '}
                    {new Date(inv.expires_at).toLocaleDateString(da ? 'da-DK' : 'en-GB')}
                  </p>
                </div>
                <button
                  onClick={() => void handleRevoke(inv.id)}
                  className="text-xs px-2 py-1 rounded text-slate-400 hover:text-rose-300 hover:bg-slate-800"
                >
                  {da ? 'Annuller' : 'Revoke'}
                </button>
              </li>
            ))}
          </ul>
        </div>
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
