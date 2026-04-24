'use client';

/**
 * Admin System Config — /dashboard/admin/config
 *
 * BIZZ-419: Edit admin-configurable values uden redeploy. Værdier ligger
 * i public.system_config (RLS: super_admin only) og læses af application-
 * code via systemConfig.getConfig().
 *
 * UI-pattern:
 *   - Kategori-tabs (endpoints, email, rate_limits, cache, company,
 *     feature_flags)
 *   - Per-key row med inline-edit af JSON-value
 *   - Gem-knap med optimistic update + toast-feedback
 *   - Søgefelt der filtrerer på key + description (tværs af kategorier)
 *
 * @see app/lib/systemConfig.ts — getConfig helper
 * @see app/api/admin/config/route.ts — GET + PATCH
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Settings,
  Save,
  Search,
  Loader2,
  AlertTriangle,
  Check,
  RefreshCw,
} from 'lucide-react';
import Link from 'next/link';
import { AdminNavTabs } from '../AdminNavTabs';
import { useLanguage } from '@/app/context/LanguageContext';

/** Shape returneret fra /api/admin/config GET. */
interface ConfigRow {
  id: string;
  category: string;
  key: string;
  value: unknown;
  description: string | null;
  updated_at: string;
  updated_by: string | null;
}

/** Fast kategori-rækkefølge i UI. Ukendte kategorier havner sidst. */
const CATEGORY_ORDER = [
  'endpoints',
  'email',
  'rate_limits',
  'cache',
  'company',
  'feature_flags',
] as const;

const CATEGORY_LABELS: Record<string, { da: string; en: string }> = {
  endpoints: { da: 'Endpoints', en: 'Endpoints' },
  email: { da: 'Email', en: 'Email' },
  rate_limits: { da: 'Rate-limits', en: 'Rate limits' },
  cache: { da: 'Cache', en: 'Cache' },
  company: { da: 'Virksomhed', en: 'Company' },
  feature_flags: { da: 'Feature-flags', en: 'Feature flags' },
};

