'use client';

/**
 * Admin Security Settings — /dashboard/admin/security
 *
 * Konfigurerer session timeout-indstillinger for alle brugere:
 *   - idle_timeout_minutes   — log ud efter X minutters inaktivitet
 *   - absolute_timeout_hours — log ud uanset aktivitet efter X timer
 *   - refresh_token_days     — Supabase refresh-token levetid
 *
 * Indstillinger gemmes i ai_settings-tabellen via PUT /api/admin/ai-settings.
 * Kræver admin-rolle.
 *
 * @see app/api/admin/ai-settings/route.ts — data source
 * @see app/api/session-settings/route.ts — public read endpoint
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  RefreshCw,
  Save,
  ShieldCheck,
  CheckCircle,
  AlertCircle,
  Clock,
  Info,
  LogOut,
} from 'lucide-react';
import { AdminNavTabs } from '../AdminNavTabs';
import { useLanguage } from '@/app/context/LanguageContext';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Session-indstillinger fra ai_settings. */
interface SessionSettings {
  idle_timeout_minutes: number;
  absolute_timeout_hours: number;
  refresh_token_days: number;
}

/** Feedback-besked efter gem-operation. */
interface SaveFeedback {
  key: string;
  success: boolean;
  message: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Admin-side til konfiguration af session timeout.
 * Henter og gemmer indstillinger via /api/admin/ai-settings.
 */
export default function SecurityClient() {
  const { lang } = useLanguage();
  const router = useRouter();
  const da = lang === 'da';

  // ── State ──
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<SaveFeedback | null>(null);

  const [idleMinutes, setIdleMinutes] = useState(60);
  const [absoluteHours, setAbsoluteHours] = useState(24);
  const [refreshDays, setRefreshDays] = useState(30);

  // ── Translations ──
  const t = {
    back: da ? 'Tilbage' : 'Back',
    title: da ? 'Sikkerhed' : 'Security',
    subtitle: da ? 'Session timeout og adgangsstyring' : 'Session timeout and access control',
    refresh: da ? 'Opdater' : 'Refresh',
    save: da ? 'Gem' : 'Save',
    saved: da ? 'Gemt' : 'Saved',
    saveFailed: da ? 'Fejl ved gem' : 'Save failed',
    loading: da ? 'Henter indstillinger…' : 'Loading settings…',
    errLoad: da ? 'Kunne ikke hente indstillinger.' : 'Could not load settings.',

    sessionTitle: da ? 'Session Timeout' : 'Session Timeout',
    sessionDesc: da
      ? 'Konfigurer hvornår brugere automatisk logges ud af BizzAssist.'
      : 'Configure when users are automatically signed out of BizzAssist.',

    idleLabel: da ? 'Idle timeout (minutter)' : 'Idle timeout (minutes)',
    idleDesc: da
      ? 'Brugeren logges ud efter X minutters inaktivitet. En advarsel vises 5 minutter før.'
      : 'User is signed out after X minutes of inactivity. A warning is shown 5 minutes before.',
    idleMin: 5,
    idleMax: 480,

    absoluteLabel: da ? 'Absolut timeout (timer)' : 'Absolute timeout (hours)',
    absoluteDesc: da
      ? 'Brugeren logges ud uanset aktivitet efter X timer siden login.'
      : 'User is signed out regardless of activity after X hours since login.',
    absoluteMin: 1,
    absoluteMax: 720,

    refreshLabel: da ? 'Refresh token levetid (dage)' : 'Refresh token lifetime (days)',
    refreshDesc: da
      ? 'Supabase refresh-token levetid. Kræver Supabase-projektkonfiguration for at træde i kraft.'
      : 'Supabase refresh token lifetime. Requires Supabase project configuration to take effect.',
    refreshMin: 1,
    refreshMax: 365,

    warningNote: da
      ? 'Advarsel vises automatisk 5 minutter inden idle-timeout udløber.'
      : 'Warning is automatically shown 5 minutes before idle timeout expires.',

    oauth2faTitle: da ? 'OAuth 2FA-undtagelse' : 'OAuth 2FA Exception',
    oauth2faDesc: da
      ? 'Brugere der logger ind via Microsoft, Google eller LinkedIn er undtaget fra BizzAssist TOTP 2FA. Disse brugeres identity provider håndterer allerede 2FA.'
      : 'Users who sign in via Microsoft, Google, or LinkedIn are exempt from BizzAssist TOTP 2FA. Their identity provider already handles 2FA.',
    oauth2faStatus: da ? 'Aktiv (ikke konfigurerbar)' : 'Active (not configurable)',
  };

  // ── Fetch settings ──

  /**
   * Henter session-indstillinger fra admin API'en.
   */
  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/ai-settings');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
      }
      const data: Partial<SessionSettings> = await res.json();
      if (typeof data.idle_timeout_minutes === 'number') setIdleMinutes(data.idle_timeout_minutes);
      if (typeof data.absolute_timeout_hours === 'number')
        setAbsoluteHours(data.absolute_timeout_hours);
      if (typeof data.refresh_token_days === 'number') setRefreshDays(data.refresh_token_days);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errLoad);
    } finally {
      setLoading(false);
    }
  }, [t.errLoad]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // ── Save setting ──

  /**
   * Gemmer én indstilling til databasen via admin API'en.
   *
   * @param key   - Nøglen der skal opdateres
   * @param value - Den nye værdi
   */
  const saveSetting = async (key: string, value: number) => {
    setSaving(key);
    setFeedback(null);
    try {
      const res = await fetch('/api/admin/ai-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
      setFeedback({ key, success: true, message: t.saved });
    } catch (err) {
      setFeedback({
        key,
        success: false,
        message: err instanceof Error ? err.message : t.saveFailed,
      });
    } finally {
      setSaving(null);
      setTimeout(() => setFeedback(null), 3000);
    }
  };

  // ── Feedback banner ──
  const FeedbackBanner = ({ settingKey }: { settingKey: string }) =>
    feedback?.key === settingKey ? (
      <div
        className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg ${
          feedback.success ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
        }`}
      >
        {feedback.success ? <CheckCircle size={12} /> : <AlertCircle size={12} />}
        {feedback.message}
      </div>
    ) : null;

  // ── Save button ──
  const SaveBtn = ({ settingKey, onClick }: { settingKey: string; onClick: () => void }) => (
    <button
      onClick={onClick}
      disabled={saving === settingKey}
      className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
    >
      <Save size={14} />
      {t.save}
    </button>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ─── Sticky Header ─── */}
      <div className="sticky top-0 z-20 px-3 sm:px-6 pt-5 pb-0 border-b border-slate-700/50 bg-slate-900/30 backdrop-blur-sm">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
          >
            <ArrowLeft size={16} /> {t.back}
          </button>
        </div>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-3">
            <ShieldCheck size={22} className="text-blue-400" />
            <div>
              <h1 className="text-white text-xl font-bold">{t.title}</h1>
              <p className="text-slate-400 text-sm">{t.subtitle}</p>
            </div>
          </div>
          <button
            onClick={fetchSettings}
            disabled={loading}
            className="flex items-center gap-1.5 text-slate-400 hover:text-white text-sm transition-colors px-3 py-1.5 rounded-lg hover:bg-white/5 disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> {t.refresh}
          </button>
        </div>

        {/* Tab navigation — BIZZ-737: shared component */}
        <AdminNavTabs activeTab="security" da={da} />
      </div>

      {/* ─── Content ─── */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* Loading */}
          {loading && <div className="text-center py-12 text-slate-400 text-sm">{t.loading}</div>}

          {/* Error */}
          {!loading && error && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3">
              <AlertCircle size={16} className="text-red-400 shrink-0" />
              <p className="text-red-300 text-sm">{error}</p>
            </div>
          )}

          {/* ── Session Timeout ── */}
          {!loading && !error && (
            <div className="bg-[#1e293b] border border-white/10 rounded-2xl p-6 space-y-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-amber-500/10 rounded-xl flex items-center justify-center shrink-0">
                  <Clock size={20} className="text-amber-400" />
                </div>
                <div>
                  <h2 className="text-white font-semibold">{t.sessionTitle}</h2>
                  <p className="text-slate-400 text-sm">{t.sessionDesc}</p>
                </div>
              </div>

              {/* Advarsel-note */}
              <div className="flex items-start gap-2 bg-blue-500/5 border border-blue-500/20 rounded-xl px-4 py-3">
                <Info size={14} className="text-blue-400 mt-0.5 shrink-0" />
                <p className="text-slate-400 text-xs leading-relaxed">{t.warningNote}</p>
              </div>

              {/* Idle timeout */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-slate-200 text-sm font-medium">{t.idleLabel}</p>
                    <p className="text-slate-500 text-xs mt-0.5">{t.idleDesc}</p>
                  </div>
                  <FeedbackBanner settingKey="idle_timeout_minutes" />
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min={t.idleMin}
                    max={t.idleMax}
                    value={idleMinutes}
                    onChange={(e) =>
                      setIdleMinutes(
                        Math.max(t.idleMin, Math.min(t.idleMax, Number(e.target.value)))
                      )
                    }
                    className="w-28 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors"
                  />
                  <span className="text-slate-500 text-sm">{da ? 'minutter' : 'minutes'}</span>
                  <SaveBtn
                    settingKey="idle_timeout_minutes"
                    onClick={() => saveSetting('idle_timeout_minutes', idleMinutes)}
                  />
                </div>
              </div>

              <div className="border-t border-white/5" />

              {/* Absolute timeout */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-slate-200 text-sm font-medium">{t.absoluteLabel}</p>
                    <p className="text-slate-500 text-xs mt-0.5">{t.absoluteDesc}</p>
                  </div>
                  <FeedbackBanner settingKey="absolute_timeout_hours" />
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min={t.absoluteMin}
                    max={t.absoluteMax}
                    value={absoluteHours}
                    onChange={(e) =>
                      setAbsoluteHours(
                        Math.max(t.absoluteMin, Math.min(t.absoluteMax, Number(e.target.value)))
                      )
                    }
                    className="w-28 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors"
                  />
                  <span className="text-slate-500 text-sm">{da ? 'timer' : 'hours'}</span>
                  <SaveBtn
                    settingKey="absolute_timeout_hours"
                    onClick={() => saveSetting('absolute_timeout_hours', absoluteHours)}
                  />
                </div>
              </div>

              <div className="border-t border-white/5" />

              {/* Refresh token */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-slate-200 text-sm font-medium">{t.refreshLabel}</p>
                    <p className="text-slate-500 text-xs mt-0.5">{t.refreshDesc}</p>
                  </div>
                  <FeedbackBanner settingKey="refresh_token_days" />
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min={t.refreshMin}
                    max={t.refreshMax}
                    value={refreshDays}
                    onChange={(e) =>
                      setRefreshDays(
                        Math.max(t.refreshMin, Math.min(t.refreshMax, Number(e.target.value)))
                      )
                    }
                    className="w-28 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors"
                  />
                  <span className="text-slate-500 text-sm">{da ? 'dage' : 'days'}</span>
                  <SaveBtn
                    settingKey="refresh_token_days"
                    onClick={() => saveSetting('refresh_token_days', refreshDays)}
                  />
                </div>
              </div>
            </div>
          )}

          {/* ── OAuth 2FA Exception ── */}
          {!loading && !error && (
            <div className="bg-[#1e293b] border border-white/10 rounded-2xl p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-emerald-500/10 rounded-xl flex items-center justify-center shrink-0">
                  <LogOut size={20} className="text-emerald-400" />
                </div>
                <div>
                  <h2 className="text-white font-semibold">{t.oauth2faTitle}</h2>
                  <p className="text-slate-400 text-sm">{t.oauth2faDesc}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 bg-emerald-500/5 border border-emerald-500/20 rounded-xl px-4 py-3">
                <CheckCircle size={14} className="text-emerald-400 shrink-0" />
                <p className="text-emerald-300 text-sm font-medium">{t.oauth2faStatus}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
