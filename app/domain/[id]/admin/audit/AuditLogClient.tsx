/**
 * AuditLogClient — filtered table + CSV export for the domain audit log.
 *
 * BIZZ-718: Dropdown filters for action + target_type; date-range inputs;
 * CSV download reuses the same filter query string.
 *
 * @module app/domain/[id]/admin/audit/AuditLogClient
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { ArrowLeft, ScrollText, Download, Loader2 } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

interface AuditRow {
  id: string;
  actor_user_id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: unknown;
  created_at: string;
}

/** Known actions so we can offer a dropdown — anything else still renders. */
const KNOWN_ACTIONS = [
  'create_case',
  'update_case',
  'delete_case',
  'upload_case_doc',
  'delete_case_doc',
  'upload_template',
  'update_template',
  'delete_template',
  'new_template_version',
  'rollback_template_version',
  'upload_training_doc',
  'update_training_doc',
  'delete_training_doc',
  'add_member',
  'invite_member',
  'remove_member',
  'update_member_role',
  'update_settings',
  'generate_document',
] as const;

const KNOWN_TARGET_TYPES = [
  'case',
  'case_doc',
  'template',
  'training_doc',
  'user',
  'domain',
] as const;

export default function AuditLogClient({ domainId }: { domainId: string }) {
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState('');
  const [targetType, setTargetType] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');

  const buildQuery = useCallback(() => {
    const p = new URLSearchParams();
    if (action) p.set('action', action);
    if (targetType) p.set('target_type', targetType);
    if (since) p.set('since', since);
    if (until) p.set('until', until);
    return p.toString();
  }, [action, targetType, since, until]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/domain/${domainId}/audit-log?${buildQuery()}`);
      if (r.ok) setRows((await r.json()) as AuditRow[]);
    } finally {
      setLoading(false);
    }
  }, [domainId, buildQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const downloadCsv = () => {
    const q = buildQuery();
    const href = `/api/domain/${domainId}/audit-log?${q ? q + '&' : ''}format=csv`;
    window.location.href = href;
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      <Link
        href={`/domain/${domainId}/admin`}
        className="inline-flex items-center gap-2 text-slate-400 hover:text-white text-sm"
      >
        <ArrowLeft size={14} />
        {da ? 'Tilbage til dashboard' : 'Back to dashboard'}
      </Link>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <ScrollText size={22} className="text-indigo-400" />
            {da ? 'Audit log' : 'Audit log'}
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            {rows.length} {da ? 'handlinger vist (seneste 500)' : 'events shown (most recent 500)'}
          </p>
        </div>
        <button
          onClick={downloadCsv}
          className="flex items-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700/40 rounded-md text-slate-300 text-sm font-medium"
        >
          <Download size={14} />
          {da ? 'Eksportér CSV' : 'Export CSV'}
        </button>
      </div>

      {/* Filters */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
        <label className="block">
          <span className="text-slate-300 text-xs">{da ? 'Handling' : 'Action'}</span>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="mt-1 w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs"
          >
            <option value="">{da ? 'Alle' : 'All'}</option>
            {KNOWN_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-slate-300 text-xs">{da ? 'Mål-type' : 'Target type'}</span>
          <select
            value={targetType}
            onChange={(e) => setTargetType(e.target.value)}
            className="mt-1 w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs"
          >
            <option value="">{da ? 'Alle' : 'All'}</option>
            {KNOWN_TARGET_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-slate-300 text-xs">{da ? 'Fra (dato)' : 'From (date)'}</span>
          <input
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="mt-1 w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs"
          />
        </label>
        <label className="block">
          <span className="text-slate-300 text-xs">{da ? 'Til (dato)' : 'Until (date)'}</span>
          <input
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className="mt-1 w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs"
          />
        </label>
      </div>

      {/* Table */}
      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-10 text-slate-500 text-sm">
            {da ? 'Ingen handlinger fundet' : 'No events found'}
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-400 uppercase border-b border-slate-700/40">
                <th className="text-left px-3 py-2">{da ? 'Tid' : 'Time'}</th>
                <th className="text-left px-3 py-2">{da ? 'Aktør' : 'Actor'}</th>
                <th className="text-left px-3 py-2">{da ? 'Handling' : 'Action'}</th>
                <th className="text-left px-3 py-2">{da ? 'Mål' : 'Target'}</th>
                <th className="text-left px-3 py-2">{da ? 'Detaljer' : 'Metadata'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-700/20 text-slate-300">
                  <td className="px-3 py-2 whitespace-nowrap text-slate-500">
                    {new Date(r.created_at).toLocaleString(da ? 'da-DK' : 'en-GB')}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-500">
                    {r.actor_user_id.slice(0, 8)}…
                  </td>
                  <td className="px-3 py-2">
                    <code className="text-emerald-300">{r.action}</code>
                  </td>
                  <td className="px-3 py-2 text-slate-400">
                    {r.target_type ? (
                      <>
                        {r.target_type}
                        {r.target_id && (
                          <span className="text-slate-600 ml-1">({r.target_id.slice(0, 8)}…)</span>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500 font-mono text-[10px] truncate max-w-xs">
                    {r.metadata ? JSON.stringify(r.metadata) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