export default function ConfigClient() {
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [configs, setConfigs] = useState<ConfigRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>('endpoints');
  const [search, setSearch] = useState('');
  /** Local edit-state pr. key — holder serialized JSON-string brugeren er ved at skrive. */
  const [editDrafts, setEditDrafts] = useState<Record<string, string>>({});
  /** Per-key "saving"-flag for at disable knappen. */
  const [savingKey, setSavingKey] = useState<string | null>(null);
  /** Per-key success-flag der blinker et sekund efter gem. */
  const [justSaved, setJustSaved] = useState<string | null>(null);
  /** Per-key fejl-besked ved validering eller PATCH-fejl. */
  const [keyErrors, setKeyErrors] = useState<Record<string, string>>({});

  const loadConfigs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/admin/config');
      if (!r.ok) {
        setError(da ? 'Kunne ikke hente konfiguration' : 'Failed to load configuration');
        return;
      }
      const data = (await r.json()) as { configs: ConfigRow[] };
      setConfigs(data.configs ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [da]);

  useEffect(() => {
    void loadConfigs();
  }, [loadConfigs]);

  // Gruppér config-rows efter category
  const byCategory = useMemo(() => {
    const m = new Map<string, ConfigRow[]>();
    for (const c of configs) {
      const arr = m.get(c.category) ?? [];
      arr.push(c);
      m.set(c.category, arr);
    }
    // Sortér rækker pr. kategori efter key
    for (const arr of m.values()) arr.sort((a, b) => a.key.localeCompare(b.key, 'da'));
    return m;
  }, [configs]);

  const visibleCategories = useMemo(() => {
    const known = CATEGORY_ORDER.filter((c) => byCategory.has(c));
    const unknown = Array.from(byCategory.keys()).filter(
      (c) => !(CATEGORY_ORDER as readonly string[]).includes(c)
    );
    return [...known, ...unknown];
  }, [byCategory]);

  // Sikre at activeCategory er gyldig når data loader
  useEffect(() => {
    if (visibleCategories.length === 0) return;
    if (!visibleCategories.includes(activeCategory)) {
      setActiveCategory(visibleCategories[0]);
    }
  }, [visibleCategories, activeCategory]);

  const filteredRows = useMemo(() => {
    let rows = search.trim()
      ? configs.filter((c) => {
          const q = search.toLowerCase();
          return c.key.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q);
        })
      : (byCategory.get(activeCategory) ?? []);
    // Search-match viser på tværs af kategorier, sorteret efter category+key
    if (search.trim()) {
      rows = [...rows].sort((a, b) => {
        const c = a.category.localeCompare(b.category);
        return c !== 0 ? c : a.key.localeCompare(b.key);
      });
    }
    return rows;
  }, [search, configs, byCategory, activeCategory]);

  /**
   * Gem en enkelt værdi via PATCH. Parser JSON-draft — falder tilbage til
   * plain-string hvis ikke gyldig JSON (typisk for single-line email/URL).
   */
  const saveOne = useCallback(
    async (row: ConfigRow) => {
      const raw = editDrafts[row.key];
      if (raw === undefined) return; // ingen ændring
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(raw);
      } catch {
        // Ikke gyldig JSON — behandl som plain-string. Dette er bevidst
        // fordi de fleste config-values er strings uden quotes.
        parsedValue = raw;
      }
      setSavingKey(row.key);
      setKeyErrors((e) => {
        const next = { ...e };
        delete next[row.key];
        return next;
      });
      try {
        const r = await fetch('/api/admin/config', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: row.key, value: parsedValue }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setKeyErrors((e) => ({
            ...e,
            [row.key]: j.error ?? (da ? 'Fejl ved gemning' : 'Save failed'),
          }));
          return;
        }
        // Optimistic update — reload row from server ville være safer men
        // langsommere. Vi tager draft som authoritative.
        setConfigs((prev) =>
          prev.map((c) =>
            c.key === row.key
              ? { ...c, value: parsedValue, updated_at: new Date().toISOString() }
              : c
          )
        );
        setEditDrafts((d) => {
          const next = { ...d };
          delete next[row.key];
          return next;
        });
        setJustSaved(row.key);
        setTimeout(() => setJustSaved((k) => (k === row.key ? null : k)), 1500);
      } catch (err) {
        setKeyErrors((e) => ({
          ...e,
          [row.key]: err instanceof Error ? err.message : 'Unknown error',
        }));
      } finally {
        setSavingKey(null);
      }
    },
    [editDrafts, da]
  );

  return (
    <div className="min-h-screen bg-[#0a1020]">
      <div className="max-w-6xl mx-auto px-6 py-6">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white text-sm transition-colors mb-4"
        >
          <ArrowLeft size={14} />
          {da ? 'Tilbage til dashboard' : 'Back to dashboard'}
        </Link>
        <div className="flex items-center gap-2 mb-2">
          <Settings size={20} className="text-blue-400" />
          <h1 className="text-white text-xl font-bold">
            {da ? 'System-konfiguration' : 'System configuration'}
          </h1>
        </div>
        <p className="text-slate-400 text-sm mb-4">
          {da
            ? 'Rediger admin-konfigurerbare værdier på tværs af systemet. Ændringer slår igennem inden for 5 minutter (cache-TTL).'
            : 'Edit admin-configurable values across the system. Changes take effect within 5 minutes (cache TTL).'}
        </p>

        <AdminNavTabs activeTab="config" da={da} />

        {/* Søgefelt + reload */}
        <div className="mt-6 mb-4 flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={da ? 'Søg i nøgler eller beskrivelser…' : 'Search keys or descriptions…'}
              className="w-full bg-slate-800/40 border border-slate-700/50 rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder:text-slate-500"
            />
          </div>
          <button
            type="button"
            onClick={loadConfigs}
            disabled={loading}
            aria-label={da ? 'Genindlæs' : 'Reload'}
            className="p-2 rounded-lg bg-slate-800/40 border border-slate-700/50 text-slate-300 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* Kategori-tabs (skjules ved aktiv søgning) */}
        {!search.trim() && visibleCategories.length > 0 && (
          <div
            className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-700/40"
            role="tablist"
          >
            {visibleCategories.map((cat) => {
              const isActive = cat === activeCategory;
              const label = CATEGORY_LABELS[cat]?.[da ? 'da' : 'en'] ?? cat;
              const count = byCategory.get(cat)?.length ?? 0;
              return (
                <button
                  key={cat}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveCategory(cat)}
                  className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 transition-colors ${
                    isActive
                      ? 'border-blue-500 text-white'
                      : 'border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {label}
                  <span className="ml-1.5 text-[10px] text-slate-500">({count})</span>
                </button>
              );
            })}
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-rose-500/10 border border-rose-500/30 p-3 mb-4 flex items-center gap-2">
            <AlertTriangle size={14} className="text-rose-400" />
            <p className="text-rose-300 text-sm">{error}</p>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 justify-center py-12 text-slate-400 text-sm">
            <Loader2 size={14} className="animate-spin" />
            {da ? 'Henter konfiguration…' : 'Loading configuration…'}
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="text-center py-12 text-slate-500 text-sm">
            {da ? 'Ingen resultater' : 'No results'}
          </div>
        ) : (
          <div className="space-y-2">
            {filteredRows.map((row) => {
              const draftValue =
                editDrafts[row.key] !== undefined
                  ? editDrafts[row.key]
                  : typeof row.value === 'string'
                    ? row.value
                    : JSON.stringify(row.value, null, 2);
              const isDirty = editDrafts[row.key] !== undefined;
              const isSaving = savingKey === row.key;
              const isJustSaved = justSaved === row.key;
              const errMsg = keyErrors[row.key];
              const isMultiline =
                draftValue.length > 60 || draftValue.includes('\n') || draftValue.includes('{');
              return (
                <div
                  key={row.id}
                  className="rounded-lg bg-slate-800/40 border border-slate-700/50 p-3"
                >
                  <div className="flex flex-wrap items-baseline gap-2 mb-1.5">
                    <code className="text-sm text-blue-300 font-mono">{row.key}</code>
                    {search.trim() && (
                      <span className="px-1.5 py-0.5 bg-slate-700/40 text-slate-400 text-[10px] rounded">
                        {row.category}
                      </span>
                    )}
                    <span className="text-[10px] text-slate-500 ml-auto">
                      {da ? 'Opdateret' : 'Updated'}{' '}
                      {new Date(row.updated_at).toLocaleString(da ? 'da-DK' : 'en-GB')}
                    </span>
                  </div>
                  {row.description && (
                    <p className="text-xs text-slate-400 mb-2">{row.description}</p>
                  )}
                  {isMultiline ? (
                    <textarea
                      value={draftValue}
                      onChange={(e) => setEditDrafts((d) => ({ ...d, [row.key]: e.target.value }))}
                      rows={Math.min(8, (draftValue.match(/\n/g)?.length ?? 0) + 2)}
                      className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs text-white font-mono"
                    />
                  ) : (
                    <input
                      type="text"
                      value={draftValue}
                      onChange={(e) => setEditDrafts((d) => ({ ...d, [row.key]: e.target.value }))}
                      className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white font-mono"
                    />
                  )}
                  {errMsg && <p className="text-[11px] text-rose-300 mt-1">{errMsg}</p>}
                  <div className="flex items-center justify-end gap-2 mt-2">
                    {isDirty && !isSaving && (
                      <button
                        type="button"
                        onClick={() =>
                          setEditDrafts((d) => {
                            const next = { ...d };
                            delete next[row.key];
                            return next;
                          })
                        }
                        className="text-xs px-2 py-1 rounded text-slate-400 hover:text-white hover:bg-slate-800"
                      >
                        {da ? 'Annullér' : 'Cancel'}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={!isDirty || isSaving}
                      onClick={() => void saveOne(row)}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                        !isDirty || isSaving
                          ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                          : isJustSaved
                            ? 'bg-emerald-600 text-white'
                            : 'bg-blue-600 hover:bg-blue-500 text-white'
                      }`}
                    >
                      {isSaving ? (
                        <>
                          <Loader2 size={11} className="animate-spin" />
                          {da ? 'Gemmer…' : 'Saving…'}
                        </>
                      ) : isJustSaved ? (
                        <>
                          <Check size={11} />
                          {da ? 'Gemt' : 'Saved'}
                        </>
                      ) : (
                        <>
                          <Save size={11} />
                          {da ? 'Gem' : 'Save'}
                        </>
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
