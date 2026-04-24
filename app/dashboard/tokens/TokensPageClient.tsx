'use client';

/**
 * Token-side — /dashboard/tokens
 *
 * Kombination af:
 *   1. AI Token Balance Overview — saldo og indkøb af AI-tokens (Stripe)
 *   2. API-nøgler — enterprise REST API-nøgler til system-til-system integration
 *
 * Sektioner:
 *   Tab "AI Tokens":
 *     - Token Balance Overview — fetched from GET /api/subscription
 *     - Buy More Tokens — packs from GET /api/token-packs
 *     - Payment result banners (success / cancelled via searchParams)
 *   Tab "API-nøgler" (BIZZ-54):
 *     - Liste over aktive API-nøgler (prefix + metadata)
 *     - "Opret nøgle" knap → modal med navn + scope-checkboxes
 *     - Vis fuld nøgle én gang med copy-to-clipboard + advarsel
 *     - Tilbakekald-knap pr. nøgle
 *
 * @returns The tokens dashboard page
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Coins,
  Zap,
  ShoppingCart,
  ArrowLeft,
  CheckCircle,
  RefreshCw,
  Key,
  Plus,
  Trash2,
  Copy,
  Check,
  AlertTriangle,
  X,
  Shield,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { formatTokens, resolvePlan, type PlanId } from '@/app/lib/subscriptions';
import { scopeColor } from '@/app/lib/scopeColors';
import type { ApiTokenRecord } from '@/app/api/tokens/route';

// ─── Constants ───────────────────────────────────────────────────────────────

/** All available API scopes with bilingual labels. */
const API_SCOPES = [
  { value: 'read:properties', labelDa: 'Læs ejendomme', labelEn: 'Read properties' },
  { value: 'read:companies', labelDa: 'Læs virksomheder', labelEn: 'Read companies' },
  { value: 'read:people', labelDa: 'Læs personer', labelEn: 'Read people' },
  { value: 'read:ai', labelDa: 'AI-analyse', labelEn: 'AI analysis' },
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

/** Shape returned by GET /api/subscription */
interface SubscriptionResponse {
  email: string;
  fullName: string;
  subscription: {
    planId: PlanId;
    status: string;
    tokensUsedThisMonth: number;
    accumulatedTokens?: number;
    topUpTokens?: number;
    bonusTokens?: number;
    periodStart: string;
  } | null;
  effectiveTokenLimit?: number;
}

/** Shape of a single token pack from GET /api/token-packs */
interface TokenPack {
  id: string;
  nameDa: string;
  nameEn: string;
  tokenAmount: number;
  priceDkk: number;
}

/** Active tab on the page */
type ActiveTab = 'ai' | 'api';

// ─── Translations ───────────────────────────────────────────────────────────

const translations = {
  da: {
    back: 'Tilbage',
    title: 'Tokens & API-nøgler',
    tabAi: 'AI Tokens',
    tabApi: 'API-nøgler',
    // AI tokens
    subtitle: 'Se dit tokenforbrug og køb flere tokens',
    balanceTitle: 'Token-balance',
    planAllocation: 'Plan-allokering pr. måned',
    accumulated: 'Akkumulerede tokens',
    topUp: 'Købte tokens',
    bonus: 'Bonus-tokens',
    usedThisPeriod: 'Brugt denne periode',
    available: 'Tilgængelige',
    of: 'af',
    used: 'brugt',
    buyTitle: 'Køb flere tokens',
    buySubtitle: 'Vælg en pakke for at fylde op',
    buy: 'Køb',
    redirecting: 'Omdirigerer til betaling...',
    loading: 'Indlæser...',
    noSubscription: 'Intet aktivt abonnement fundet.',
    noPacks: 'Ingen token-pakker tilgængelige.',
    paymentSuccess: 'Betaling gennemført! Dine tokens er blevet tilføjet.',
    paymentCancelled: 'Betaling annulleret. Du er ikke blevet opkrævet.',
    unlimited: 'Ubegrænset',
    refresh: 'Opdater',
    perMonth: '/måned',
    dkk: 'DKK',
    tokens: 'tokens',
    // API keys
    apiTitle: 'Enterprise API-nøgler',
    apiSubtitle: 'Opret nøgler til system-til-system integration med BizzAssist REST API v1.',
    apiCreate: 'Opret nøgle',
    apiNoKeys: 'Ingen aktive API-nøgler. Opret din første nøgle for at komme i gang.',
    apiColName: 'Navn',
    apiColPrefix: 'Nøgleprefix',
    apiColScopes: 'Rettigheder',
    apiColCreated: 'Oprettet',
    apiColLastUsed: 'Sidst brugt',
    apiColActions: 'Handlinger',
    apiRevoke: 'Tilbakekald',
    apiRevokeConfirm:
      'Er du sikker på, at du vil tilbagekalde denne nøgle? Den kan ikke genaktiveres.',
    apiNeverUsed: 'Aldrig brugt',
    // Create modal
    modalTitle: 'Opret ny API-nøgle',
    modalName: 'Navn',
    modalNamePlaceholder: 'F.eks. Produktionsnøgle',
    modalScopes: 'Rettigheder (scopes)',
    modalExpiry: 'Udløber om (dage)',
    modalExpiryPlaceholder: 'Tomt = aldrig',
    modalCreate: 'Opret nøgle',
    modalCancel: 'Annuller',
    modalNameRequired: 'Navn er påkrævet',
    modalScopeRequired: 'Vælg mindst ét scope',
    // Token reveal
    revealTitle: 'Din nye API-nøgle',
    revealWarning: 'Gem dette nu — det vises ikke igen',
    revealCopy: 'Kopiér',
    revealCopied: 'Kopieret!',
    revealDone: 'Jeg har gemt nøglen',
    revealDocLink: 'Gå til API-dokumentation',
    // Docs link
    apiDocsLink: 'API-dokumentation',
  },
  en: {
    back: 'Back',
    title: 'Tokens & API Keys',
    tabAi: 'AI Tokens',
    tabApi: 'API Keys',
    // AI tokens
    subtitle: 'View your token usage and buy more tokens',
    balanceTitle: 'Token Balance',
    planAllocation: 'Plan allocation per month',
    accumulated: 'Accumulated tokens',
    topUp: 'Purchased tokens',
    bonus: 'Bonus tokens',
    usedThisPeriod: 'Used this period',
    available: 'Available',
    of: 'of',
    used: 'used',
    buyTitle: 'Buy More Tokens',
    buySubtitle: 'Choose a pack to top up',
    buy: 'Buy',
    redirecting: 'Redirecting to payment...',
    loading: 'Loading...',
    noSubscription: 'No active subscription found.',
    noPacks: 'No token packs available.',
    paymentSuccess: 'Payment successful! Your tokens have been added.',
    paymentCancelled: 'Payment cancelled. You have not been charged.',
    unlimited: 'Unlimited',
    refresh: 'Refresh',
    perMonth: '/month',
    dkk: 'DKK',
    tokens: 'tokens',
    // API keys
    apiTitle: 'Enterprise API Keys',
    apiSubtitle: 'Create keys for system-to-system integration with the BizzAssist REST API v1.',
    apiCreate: 'Create key',
    apiNoKeys: 'No active API keys. Create your first key to get started.',
    apiColName: 'Name',
    apiColPrefix: 'Key prefix',
    apiColScopes: 'Permissions',
    apiColCreated: 'Created',
    apiColLastUsed: 'Last used',
    apiColActions: 'Actions',
    apiRevoke: 'Revoke',
    apiRevokeConfirm: 'Are you sure you want to revoke this key? It cannot be re-activated.',
    apiNeverUsed: 'Never used',
    // Create modal
    modalTitle: 'Create new API key',
    modalName: 'Name',
    modalNamePlaceholder: 'E.g. Production key',
    modalScopes: 'Permissions (scopes)',
    modalExpiry: 'Expires in (days)',
    modalExpiryPlaceholder: 'Empty = never expires',
    modalCreate: 'Create key',
    modalCancel: 'Cancel',
    modalNameRequired: 'Name is required',
    modalScopeRequired: 'Select at least one scope',
    // Token reveal
    revealTitle: 'Your new API key',
    revealWarning: 'Save this now — it will not be shown again',
    revealCopy: 'Copy',
    revealCopied: 'Copied!',
    revealDone: 'I have saved the key',
    revealDocLink: 'View API documentation',
    // Docs link
    apiDocsLink: 'API documentation',
  },
} as const;

// ─── AI Token helpers ────────────────────────────────────────────────────────

/**
 * Returns a Tailwind color class based on available-token percentage.
 *
 * @param pct - Percentage of tokens remaining (0-100)
 * @returns Tailwind color class string
 */
function meterColor(pct: number): string {
  if (pct > 50) return 'bg-emerald-500';
  if (pct > 20) return 'bg-amber-500';
  return 'bg-red-500';
}

/**
 * Returns a Tailwind text color class based on available-token percentage.
 *
 * @param pct - Percentage of tokens remaining (0-100)
 * @returns Tailwind text color class string
 */
function textColor(pct: number): string {
  if (pct > 50) return 'text-emerald-400';
  if (pct > 20) return 'text-amber-400';
  return 'text-red-400';
}

/**
 * Formats a UTC date string to a short locale date string.
 *
 * @param iso - ISO 8601 date string or null
 * @param lang - Current UI language
 * @param fallback - Text to show when iso is null
 * @returns Formatted date string or fallback
 */
function fmtDate(iso: string | null, lang: 'da' | 'en', fallback: string): string {
  if (!iso) return fallback;
  return new Date(iso).toLocaleDateString(lang === 'da' ? 'da-DK' : 'en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

// ─── Sub-components ──────────────────────────────────────────────────────────

/**
 * Small card showing a single token breakdown metric.
 *
 * @param label - Description text
 * @param value - Formatted token value
 * @param sub - Optional subtitle text
 * @param color - Tailwind text color class for the value
 * @param highlight - Whether to apply a subtle highlight border
 */
function BreakdownCard({
  label,
  value,
  sub,
  color,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  color: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg bg-slate-800/40 p-3.5 ${
        highlight ? 'border border-slate-700/50' : 'border border-slate-700/20'
      }`}
    >
      <p className="text-slate-400 text-xs mb-1">{label}</p>
      <p className={`text-lg font-bold ${color}`}>{value}</p>
      {sub && <p className="text-slate-500 text-[11px] mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Create Key Modal ────────────────────────────────────────────────────────

/**
 * Modal dialog for creating a new API key.
 * Collects: name, scopes (checkboxes), optional expiry in days.
 * On submit calls onSubmit with the form data.
 *
 * @param lang - Current UI language
 * @param onSubmit - Called with { name, scopes, expiresInDays? }
 * @param onClose - Called when the user cancels
 * @param creating - Whether the create request is in-flight
 */
function CreateKeyModal({
  lang,
  onSubmit,
  onClose,
  creating,
}: {
  lang: 'da' | 'en';
  onSubmit: (data: { name: string; scopes: string[]; expiresInDays?: number }) => void;
  onClose: () => void;
  creating: boolean;
}) {
  const t = translations[lang];
  const [name, setName] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [expiryDays, setExpiryDays] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  /** First focusable element — used to set initial focus */
  const nameRef = useRef<HTMLInputElement>(null);

  // Set focus on open
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  /**
   * Toggles a scope in the selected scopes array.
   *
   * @param scope - The scope string to toggle
   */
  function toggleScope(scope: string) {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  }

  /** Validates and submits the form. */
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!name.trim()) {
      setFormError(t.modalNameRequired);
      return;
    }
    if (selectedScopes.length === 0) {
      setFormError(t.modalScopeRequired);
      return;
    }

    const expiresInDays = expiryDays.trim() ? parseInt(expiryDays.trim(), 10) : undefined;

    onSubmit({ name: name.trim(), scopes: selectedScopes, expiresInDays });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-key-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel — BIZZ-782: accent-border som øvrige modals */}
      <div className="relative w-full max-w-md rounded-xl bg-slate-800 border border-blue-500/30 shadow-2xl p-6 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2
            id="create-key-modal-title"
            className="text-lg font-semibold text-white flex items-center gap-2"
          >
            <Key className="w-5 h-5 text-blue-400" />
            {t.modalTitle}
          </h2>
          <button
            onClick={onClose}
            aria-label="Luk dialog"
            className="text-slate-400 hover:text-slate-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name */}
          <div>
            <label htmlFor="key-name" className="block text-sm text-slate-200 mb-1.5">
              {t.modalName}
            </label>
            <input
              ref={nameRef}
              id="key-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.modalNamePlaceholder}
              maxLength={100}
              className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-slate-700/50 text-white placeholder-white/30 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>

          {/* Scopes */}
          <fieldset>
            <legend className="text-sm text-slate-200 mb-2">{t.modalScopes}</legend>
            <div className="space-y-2">
              {API_SCOPES.map((scope) => (
                <label
                  key={scope.value}
                  htmlFor={`scope-${scope.value}`}
                  className="flex items-center gap-3 cursor-pointer group"
                >
                  <input
                    id={`scope-${scope.value}`}
                    type="checkbox"
                    checked={selectedScopes.includes(scope.value)}
                    onChange={() => toggleScope(scope.value)}
                    className="w-4 h-4 rounded accent-blue-500"
                  />
                  <span className="text-sm text-slate-200 group-hover:text-slate-100 transition-colors">
                    {lang === 'da' ? scope.labelDa : scope.labelEn}
                    <span className="ml-2 text-slate-500 font-mono text-xs">{scope.value}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {/* Expiry */}
          <div>
            <label htmlFor="key-expiry" className="block text-sm text-slate-200 mb-1.5">
              {t.modalExpiry}
            </label>
            <input
              id="key-expiry"
              type="number"
              value={expiryDays}
              onChange={(e) => setExpiryDays(e.target.value)}
              placeholder={t.modalExpiryPlaceholder}
              min={1}
              max={3650}
              className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-slate-700/50 text-white placeholder-white/30 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>

          {/* Error */}
          {formError && (
            <p className="text-red-400 text-sm flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {formError}
            </p>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={creating}
              className="flex-1 px-4 py-2.5 rounded-lg border border-slate-700/50 text-slate-300 hover:text-slate-100 hover:border-slate-600 transition-colors text-sm disabled:opacity-40"
            >
              {t.modalCancel}
            </button>
            <button
              type="submit"
              disabled={creating}
              className="flex-1 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium transition-colors flex items-center justify-center gap-2"
            >
              {creating ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              {t.modalCreate}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Token Reveal Modal ──────────────────────────────────────────────────────

/**
 * Modal shown immediately after a token is created.
 * Displays the full plaintext token with a copy button and a warning
 * that it will not be shown again. The user must click "done" to dismiss.
 *
 * @param token - The full raw bearer token to display
 * @param lang - Current UI language
 * @param onDone - Called when the user clicks "I have saved the key"
 */
function TokenRevealModal({
  token,
  lang,
  onDone,
}: {
  token: string;
  lang: 'da' | 'en';
  onDone: () => void;
}) {
  const t = translations[lang];
  const [copied, setCopied] = useState(false);

  /**
   * Copies the token to the clipboard and briefly shows a confirmation.
   */
  async function handleCopy() {
    await navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reveal-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Backdrop — no click to close, user must explicitly confirm they saved */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-hidden="true" />

      <div className="relative w-full max-w-lg rounded-xl bg-slate-800 border border-amber-500/30 shadow-2xl p-6 space-y-5">
        {/* Warning banner */}
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-amber-300 font-semibold text-sm">{t.revealWarning}</p>
          </div>
        </div>

        <h2
          id="reveal-modal-title"
          className="text-lg font-semibold text-white flex items-center gap-2"
        >
          <Key className="w-5 h-5 text-blue-400" />
          {t.revealTitle}
        </h2>

        {/* Token value */}
        <div className="relative">
          <pre className="w-full px-4 py-3 rounded-lg bg-black/40 border border-slate-700/50 text-emerald-400 font-mono text-sm break-all whitespace-pre-wrap select-all">
            {token}
          </pre>
          <button
            onClick={handleCopy}
            aria-label={copied ? t.revealCopied : t.revealCopy}
            className="absolute top-2 right-2 p-1.5 rounded bg-white/[0.06] hover:bg-white/[0.12] transition-colors"
          >
            {copied ? (
              <Check className="w-4 h-4 text-emerald-400" />
            ) : (
              <Copy className="w-4 h-4 text-slate-400" />
            )}
          </button>
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3">
          <a
            href="/api-docs"
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 px-4 py-2.5 rounded-lg border border-slate-700/50 text-slate-300 hover:text-slate-100 hover:border-slate-600 transition-colors text-sm text-center"
          >
            {t.revealDocLink}
          </a>
          <button
            onClick={onDone}
            className="flex-1 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors flex items-center justify-center gap-2"
          >
            <CheckCircle className="w-4 h-4" />
            {t.revealDone}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

/**
 * TokensPage — combined page for AI token management and Enterprise API key management.
 *
 * Reads `?tab=api|ai` and `?payment=success|cancelled` from searchParams.
 *
 * @returns The tokens dashboard page
 */
export default function TokensPageClient() {
  const { lang } = useLanguage();
  const t = translations[lang];
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── Tab state ──
  const initialTab: ActiveTab = searchParams.get('tab') === 'api' ? 'api' : 'ai';
  const [activeTab, setActiveTab] = useState<ActiveTab>(initialTab);

  // ── AI token state ──
  const [subData, setSubData] = useState<SubscriptionResponse | null>(null);
  const [packs, setPacks] = useState<TokenPack[]>([]);
  const [loading, setLoading] = useState(true);
  const [buyingPackId, setBuyingPackId] = useState<string | null>(null);

  // ── API key state ──
  const [apiKeys, setApiKeys] = useState<ApiTokenRecord[]>([]);
  const [apiLoading, setApiLoading] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revealToken, setRevealToken] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<number | null>(null);

  /** Payment result from Stripe redirect */
  const paymentResult = searchParams.get('payment');

  // ── Fetch AI subscription + packs ──

  /** Fetches subscription data and token packs from the API. */
  const fetchAiData = useCallback(async () => {
    setLoading(true);
    try {
      const [subRes, packsRes] = await Promise.all([
        fetch('/api/subscription'),
        fetch('/api/token-packs'),
      ]);

      if (subRes.ok) {
        const data: SubscriptionResponse = await subRes.json();
        setSubData(data);
      }

      if (packsRes.ok) {
        const data: TokenPack[] = await packsRes.json();
        setPacks(data);
      }
    } catch {
      // Silently fail — user sees "no subscription" or empty packs
    } finally {
      setLoading(false);
    }
  }, []);

  /** Fetch AI data on mount */
  useEffect(() => {
    fetchAiData();
  }, [fetchAiData]);

  // ── Fetch API keys ──

  /** Fetches the list of active API keys for the tenant. */
  const fetchApiKeys = useCallback(async () => {
    setApiLoading(true);
    try {
      const res = await fetch('/api/tokens');
      if (res.ok) {
        const data: ApiTokenRecord[] = await res.json();
        setApiKeys(data);
      }
    } catch {
      // Silently fail
    } finally {
      setApiLoading(false);
    }
  }, []);

  /** Fetch API keys when tab is active */
  useEffect(() => {
    if (activeTab === 'api') {
      fetchApiKeys();
    }
  }, [activeTab, fetchApiKeys]);

  // ── Derived AI values ──
  const sub = subData?.subscription ?? null;
  const plan = sub ? resolvePlan(sub.planId) : null;
  const isUnlimited = plan ? plan.aiTokensPerMonth === -1 : false;
  const planMonthly = plan?.aiTokensPerMonth ?? 0;
  const accumulated = sub?.accumulatedTokens ?? 0;
  const topUp = sub?.topUpTokens ?? 0;
  const bonus = sub?.bonusTokens ?? 0;
  const used = sub?.tokensUsedThisMonth ?? 0;
  const totalAvailable = subData?.effectiveTokenLimit ?? planMonthly + accumulated + topUp + bonus;
  const remaining = Math.max(0, totalAvailable - used);
  const usagePct = totalAvailable > 0 ? Math.round((remaining / totalAvailable) * 100) : 0;

  // ── AI buy handler ──

  /**
   * Initiates a Stripe checkout session for the given token pack.
   *
   * @param packId - ID of the token pack to purchase
   */
  async function handleBuy(packId: string) {
    setBuyingPackId(packId);
    try {
      const res = await fetch('/api/stripe/create-topup-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId }),
      });

      if (res.ok) {
        const { url } = (await res.json()) as { url?: string };
        if (url) {
          window.location.href = url;
          return;
        }
      }
    } catch {
      // Silently fail
    }
    setBuyingPackId(null);
  }

  // ── API key handlers ──

  /**
   * Creates a new API key with the given name, scopes, and optional expiry.
   *
   * @param data - Form data from the create modal
   */
  async function handleCreateKey(data: { name: string; scopes: string[]; expiresInDays?: number }) {
    setCreating(true);
    try {
      const res = await fetch('/api/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (res.ok) {
        const { token, record } = (await res.json()) as {
          token: string;
          record: ApiTokenRecord;
        };
        setApiKeys((prev) => [record, ...prev]);
        setShowCreateModal(false);
        setRevealToken(token);
      }
    } catch {
      // Error shown in modal via creating state reset
    } finally {
      setCreating(false);
    }
  }

  /**
   * Revokes (soft-deletes) an API key after confirming with the user.
   *
   * @param id - The numeric ID of the token to revoke
   */
  async function handleRevoke(id: number) {
    if (!window.confirm(t.apiRevokeConfirm)) return;

    setRevokingId(id);
    try {
      const res = await fetch(`/api/tokens/${id}`, { method: 'DELETE' });
      if (res.ok || res.status === 204) {
        setApiKeys((prev) => prev.filter((k) => k.id !== id));
      }
    } catch {
      // Silently fail
    } finally {
      setRevokingId(null);
    }
  }

  // ── Render ──

  if (loading && activeTab === 'ai') {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <RefreshCw className="w-6 h-6 text-blue-400 animate-spin" />
        <span className="ml-3 text-slate-300">{t.loading}</span>
      </div>
    );
  }

  return (
    <>
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        {/* ── Back button ── */}
        <button
          onClick={() => router.push('/dashboard')}
          className="flex items-center gap-2 text-slate-400 hover:text-slate-100 transition-colors text-sm"
        >
          <ArrowLeft className="w-4 h-4" />
          {t.back}
        </button>

        {/* ── Page header ── */}
        <div className="space-y-3">
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <Coins className="w-7 h-7 text-amber-400" />
            {t.title}
          </h1>
          {/* BIZZ-782: info-chips matching company/ejendom/person detail-page
              pattern — plan navn + månedligt AI-forbrug vs. tilgængeligt. */}
          {sub && plan && (
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-blue-500/10 text-blue-300 border border-blue-500/20">
                <Zap className="w-3 h-3" />
                {lang === 'da' ? plan.nameDa : plan.nameEn}
              </span>
              {isUnlimited ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                  <Coins className="w-3 h-3" />
                  {t.unlimited}
                </span>
              ) : (
                <span
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border ${
                    usagePct < 20
                      ? 'bg-red-500/10 text-red-300 border-red-500/20'
                      : usagePct < 50
                        ? 'bg-amber-500/10 text-amber-300 border-amber-500/20'
                        : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
                  }`}
                >
                  <Coins className="w-3 h-3" />
                  {formatTokens(remaining)} / {formatTokens(totalAvailable)} {t.tokens}
                </span>
              )}
            </div>
          )}
        </div>

        {/* ── Tab bar ── BIZZ-876: Underlined horizontal pattern matcher
            detail-side-tabs (ejendom/virksomhed/person) — border-b-2 aktiv,
            transparent default. Konsistent på tværs af dashboard. */}
        <div
          role="tablist"
          className="flex gap-4 -mb-px overflow-x-auto scrollbar-hide border-b border-slate-800"
        >
          <button
            role="tab"
            aria-selected={activeTab === 'ai'}
            id="tab-ai"
            aria-controls="panel-ai"
            onClick={() => setActiveTab('ai')}
            className={`flex items-center gap-2 px-2 py-2 text-sm font-medium border-b-2 transition-all whitespace-nowrap ${
              activeTab === 'ai'
                ? 'border-blue-500 text-blue-300'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600'
            }`}
          >
            <Zap className="w-4 h-4" />
            {t.tabAi}
          </button>
          <button
            role="tab"
            aria-selected={activeTab === 'api'}
            id="tab-api"
            aria-controls="panel-api"
            onClick={() => setActiveTab('api')}
            className={`flex items-center gap-2 px-2 py-2 text-sm font-medium border-b-2 transition-all whitespace-nowrap ${
              activeTab === 'api'
                ? 'border-blue-500 text-blue-300'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600'
            }`}
          >
            <Key className="w-4 h-4" />
            {t.tabApi}
          </button>
        </div>

        {/* ════════════════════════════════════
            TAB: AI Tokens
            ════════════════════════════════════ */}
        <div
          role="tabpanel"
          id="panel-ai"
          aria-labelledby="tab-ai"
          hidden={activeTab !== 'ai'}
          className="space-y-8"
        >
          {/* Payment result banners */}
          {paymentResult === 'success' && (
            <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0" />
              <span className="text-emerald-300 text-sm">{t.paymentSuccess}</span>
            </div>
          )}
          {paymentResult === 'cancelled' && (
            <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <ShoppingCart className="w-5 h-5 text-amber-400 shrink-0" />
              <span className="text-amber-300 text-sm">{t.paymentCancelled}</span>
            </div>
          )}

          {/* Token Balance Overview */}
          {!sub ? (
            <div className="rounded-xl bg-slate-800/40 border border-slate-700/40 p-8 text-center text-slate-400">
              {t.noSubscription}
            </div>
          ) : (
            <div className="rounded-xl bg-slate-800/40 border border-slate-700/40 p-6 space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                  <Zap className="w-5 h-5 text-blue-400" />
                  {t.balanceTitle}
                </h2>
                <button
                  onClick={fetchAiData}
                  className="flex items-center gap-1.5 text-slate-400 hover:text-slate-200 transition-colors text-xs"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {t.refresh}
                </button>
              </div>

              {isUnlimited ? (
                <div className="text-center py-4">
                  <span className="text-3xl font-bold text-emerald-400">{t.unlimited}</span>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <span className={`text-3xl font-bold ${textColor(usagePct)}`}>
                      {formatTokens(remaining)}
                    </span>
                    <span className="text-slate-400 text-sm">
                      {t.of} {formatTokens(totalAvailable)} — {formatTokens(used)} {t.used}
                    </span>
                  </div>
                  <div className="w-full h-3 rounded-full bg-slate-700/40 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${meterColor(usagePct)}`}
                      style={{ width: `${Math.min(100, usagePct)}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <BreakdownCard
                  label={t.planAllocation}
                  value={isUnlimited ? t.unlimited : formatTokens(planMonthly)}
                  sub={plan ? (lang === 'da' ? plan.nameDa : plan.nameEn) + t.perMonth : ''}
                  color="text-blue-400"
                />
                <BreakdownCard
                  label={t.accumulated}
                  value={formatTokens(accumulated)}
                  color="text-purple-400"
                />
                <BreakdownCard label={t.topUp} value={formatTokens(topUp)} color="text-amber-400" />
                <BreakdownCard
                  label={t.bonus}
                  value={formatTokens(bonus)}
                  color="text-emerald-400"
                />
                <BreakdownCard
                  label={t.usedThisPeriod}
                  value={formatTokens(used)}
                  color="text-red-400"
                />
                <BreakdownCard
                  label={t.available}
                  value={isUnlimited ? t.unlimited : formatTokens(remaining)}
                  color={isUnlimited ? 'text-emerald-400' : textColor(usagePct)}
                  highlight
                />
              </div>
            </div>
          )}

          {/* Buy More Tokens */}
          <div className="rounded-xl bg-slate-800/40 border border-slate-700/40 p-6 space-y-5">
            <div>
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <ShoppingCart className="w-5 h-5 text-amber-400" />
                {t.buyTitle}
              </h2>
              <p className="text-slate-400 text-sm mt-1">{t.buySubtitle}</p>
            </div>

            {packs.length === 0 ? (
              <div className="text-center py-8 text-slate-500 text-sm">{t.noPacks}</div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {packs.map((pack) => {
                  const isBuying = buyingPackId === pack.id;
                  return (
                    <div
                      key={pack.id}
                      className="rounded-lg bg-slate-800/40 border border-slate-700/40 p-5 flex flex-col items-center gap-3 hover:border-blue-500/30 transition-colors"
                    >
                      <Coins className="w-8 h-8 text-amber-400" />
                      <span className="text-2xl font-bold text-white">
                        {formatTokens(pack.tokenAmount)}
                      </span>
                      <span className="text-slate-400 text-xs">{t.tokens}</span>
                      <span className="text-slate-200 text-sm font-medium">
                        {pack.priceDkk.toLocaleString('da-DK')} {t.dkk}
                      </span>
                      <button
                        onClick={() => handleBuy(pack.id)}
                        disabled={isBuying || buyingPackId !== null}
                        className="w-full mt-1 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors flex items-center justify-center gap-2"
                      >
                        {isBuying ? (
                          <>
                            <RefreshCw className="w-4 h-4 animate-spin" />
                            {t.redirecting}
                          </>
                        ) : (
                          <>
                            <ShoppingCart className="w-4 h-4" />
                            {t.buy}
                          </>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ════════════════════════════════════
            TAB: API Keys (BIZZ-54)
            ════════════════════════════════════ */}
        <div
          role="tabpanel"
          id="panel-api"
          aria-labelledby="tab-api"
          hidden={activeTab !== 'api'}
          className="space-y-6"
        >
          {/* Section header */}
          <div className="rounded-xl bg-slate-800/40 border border-slate-700/40 p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                  <Shield className="w-5 h-5 text-blue-400" />
                  {t.apiTitle}
                </h2>
                <p className="text-slate-400 text-sm">{t.apiSubtitle}</p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <a
                  href="/api-docs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-2 rounded-lg border border-slate-700/50 text-slate-400 hover:text-slate-100 hover:border-slate-600 transition-colors text-xs"
                >
                  {t.apiDocsLink}
                </a>
                <button
                  onClick={() => setShowCreateModal(true)}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  {t.apiCreate}
                </button>
              </div>
            </div>
          </div>

          {/* Keys list */}
          {apiLoading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="w-5 h-5 text-blue-400 animate-spin" />
              <span className="ml-3 text-slate-400 text-sm">{t.loading}</span>
            </div>
          ) : apiKeys.length === 0 ? (
            <div className="rounded-xl bg-slate-800/40 border border-slate-700/40 p-12 text-center">
              <Key className="w-10 h-10 text-white/20 mx-auto mb-3" />
              <p className="text-slate-500 text-sm">{t.apiNoKeys}</p>
            </div>
          ) : (
            <div className="rounded-xl bg-slate-800/40 border border-slate-700/40 overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-700/40">
                    <th className="text-left text-xs text-slate-400 font-medium px-4 py-3">
                      {t.apiColName}
                    </th>
                    <th className="text-left text-xs text-slate-400 font-medium px-4 py-3">
                      {t.apiColPrefix}
                    </th>
                    <th className="text-left text-xs text-slate-400 font-medium px-4 py-3 hidden sm:table-cell">
                      {t.apiColScopes}
                    </th>
                    <th className="text-left text-xs text-slate-400 font-medium px-4 py-3 hidden md:table-cell">
                      {t.apiColCreated}
                    </th>
                    <th className="text-left text-xs text-slate-400 font-medium px-4 py-3 hidden lg:table-cell">
                      {t.apiColLastUsed}
                    </th>
                    <th className="text-right text-xs text-slate-400 font-medium px-4 py-3">
                      {t.apiColActions}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {apiKeys.map((key) => (
                    <tr
                      key={key.id}
                      className="border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02] transition-colors"
                    >
                      {/* Name */}
                      <td className="px-4 py-3">
                        <span className="text-white text-sm font-medium">{key.name}</span>
                      </td>

                      {/* Prefix */}
                      <td className="px-4 py-3">
                        <code className="text-emerald-400 text-xs font-mono bg-black/20 px-2 py-0.5 rounded">
                          {key.prefix}...
                        </code>
                      </td>

                      {/* Scopes — BIZZ-782: farvekodede chips per scope-type */}
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {key.scopes.map((scope) => {
                            const c = scopeColor(scope);
                            return (
                              <span
                                key={scope}
                                className={`text-[10px] px-1.5 py-0.5 rounded border ${c.bg} ${c.text} ${c.border}`}
                              >
                                {scope}
                              </span>
                            );
                          })}
                        </div>
                      </td>

                      {/* Created */}
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="text-slate-400 text-xs">
                          {fmtDate(key.created_at, lang, '—')}
                        </span>
                      </td>

                      {/* Last used */}
                      <td className="px-4 py-3 hidden lg:table-cell">
                        <span className="text-slate-400 text-xs">
                          {fmtDate(key.last_used, lang, t.apiNeverUsed)}
                        </span>
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleRevoke(key.id)}
                          disabled={revokingId === key.id}
                          aria-label={`${t.apiRevoke} ${key.name}`}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors text-xs disabled:opacity-40"
                        >
                          {revokingId === key.id ? (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="w-3.5 h-3.5" />
                          )}
                          {t.apiRevoke}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── Modals ── */}
      {showCreateModal && (
        <CreateKeyModal
          lang={lang}
          onSubmit={handleCreateKey}
          onClose={() => setShowCreateModal(false)}
          creating={creating}
        />
      )}

      {revealToken && (
        <TokenRevealModal token={revealToken} lang={lang} onDone={() => setRevealToken(null)} />
      )}
    </>
  );
}
