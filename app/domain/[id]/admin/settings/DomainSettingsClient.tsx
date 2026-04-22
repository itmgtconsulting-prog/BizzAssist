/**
 * DomainSettingsClient — Domain Admin settings editor with 4 tabs.
 *
 * BIZZ-706: General (name, slug), AI (temp, suffix), Retention, Isolation.
 * Domain Admin only — protected server-side by parent layout + settings API.
 *
 * @module app/domain/[id]/admin/settings/DomainSettingsClient
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Loader2, Save, ArrowLeft, Settings, Cpu, Clock, Shield } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

interface DomainSettingsRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  limits: Record<string, number | string>;
  settings: Record<string, unknown>;
  email_domain_whitelist: string[];
  email_domain_enforcement: 'off' | 'warn' | 'hard';
}

type TabKey = 'general' | 'ai' | 'retention' | 'isolation';

/**
 * 4-tab settings editor for Domain Admins.
 *
 * @param domainId - Domain UUID
 */
export default function DomainSettingsClient({ domainId }: { domainId: string }) {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const [tab, setTab] = useState<TabKey>('general');
  const [data, setData] = useState<DomainSettingsRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Local editable fields
  const [name, setName] = useState('');
  const [aiTemp, setAiTemp] = useState(0.2);
  const [aiSuffix, setAiSuffix] = useState('');
  const [retentionMonths, setRetentionMonths] = useState(24);
  const [whitelist, setWhitelist] = useState('');
  const [enforcement, setEnforcement] = useState<'off' | 'warn' | 'hard'>('warn');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/domain/${domainId}/admin/settings`);
      if (!r.ok) {
        setNotice({ kind: 'err', text: da ? 'Kunne ikke hente' : 'Could not load' });
        return;
      }
      const d = (await r.json()) as DomainSettingsRow;
      setData(d);
      setName(d.name ?? '');
      setAiTemp(Number((d.settings as { ai_temperature?: number })?.ai_temperature ?? 0.2));
      setAiSuffix(String((d.settings as { ai_system_suffix?: string })?.ai_system_suffix ?? ''));
      setRetentionMonths(
        Number((d.limits as { retention_months?: number })?.retention_months ?? 24)
      );
      setWhitelist((d.email_domain_whitelist ?? []).join(', '));
      setEnforcement((d.email_domain_enforcement ?? 'warn') as 'off' | 'warn' | 'hard');
    } finally {
      setLoading(false);
    }
  }, [domainId, da]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      // Only editable fields go in the body — limits.retention_months is read-only
      // for Domain Admin (it's a super-admin-set cap).
      const payload = {
        name,
        settings: {
          ...(data?.settings ?? {}),
          ai_temperature: aiTemp,
          ai_system_suffix: aiSuffix,
        },
        email_domain_whitelist: whitelist
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
        email_domain_enforcement: enforcement,
      };

      const r = await fetch(`/api/domain/${domainId}/admin/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: 'Unknown' }));
        setNotice({
          kind: 'err',
          text: (da ? 'Fejl: ' : 'Error: ') + (err.error || 'unknown'),
        });
      } else {
        setNotice({ kind: 'ok', text: da ? 'Gemt' : 'Saved' });
        await load();
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
      </div>
    );
  }
  if (!data) {
    return <div className="text-center py-20 text-slate-400">Domain not found</div>;
  }

  const tabs: Array<{ key: TabKey; label: string; icon: typeof Settings }> = [
    { key: 'general', label: da ? 'Generel' : 'General', icon: Settings },
    { key: 'ai', label: 'AI', icon: Cpu },
    { key: 'retention', label: da ? 'Opbevaring' : 'Retention', icon: Clock },
    { key: 'isolation', label: da ? 'Isolation' : 'Isolation', icon: Shield },
  ];

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      <Link
        href={`/domain/${domainId}/admin`}
        className="inline-flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
      >
        <ArrowLeft size={14} />
        {da ? 'Tilbage til dashboard' : 'Back to dashboard'}
      </Link>

      <div>
        <h1 className="text-xl font-bold text-white">
          {da ? 'Indstillinger' : 'Settings'} — {data.name}
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          {da
            ? 'Disse indstillinger gælder for hele dette domain'
            : 'These settings apply to this entire domain'}
        </p>
      </div>

      {/* Tabs */}
      <div
        role="tablist"
        aria-label={da ? 'Indstillinger-faner' : 'Settings tabs'}
        className="flex gap-1 border-b border-slate-800"
      >
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = t.key === tab;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                active
                  ? 'text-white border-blue-400'
                  : 'text-slate-400 hover:text-slate-200 border-transparent'
              }`}
            >
              <Icon size={14} />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Panels */}
      <div
        role="tabpanel"
        className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6 space-y-4"
      >
        {tab === 'general' && (
          <>
            <label className="block">
              <span className="text-slate-300 text-sm">{da ? 'Navn' : 'Name'}</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-sm"
              />
            </label>
            <div className="text-slate-500 text-xs">
              {da ? 'Slug' : 'Slug'}: <code>{data.slug}</code> —{' '}
              {da ? 'kan ikke ændres' : 'cannot be changed'}
            </div>
          </>
        )}

        {tab === 'ai' && (
          <>
            <label className="block">
              <span className="text-slate-300 text-sm">
                {da ? 'Temperatur' : 'Temperature'} ({aiTemp.toFixed(2)})
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={aiTemp}
                onChange={(e) => setAiTemp(Number(e.target.value))}
                className="mt-1 w-full"
              />
            </label>
            <label className="block">
              <span className="text-slate-300 text-sm">
                {da ? 'Custom system-prompt suffix' : 'Custom system prompt suffix'}
              </span>
              <textarea
                value={aiSuffix}
                onChange={(e) => setAiSuffix(e.target.value)}
                rows={5}
                className="mt-1 w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-sm font-mono"
              />
            </label>
          </>
        )}

        {tab === 'retention' && (
          <>
            <div className="text-slate-300 text-sm">
              {da ? 'Opbevaringsperiode' : 'Retention period'}: {retentionMonths}{' '}
              {da ? 'måneder' : 'months'}
            </div>
            <p className="text-slate-500 text-xs">
              {da
                ? 'Sættes af Super-admin. Kontakt support for ændring.'
                : 'Set by Super-admin. Contact support to change.'}
            </p>
          </>
        )}

        {tab === 'isolation' && (
          <>
            <label className="block">
              <span className="text-slate-300 text-sm">
                {da
                  ? 'Email-domæne whitelist (komma-separeret)'
                  : 'Email domain whitelist (comma-separated)'}
              </span>
              <input
                type="text"
                value={whitelist}
                onChange={(e) => setWhitelist(e.target.value)}
                placeholder="firma.dk, datter.dk"
                className="mt-1 w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-sm"
              />
            </label>
            <label className="block">
              <span className="text-slate-300 text-sm">{da ? 'Håndhævelse' : 'Enforcement'}</span>
              <select
                value={enforcement}
                onChange={(e) => setEnforcement(e.target.value as 'off' | 'warn' | 'hard')}
                className="mt-1 w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-sm"
              >
                <option value="off">{da ? 'Off (ingen kontrol)' : 'Off (no check)'}</option>
                <option value="warn">
                  {da ? 'Warn (advarsel, tillad alligevel)' : 'Warn (warn but allow)'}
                </option>
                <option value="hard">
                  {da ? 'Hard (bloker invites udenfor whitelist)' : 'Hard (block invites)'}
                </option>
              </select>
            </label>
          </>
        )}
      </div>

      {/* Save bar */}
      <div className="flex items-center justify-between">
        {notice ? (
          <div className={`text-sm ${notice.kind === 'ok' ? 'text-emerald-400' : 'text-rose-400'}`}>
            {notice.text}
          </div>
        ) : (
          <div />
        )}
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-md text-white text-sm font-medium transition-colors"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {da ? 'Gem ændringer' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
