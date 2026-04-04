'use client';

/**
 * Admin AI Media Agents — /dashboard/admin/ai-media-agents
 *
 * Samlet konfigurationsside for AI-agenterne i BizzAssist:
 *   1. Generelle AI-indstillinger (confidence-tærskel + niveauer)
 *   2. Blokerede domæner (EXCLUDED_ARTICLE_DOMAINS)
 *   3. Virksomheds-agent (Brave API-nøgle, primære medier, max artikler/tokens)
 *   4. Person-agent (kontakt-søgning, telefon-fallback, sociale platforme)
 *
 * Alle indstillinger gemmes i ai_settings-tabellen via PUT /api/admin/ai-settings.
 * Kræver admin-rolle.
 *
 * @see app/api/admin/ai-settings/route.ts — data source
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Bot,
  RefreshCw,
  Users,
  CreditCard,
  Settings,
  BarChart3,
  Save,
  Eye,
  EyeOff,
  X,
  Plus,
  Globe,
  Newspaper,
  User,
  CheckCircle,
  AlertCircle,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

// ─── Standardværdier ─────────────────────────────────────────────────────────

/** Standard-domæner der blokeres fra artikelresultater (konkurrenter). */
const DEFAULT_EXCLUDED_DOMAINS = [
  'ownr.dk',
  'estatistik.dk',
  'profiler.dk',
  'krak.dk',
  'proff.dk',
  'paqle.dk',
  'erhvervplus.dk',
  'lasso.dk',
  'cvrapi.dk',
  'find-virksomhed.dk',
  'virksomhedskartoteket.dk',
  'crunchbase.com',
  'b2bhint.com',
  'resights.dk',
];

/** Standard primære medier-domæner for virksomheds-agent. */
const DEFAULT_PRIMARY_MEDIA = [
  'dr.dk',
  'tv2.dk',
  'borsen.dk',
  'berlingske.dk',
  'politiken.dk',
  'jyllands-posten.dk',
  'bt.dk',
  'eb.dk',
  'version2.dk',
  'computerworld.dk',
];

/** Tilgængelige sociale platforme for person-agent. */
const ALL_SOCIAL_PLATFORMS = [
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'twitter', label: 'X / Twitter' },
  { key: 'youtube', label: 'YouTube' },
];

// ─── Types ────────────────────────────────────────────────────────────────────

/** Alle AI-indstillinger fra ai_settings-tabellen. */
interface AiSettings {
  min_confidence_threshold: number;
  confidence_levels: { hide: number; uncertain: number; confident: number };
  excluded_domains: string[];
  brave_api_key: string;
  primary_media_domains: string[];
  max_articles_per_search: number;
  max_tokens_per_search: number;
  person_contact_search_enabled: boolean;
  person_phone_fallback_enabled: boolean;
  person_social_platforms: string[];
}

