/**
 * DomainUsersClient — Domain Admin user management UI.
 *
 * BIZZ-705: Table of members + invite modal + role toggle + remove action.
 * Respects domain.limits.max_users (returns 403 when cap reached).
 * Fail-safe: cannot remove or demote last admin.
 *
 * @module app/domain/[id]/admin/users/DomainUsersClient
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, UserPlus, Trash2, ShieldCheck, User as UserIcon, Search } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

interface DomainMember {
  id: string;
  user_id: string;
  role: 'admin' | 'member';
  invited_at: string;
  joined_at: string | null;
  email: string | null;
  fullName: string | null;
}

/**
 * Domain Admin users management page.
 *
 * @param domainId - Domain UUID
 */
export default function DomainUsersClient({ domainId }: { domainId: string }) {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const [members, setMembers] = useState<DomainMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [inviting, setInviting] = useState(false);
  // BIZZ-750: search — matches /dashboard/admin/users pattern
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'admin' | 'member'>('all');

  const filteredMembers = members.filter((m) => {
    if (roleFilter !== 'all' && m.role !== roleFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      if (
        !(m.email ?? '').toLowerCase().includes(q) &&
        !(m.fullName ?? '').toLowerCase().includes(q)
      ) {
        return false;
      }
    }
    return true;
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/domain/${domainId}/admin/members`);
      if (r.ok) {
        setMembers((await r.json()) as DomainMember[]);
      } else {
        setNotice({ kind: 'err', text: da ? 'Kunne ikke hente brugere' : 'Could not load users' });
      }
    } finally {
      setLoading(false);
    }
  }, [domainId, da]);

  useEffect(() => {
    void load();
  }, [load]);

  const invite = async () => {
    setInviting(true);
    setNotice(null);
    try {
      const r = await fetch(`/api/domain/${domainId}/admin/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      const d = await r.json();
      if (!r.ok) {
        setNotice({ kind: 'err', text: (da ? 'Fejl: ' : 'Error: ') + (d.error || 'unknown') });
      } else {
        setNotice({
          kind: 'ok',
          text:
            (da ? 'Sendt invitation til ' : 'Invitation sent to ') +
            inviteEmail +
            (d.emailGuardWarning ? ` (${d.emailGuardWarning})` : ''),
        });
        setInviteEmail('');
        setShowInvite(false);
        await load();
      }
    } finally {
      setInviting(false);
    }
  };

  const toggleRole = async (m: DomainMember) => {
    const newRole = m.role === 'admin' ? 'member' : 'admin';
    const r = await fetch(`/api/domain/${domainId}/admin/members`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: m.user_id, role: newRole }),
    });
    if (!r.ok) {
      const d = await r.json();
      setNotice({ kind: 'err', text: d.error || 'Fejl' });
    } else {
      await load();
    }
  };

  const remove = async (m: DomainMember) => {
    if (
      !window.confirm(
        da
          ? `Fjern ${m.email ?? m.user_id} fra domainet?`
          : `Remove ${m.email ?? m.user_id} from domain?`
      )
    )
      return;

    const r = await fetch(`/api/domain/${domainId}/admin/members`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: m.user_id }),
    });
    if (!r.ok) {
      const d = await r.json();
      setNotice({ kind: 'err', text: d.error || 'Fejl' });
    } else {
      await load();
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      {/* BIZZ-752: Back-nav fjernet — DomainAdminTabs i layout.tsx har
          allerede en tilbage-pil til /domain/[id]. */}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">{da ? 'Brugere' : 'Users'}</h1>
          <p className="text-slate-500 text-sm mt-1">
            {members.length} {da ? 'medlemmer' : 'members'}
          </p>
        </div>
        <button
          onClick={() => setShowInvite(true)}
          className="flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded-md text-white text-sm font-medium transition-colors"
        >
          <UserPlus size={14} />
          {da ? 'Inviter bruger' : 'Invite user'}
        </button>
      </div>

      {notice && (
        <div
          className={`text-sm px-4 py-2 rounded-md border ${
            notice.kind === 'ok'
              ? 'bg-emerald-900/20 border-emerald-700/40 text-emerald-300'
              : 'bg-rose-900/20 border-rose-700/40 text-rose-300'
          }`}
        >
          {notice.text}
        </div>
      )}

      {/* BIZZ-750: Search + role filter */}
      {!loading && members.length > 0 && (
        <div className="flex gap-3 items-center">
          <div className="relative flex-1 max-w-xs">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={da ? 'Søg email eller navn…' : 'Search email or name…'}
              className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg pl-9 pr-3 py-2 text-white text-xs placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as 'all' | 'admin' | 'member')}
            className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-3 py-2 text-white text-xs focus:border-blue-500 focus:outline-none"
          >
            <option value="all">{da ? 'Alle roller' : 'All roles'}</option>
            <option value="admin">Admin</option>
            <option value="member">Member</option>
          </select>
        </div>
      )}

      {/* Members table */}
      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
          </div>
        ) : members.length === 0 ? (
          <div className="text-center py-10 text-slate-400 text-sm">
            {da ? 'Ingen brugere endnu' : 'No users yet'}
          </div>
        ) : filteredMembers.length === 0 ? (
          <div className="text-center py-10 text-slate-400 text-sm">
            {da ? 'Ingen brugere matcher filteret.' : 'No users match the filter.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-slate-400 text-xs uppercase border-b border-slate-700/40">
                <th className="text-left px-4 py-3">Email</th>
                <th className="text-left px-4 py-3">{da ? 'Navn' : 'Name'}</th>
                <th className="text-left px-4 py-3">{da ? 'Rolle' : 'Role'}</th>
                <th className="text-left px-4 py-3">{da ? 'Tilmeldt' : 'Joined'}</th>
                <th className="text-right px-4 py-3">{da ? 'Handlinger' : 'Actions'}</th>
              </tr>
            </thead>
            <tbody>
              {filteredMembers.map((m) => (
                <tr key={m.id} className="border-b border-slate-700/20 text-slate-300">
                  <td className="px-4 py-3">{m.email ?? '—'}</td>
                  <td className="px-4 py-3">{m.fullName ?? '—'}</td>
                  <td className="px-4 py-3">
                    {/* BIZZ-757: role badges — green for admin, slate for member */}
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${
                        m.role === 'admin'
                          ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                          : 'bg-slate-700/40 text-slate-300 border-slate-600/30'
                      }`}
                    >
                      {m.role === 'admin' ? <ShieldCheck size={12} /> : <UserIcon size={12} />}
                      {m.role === 'admin' ? (da ? 'Admin' : 'Admin') : da ? 'Member' : 'Member'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-400 text-xs">
                    {m.joined_at
                      ? new Date(m.joined_at).toLocaleDateString()
                      : da
                        ? 'Inviteret'
                        : 'Invited'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => toggleRole(m)}
                      className="text-blue-400 hover:text-blue-300 text-xs mr-3"
                    >
                      {m.role === 'admin'
                        ? da
                          ? 'Gør til member'
                          : 'Make member'
                        : da
                          ? 'Gør til admin'
                          : 'Make admin'}
                    </button>
                    <button
                      onClick={() => remove(m)}
                      aria-label={da ? 'Fjern bruger' : 'Remove user'}
                      className="text-rose-400 hover:text-rose-300"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Invite modal */}
      {showInvite && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="invite-title"
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
          onClick={() => setShowInvite(false)}
        >
          <div
            className="bg-slate-900 border border-slate-700 rounded-xl p-6 max-w-md w-full space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="invite-title" className="text-lg font-bold text-white">
              {da ? 'Inviter bruger' : 'Invite user'}
            </h2>
            <label className="block">
              <span className="text-slate-300 text-sm">Email</span>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="bruger@firma.dk"
                className="mt-1 w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-white text-sm"
              />
            </label>
            <label className="block">
              <span className="text-slate-300 text-sm">{da ? 'Rolle' : 'Role'}</span>
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'admin' | 'member')}
                className="mt-1 w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-white text-sm"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setShowInvite(false)}
                className="px-3 py-2 text-slate-400 hover:text-white text-sm"
              >
                {da ? 'Annuller' : 'Cancel'}
              </button>
              <button
                onClick={invite}
                disabled={!inviteEmail || inviting}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-md text-white text-sm font-medium"
              >
                {inviting && <Loader2 size={14} className="animate-spin" />}
                {da ? 'Send invitation' : 'Send invite'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