/** Feedback-besked efter gem-operation. */
interface SaveFeedback {
  key: string;
  success: boolean;
  message: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Admin-side til konfiguration af AI-agenter.
 * Henter indstillinger fra /api/admin/ai-settings og gemmer via PUT.
 */
export default function AdminAiMediaAgentsPage() {
  const { lang } = useLanguage();
  const router = useRouter();
  const da = lang === 'da';

  // ── State ──
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<SaveFeedback | null>(null);
  const [showBraveKey, setShowBraveKey] = useState(false);

  // Sektion 1: Confidence
  const [confidenceThreshold, setConfidenceThreshold] = useState(70);
  const [confidenceLevels, setConfidenceLevels] = useState({
    hide: 70,
    uncertain: 85,
    confident: 100,
  });

  // Sektion 2: Blokerede domæner
  const [excludedDomains, setExcludedDomains] = useState<string[]>(DEFAULT_EXCLUDED_DOMAINS);
  const [newDomain, setNewDomain] = useState('');

  // Sektion 3: Virksomheds-agent
  const [braveApiKey, setBraveApiKey] = useState('');
  const [primaryMediaDomains, setPrimaryMediaDomains] = useState<string[]>(DEFAULT_PRIMARY_MEDIA);
  const [newMediaDomain, setNewMediaDomain] = useState('');
  const [maxArticles, setMaxArticles] = useState(20);
  const [maxTokens, setMaxTokens] = useState(4096);

  // Sektion 4: Person-agent
  const [contactSearchEnabled, setContactSearchEnabled] = useState(true);
  const [phoneFallbackEnabled, setPhoneFallbackEnabled] = useState(true);
  const [activePlatforms, setActivePlatforms] = useState<string[]>(
    ALL_SOCIAL_PLATFORMS.map((p) => p.key)
  );

  // ── Translations ──
  const t = {
    back: da ? 'Tilbage' : 'Back',
    title: da ? 'AI-agenter' : 'AI Agents',
    subtitle: da
      ? 'Konfigurer AI-agenterne og mediesøgning'
      : 'Configure AI agents and media search',
    refresh: da ? 'Opdater' : 'Refresh',
    save: da ? 'Gem' : 'Save',
    saved: da ? 'Gemt' : 'Saved',
    saveFailed: da ? 'Fejl ved gem' : 'Save failed',
    loading: da ? 'Henter indstillinger…' : 'Loading settings…',

    // Sektion 1
    sec1Title: da ? 'Generelle AI-indstillinger' : 'General AI Settings',
    sec1Desc: da
      ? 'Styr hvornår AI-links vises baseret på confidence-score.'
      : 'Control when AI links are shown based on confidence score.',
    confidenceThreshold: da ? 'Confidence-tærskel' : 'Confidence threshold',
    confidenceThresholdDesc: da
      ? 'Links med score under denne grænse skjules for brugeren.'
      : 'Links with score below this threshold are hidden from users.',
    hideBelowLabel: da ? 'Skjul under' : 'Hide below',
    uncertainLabel: da ? 'Usikker over' : 'Uncertain above',
    confidentLabel: da ? 'Sikker over' : 'Confident above',

    // Sektion 2
    sec2Title: da ? 'Blokerede domæner' : 'Blocked Domains',
    sec2Desc: da
      ? 'Disse domæner vises aldrig som artikelresultater (konkurrenter, telefonbøger mv.).'
      : 'These domains are never shown as article results (competitors, phone directories, etc.).',
    addDomain: da ? 'Tilføj domæne' : 'Add domain',
    domainPlaceholder: da ? 'f.eks. eksempel.dk' : 'e.g. example.com',

    // Sektion 3
    sec3Title: da ? 'Virksomheds-agent (AI Artikel Søgning)' : 'Company Agent (AI Article Search)',
    sec3Desc: da
      ? 'Konfigurer Brave Search og medieprioriteringer for virksomhedssøgning.'
      : 'Configure Brave Search and media priorities for company search.',
    braveKeyLabel: da ? 'Brave Search API-nøgle' : 'Brave Search API Key',
    braveKeyDesc: da
      ? 'Subscription Token fra Brave Search API-konsollen.'
      : 'Subscription Token from the Brave Search API console.',
    primaryMediaLabel: da ? 'Primære medier-domæner' : 'Primary media domains',
    primaryMediaDesc: da
      ? 'Domæner der prioriteres i søgeforespørgsler.'
      : 'Domains prioritized in search queries.',
    maxArticlesLabel: da ? 'Max artikler per søgning' : 'Max articles per search',
    maxTokensLabel: da ? 'Max tokens per søgning' : 'Max tokens per search',
    addMedia: da ? 'Tilføj medie' : 'Add media',
    mediaPlaceholder: da ? 'f.eks. dr.dk' : 'e.g. dr.dk',

    // Sektion 4
    sec4Title: da ? 'Person-agent (AI Person Søgning)' : 'Person Agent (AI Person Search)',
    sec4Desc: da
      ? 'Styr kontakt-søgning og sociale medier-platforme for person-søgninger.'
      : 'Control contact search and social media platforms for person searches.',
    contactSearchLabel: da ? 'Kontakt-søgning' : 'Contact search',
    contactSearchDesc: da
      ? 'Søg efter adresse, telefon og email for personer.'
      : 'Search for address, phone and email for people.',
    phoneFallbackLabel: da ? 'Telefon-fallback' : 'Phone fallback',
    phoneFallbackDesc: da
      ? 'Kør sekundær søgning efter telefon hvis adresse fundet men ikke telefon.'
      : 'Run secondary phone search if address found but not phone.',
    socialPlatformsLabel: da ? 'Sociale medier-platforme' : 'Social media platforms',
    socialPlatformsDesc: da
      ? 'Vælg hvilke platforme der søges for personers profiler.'
      : "Choose which platforms are searched for people's profiles.",
  };

  // ── Fetch settings ──

  /**
   * Henter alle AI-indstillinger fra API'en og populerer lokal state.
   */
  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/ai-settings');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data: Partial<AiSettings> = await res.json();

      if (typeof data.min_confidence_threshold === 'number') {
        setConfidenceThreshold(data.min_confidence_threshold);
      }
      if (data.confidence_levels && typeof data.confidence_levels === 'object') {
        setConfidenceLevels({
          hide: data.confidence_levels.hide ?? 70,
          uncertain: data.confidence_levels.uncertain ?? 85,
          confident: data.confidence_levels.confident ?? 100,
        });
      }
      if (Array.isArray(data.excluded_domains) && data.excluded_domains.length > 0) {
        setExcludedDomains(data.excluded_domains);
      }
      if (typeof data.brave_api_key === 'string') {
        setBraveApiKey(data.brave_api_key);
      }
      if (Array.isArray(data.primary_media_domains) && data.primary_media_domains.length > 0) {
        setPrimaryMediaDomains(data.primary_media_domains);
      }
      if (typeof data.max_articles_per_search === 'number') {
        setMaxArticles(data.max_articles_per_search);
      }
      if (typeof data.max_tokens_per_search === 'number') {
        setMaxTokens(data.max_tokens_per_search);
      }
      if (typeof data.person_contact_search_enabled === 'boolean') {
        setContactSearchEnabled(data.person_contact_search_enabled);
      }
      if (typeof data.person_phone_fallback_enabled === 'boolean') {
        setPhoneFallbackEnabled(data.person_phone_fallback_enabled);
      }
      if (Array.isArray(data.person_social_platforms) && data.person_social_platforms.length > 0) {
        setActivePlatforms(data.person_social_platforms);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // ── Save helper ──

  /**
   * Gemmer én indstilling til AI-settings API via PUT.
   * Viser kortvarig feedback-besked efterfølgende.
   *
   * @param key   - Settings-nøgle
   * @param value - Ny værdi
   */
  const saveSetting = async (key: string, value: unknown) => {
    setSaving(key);
    setFeedback(null);
    try {
      const res = await fetch('/api/admin/ai-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setFeedback({ key, success: true, message: t.saved });
    } catch (err) {
      setFeedback({
        key,
        success: false,
        message: err instanceof Error ? err.message : t.saveFailed,
      });
    } finally {
      setSaving(null);
      // Ryd feedback efter 3 sekunder
      setTimeout(() => setFeedback(null), 3000);
    }
  };

  // ── Domain helpers ──

  /** Tilføjer et nyt domæne til blokerings-listen og gemmer med det samme. */
  const addExcludedDomain = () => {
    const d = newDomain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0];
    if (!d || excludedDomains.includes(d)) return;
    const updated = [...excludedDomains, d];
    setExcludedDomains(updated);
    setNewDomain('');
    saveSetting('excluded_domains', updated);
  };

  /** Fjerner et domæne fra blokerings-listen og gemmer. */
  const removeExcludedDomain = (domain: string) => {
    const updated = excludedDomains.filter((d) => d !== domain);
    setExcludedDomains(updated);
    saveSetting('excluded_domains', updated);
  };

  /** Tilføjer et nyt primært medie-domæne og gemmer. */
  const addMediaDomain = () => {
    const d = newMediaDomain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0];
    if (!d || primaryMediaDomains.includes(d)) return;
    const updated = [...primaryMediaDomains, d];
    setPrimaryMediaDomains(updated);
    setNewMediaDomain('');
    saveSetting('primary_media_domains', updated);
  };

  /** Fjerner et primært medie-domæne og gemmer. */
  const removeMediaDomain = (domain: string) => {
    const updated = primaryMediaDomains.filter((d) => d !== domain);
    setPrimaryMediaDomains(updated);
    saveSetting('primary_media_domains', updated);
  };

  /** Toggler en social platform on/off og gemmer. */
  const togglePlatform = (key: string) => {
    const updated = activePlatforms.includes(key)
      ? activePlatforms.filter((p) => p !== key)
      : [...activePlatforms, key];
    setActivePlatforms(updated);
    saveSetting('person_social_platforms', updated);
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
  const SaveBtn = ({
    settingKey,
    onClick,
    disabled,
  }: {
    settingKey: string;
    onClick: () => void;
    disabled?: boolean;
  }) => (
    <button
      onClick={onClick}
      disabled={saving === settingKey || disabled}
      className="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
    >
      {saving === settingKey ? (
        <RefreshCw size={13} className="animate-spin" />
      ) : (
        <Save size={13} />
      )}
      {t.save}
    </button>
  );

  // ── Toggle switch ──
  const Toggle = ({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) => (
    <button
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
        enabled ? 'bg-blue-600' : 'bg-slate-600'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          enabled ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
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
            <Bot size={22} className="text-blue-400" />
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

        {/* Tab navigation */}
        <div className="flex gap-1 -mb-px overflow-x-auto mt-4">
          <Link
            href="/dashboard/admin/users"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap"
          >
            <Users size={14} /> {da ? 'Brugere' : 'Users'}
          </Link>
          <Link
            href="/dashboard/admin/billing"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap"
          >
            <CreditCard size={14} /> {da ? 'Fakturering' : 'Billing'}
          </Link>
          <Link
            href="/dashboard/admin/plans"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap"
          >
            <Settings size={14} /> {da ? 'Planer' : 'Plans'}
          </Link>
          <Link
            href="/dashboard/admin/analytics"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap"
          >
            <BarChart3 size={14} /> {da ? 'Analyse' : 'Analytics'}
          </Link>
          <span className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-blue-500 text-blue-300 font-medium cursor-default whitespace-nowrap">
            <Bot size={14} /> {da ? 'AI-agenter' : 'AI Agents'}
          </span>
        </div>
      </div>

      {/* ─── Content ─── */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* Loading */}
          {loading && (
            <div className="text-center py-20">
              <RefreshCw size={24} className="animate-spin text-blue-400 mx-auto mb-3" />
              <p className="text-slate-500 text-sm">{t.loading}</p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          {!loading && (
            <>
              {/* ══════════════════════════════════════════════════════════════
                  SEKTION 1: Generelle AI-indstillinger
              ══════════════════════════════════════════════════════════════ */}
              <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5 space-y-5">
                <div className="flex items-start gap-3">
                  <Settings size={18} className="text-blue-400 mt-0.5 shrink-0" />
                  <div>
                    <h2 className="text-white font-semibold">{t.sec1Title}</h2>
                    <p className="text-slate-400 text-sm mt-0.5">{t.sec1Desc}</p>
                  </div>
                </div>

                {/* Confidence threshold slider */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-slate-200">
                      {t.confidenceThreshold}
                    </label>
                    <span className="text-blue-400 font-mono text-sm font-bold">
                      {confidenceThreshold}%
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">{t.confidenceThresholdDesc}</p>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={confidenceThreshold}
                    onChange={(e) => setConfidenceThreshold(Number(e.target.value))}
                    className="w-full h-2 bg-slate-700 rounded-full appearance-none cursor-pointer accent-blue-500"
                  />
                  <div className="flex justify-between text-[10px] text-slate-600">
                    <span>0%</span>
                    <span>50%</span>
                    <span>100%</span>
                  </div>
                </div>

                {/* Confidence levels */}
                <div className="space-y-3">
                  <p className="text-sm font-medium text-slate-200">
                    {da ? 'Confidence-niveauer' : 'Confidence levels'}
                  </p>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs text-slate-400">{t.hideBelowLabel}</label>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={confidenceLevels.hide}
                          onChange={(e) =>
                            setConfidenceLevels((prev) => ({
                              ...prev,
                              hide: Number(e.target.value),
                            }))
                          }
                          className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-2 py-1.5 text-white text-sm text-center focus:outline-none focus:border-blue-500"
                        />
                        <span className="text-slate-500 text-xs">%</span>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-slate-400">{t.uncertainLabel}</label>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={confidenceLevels.uncertain}
                          onChange={(e) =>
                            setConfidenceLevels((prev) => ({
                              ...prev,
                              uncertain: Number(e.target.value),
                            }))
                          }
                          className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-2 py-1.5 text-white text-sm text-center focus:outline-none focus:border-blue-500"
                        />
                        <span className="text-slate-500 text-xs">%</span>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-slate-400">{t.confidentLabel}</label>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={confidenceLevels.confident}
                          onChange={(e) =>
                            setConfidenceLevels((prev) => ({
                              ...prev,
                              confident: Number(e.target.value),
                            }))
                          }
                          className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-2 py-1.5 text-white text-sm text-center focus:outline-none focus:border-blue-500"
                        />
                        <span className="text-slate-500 text-xs">%</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-1">
                  <SaveBtn
                    settingKey="min_confidence_threshold"
                    onClick={async () => {
                      await saveSetting('min_confidence_threshold', confidenceThreshold);
                      await saveSetting('confidence_levels', confidenceLevels);
                    }}
                  />
                  <FeedbackBanner settingKey="min_confidence_threshold" />
                </div>
              </section>

              {/* ══════════════════════════════════════════════════════════════
                  SEKTION 2: Blokerede domæner
              ══════════════════════════════════════════════════════════════ */}
              <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5 space-y-4">
                <div className="flex items-start gap-3">
                  <Globe size={18} className="text-red-400 mt-0.5 shrink-0" />
                  <div>
                    <h2 className="text-white font-semibold">{t.sec2Title}</h2>
                    <p className="text-slate-400 text-sm mt-0.5">{t.sec2Desc}</p>
                  </div>
                </div>

                {/* Domain list */}
                <div className="flex flex-wrap gap-2">
                  {excludedDomains.map((domain) => (
                    <span
                      key={domain}
                      className="flex items-center gap-1.5 px-2.5 py-1 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-300"
                    >
                      {domain}
                      <button
                        onClick={() => removeExcludedDomain(domain)}
                        className="text-red-400 hover:text-red-200 transition-colors"
                        title={da ? 'Fjern' : 'Remove'}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>

                {/* Add domain input */}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newDomain}
                    onChange={(e) => setNewDomain(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addExcludedDomain()}
                    placeholder={t.domainPlaceholder}
                    className="flex-1 bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={addExcludedDomain}
                    disabled={!newDomain.trim()}
                    className="flex items-center gap-1.5 text-sm px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg transition-colors"
                  >
                    <Plus size={14} /> {t.addDomain}
                  </button>
                </div>

                <FeedbackBanner settingKey="excluded_domains" />
              </section>

              {/* ══════════════════════════════════════════════════════════════
                  SEKTION 3: Virksomheds-agent
              ══════════════════════════════════════════════════════════════ */}
              <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5 space-y-5">
                <div className="flex items-start gap-3">
                  <Newspaper size={18} className="text-amber-400 mt-0.5 shrink-0" />
                  <div>
                    <h2 className="text-white font-semibold">{t.sec3Title}</h2>
                    <p className="text-slate-400 text-sm mt-0.5">{t.sec3Desc}</p>
                  </div>
                </div>

                {/* Brave API key */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-200">{t.braveKeyLabel}</label>
                  <p className="text-xs text-slate-500">{t.braveKeyDesc}</p>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <input
                        type={showBraveKey ? 'text' : 'password'}
                        value={braveApiKey}
                        onChange={(e) => setBraveApiKey(e.target.value)}
                        placeholder="BSA..."
                        className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 pr-10 text-white text-sm placeholder-slate-600 font-mono focus:outline-none focus:border-blue-500"
                      />
                      <button
                        onClick={() => setShowBraveKey((v) => !v)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                      >
                        {showBraveKey ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                    <SaveBtn
                      settingKey="brave_api_key"
                      onClick={() => saveSetting('brave_api_key', braveApiKey)}
                    />
                  </div>
                  <FeedbackBanner settingKey="brave_api_key" />
                </div>

                {/* Primary media domains */}
                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-medium text-slate-200">{t.primaryMediaLabel}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{t.primaryMediaDesc}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {primaryMediaDomains.map((domain) => (
                      <span
                        key={domain}
                        className="flex items-center gap-1.5 px-2.5 py-1 bg-blue-500/10 border border-blue-500/20 rounded-lg text-xs text-blue-300"
                      >
                        {domain}
                        <button
                          onClick={() => removeMediaDomain(domain)}
                          className="text-blue-400 hover:text-blue-200 transition-colors"
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newMediaDomain}
                      onChange={(e) => setNewMediaDomain(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && addMediaDomain()}
                      placeholder={t.mediaPlaceholder}
                      className="flex-1 bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-blue-500"
                    />
                    <button
                      onClick={addMediaDomain}
                      disabled={!newMediaDomain.trim()}
                      className="flex items-center gap-1.5 text-sm px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg transition-colors"
                    >
                      <Plus size={14} /> {t.addMedia}
                    </button>
                  </div>
                  <FeedbackBanner settingKey="primary_media_domains" />
                </div>

                {/* Max articles slider */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-slate-200">
                      {t.maxArticlesLabel}
                    </label>
                    <span className="text-blue-400 font-mono text-sm font-bold">{maxArticles}</span>
                  </div>
                  <input
                    type="range"
                    min={5}
                    max={30}
                    value={maxArticles}
                    onChange={(e) => setMaxArticles(Number(e.target.value))}
                    className="w-full h-2 bg-slate-700 rounded-full appearance-none cursor-pointer accent-blue-500"
                  />
                  <div className="flex justify-between text-[10px] text-slate-600">
                    <span>5</span>
                    <span>15</span>
                    <span>30</span>
                  </div>
                </div>

                {/* Max tokens input */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-200">{t.maxTokensLabel}</label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="number"
                      min={512}
                      max={16384}
                      step={256}
                      value={maxTokens}
                      onChange={(e) => setMaxTokens(Number(e.target.value))}
                      className="w-36 bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-blue-500"
                    />
                    <span className="text-slate-500 text-xs">tokens</span>
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-1">
                  <SaveBtn
                    settingKey="max_articles_per_search"
                    onClick={async () => {
                      await saveSetting('max_articles_per_search', maxArticles);
                      await saveSetting('max_tokens_per_search', maxTokens);
                    }}
                  />
                  <FeedbackBanner settingKey="max_articles_per_search" />
                </div>
              </section>

              {/* ══════════════════════════════════════════════════════════════
                  SEKTION 4: Person-agent
              ══════════════════════════════════════════════════════════════ */}
              <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5 space-y-5">
                <div className="flex items-start gap-3">
                  <User size={18} className="text-emerald-400 mt-0.5 shrink-0" />
                  <div>
                    <h2 className="text-white font-semibold">{t.sec4Title}</h2>
                    <p className="text-slate-400 text-sm mt-0.5">{t.sec4Desc}</p>
                  </div>
                </div>

                {/* Contact search toggle */}
                <div className="flex items-center justify-between gap-4 py-2 border-b border-slate-700/40">
                  <div>
                    <p className="text-sm font-medium text-slate-200">{t.contactSearchLabel}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{t.contactSearchDesc}</p>
                  </div>
                  <Toggle
                    enabled={contactSearchEnabled}
                    onChange={(v) => {
                      setContactSearchEnabled(v);
                      saveSetting('person_contact_search_enabled', v);
                    }}
                  />
                </div>
                <FeedbackBanner settingKey="person_contact_search_enabled" />

                {/* Phone fallback toggle */}
                <div className="flex items-center justify-between gap-4 py-2 border-b border-slate-700/40">
                  <div>
                    <p className="text-sm font-medium text-slate-200">{t.phoneFallbackLabel}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{t.phoneFallbackDesc}</p>
                  </div>
                  <Toggle
                    enabled={phoneFallbackEnabled}
                    onChange={(v) => {
                      setPhoneFallbackEnabled(v);
                      saveSetting('person_phone_fallback_enabled', v);
                    }}
                  />
                </div>
                <FeedbackBanner settingKey="person_phone_fallback_enabled" />

                {/* Social platforms */}
                <div className="space-y-3">
                  <p className="text-sm font-medium text-slate-200">{t.socialPlatformsLabel}</p>
                  <p className="text-xs text-slate-500">{t.socialPlatformsDesc}</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {ALL_SOCIAL_PLATFORMS.map((platform) => {
                      const active = activePlatforms.includes(platform.key);
                      return (
                        <button
                          key={platform.key}
                          onClick={() => togglePlatform(platform.key)}
                          className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                            active
                              ? 'bg-blue-600/20 border-blue-500/40 text-blue-300'
                              : 'bg-slate-900/40 border-slate-700/40 text-slate-500 hover:border-slate-500'
                          }`}
                        >
                          <span
                            className={`w-2 h-2 rounded-full ${active ? 'bg-blue-400' : 'bg-slate-600'}`}
                          />
                          {platform.label}
                        </button>
                      );
                    })}
                  </div>
                  <FeedbackBanner settingKey="person_social_platforms" />
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
