'use client';

/**
 * Admin plan configuration — /dashboard/admin/plans
 *
 * Allows the admin to:
 *   - View, create, edit and delete subscription plans
 *   - Edit plan names (DA/EN), descriptions (DA/EN), color, price, tokens, duration, etc.
 *   - Manage token packs (create, update, delete)
 *
 * Plan data is fetched from /api/admin/plans and token packs from /api/admin/token-packs.
 * Only accessible by admin users.
 *
 * @see app/api/admin/plans/route.ts — plan CRUD API
 * @see app/api/admin/token-packs/route.ts — token pack CRUD API
 * @see app/lib/subscriptions.ts — plan type definitions
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Users,
  CreditCard,
  BarChart3,
  Settings,
  Save,
  Plus,
  Pencil,
  Trash2,
  X,
  Package,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Check,
  ChevronDown,
  ChevronUp,
  Palette,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Editable plan configuration from the API */
interface PlanConfig {
  id: string;
  nameDa: string;
  nameEn: string;
  descDa: string;
  descEn: string;
  color: string;
  priceDkk: number;
  aiTokensPerMonth: number;
  durationMonths: number;
  durationDays: number;
  tokenAccumulationCapMultiplier: number;
  aiEnabled: boolean;
  requiresApproval: boolean;
  isActive: boolean;
  freeTrialDays: number;
  stripePriceId: string;
  maxSales: number | null;
  salesCount: number;
  updatedAt: string | null;
}

/** Token pack definition */
interface TokenPack {
  id: string;
  nameDa: string;
  nameEn: string;
  tokens: number;
  priceDkk: number;
  stripePriceId: string;
  active: boolean;
  sortOrder: number;
}

/** Form state for creating/editing a token pack */
interface TokenPackForm {
  nameDa: string;
  nameEn: string;
  tokens: number;
  priceDkk: number;
  stripePriceId: string;
  active: boolean;
  sortOrder: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Available colors for plan badges */
const COLOR_OPTIONS = [
  { key: 'amber', label: 'Amber', classes: 'bg-amber-500' },
  { key: 'slate', label: 'Slate', classes: 'bg-slate-500' },
  { key: 'blue', label: 'Blue', classes: 'bg-blue-500' },
  { key: 'purple', label: 'Purple', classes: 'bg-purple-500' },
  { key: 'emerald', label: 'Emerald', classes: 'bg-emerald-500' },
  { key: 'rose', label: 'Rose', classes: 'bg-rose-500' },
  { key: 'cyan', label: 'Cyan', classes: 'bg-cyan-500' },
  { key: 'orange', label: 'Orange', classes: 'bg-orange-500' },
  { key: 'indigo', label: 'Indigo', classes: 'bg-indigo-500' },
  { key: 'pink', label: 'Pink', classes: 'bg-pink-500' },
];

/** Color map for plan badge rendering */
const PLAN_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  amber: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/20' },
  slate: { bg: 'bg-slate-500/10', text: 'text-slate-400', border: 'border-slate-500/20' },
  blue: { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/20' },
  purple: { bg: 'bg-purple-500/10', text: 'text-purple-400', border: 'border-purple-500/20' },
  emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/20' },
  rose: { bg: 'bg-rose-500/10', text: 'text-rose-400', border: 'border-rose-500/20' },
  cyan: { bg: 'bg-cyan-500/10', text: 'text-cyan-400', border: 'border-cyan-500/20' },
  orange: { bg: 'bg-orange-500/10', text: 'text-orange-400', border: 'border-orange-500/20' },
  indigo: { bg: 'bg-indigo-500/10', text: 'text-indigo-400', border: 'border-indigo-500/20' },
  pink: { bg: 'bg-pink-500/10', text: 'text-pink-400', border: 'border-pink-500/20' },
};

/** Default values for a new plan */
const NEW_PLAN_DEFAULTS: Omit<PlanConfig, 'id'> = {
  nameDa: '',
  nameEn: '',
  descDa: '',
  descEn: '',
  color: 'blue',
  priceDkk: 0,
  aiTokensPerMonth: 0,
  durationMonths: 1,
  durationDays: 0,
  tokenAccumulationCapMultiplier: 5,
  aiEnabled: false,
  requiresApproval: false,
  isActive: true,
  freeTrialDays: 0,
  stripePriceId: '',
  maxSales: null,
  salesCount: 0,
  updatedAt: null,
};

/** Empty form state for new token packs */
const EMPTY_PACK_FORM: TokenPackForm = {
  nameDa: '',
  nameEn: '',
  tokens: 10000,
  priceDkk: 99,
  stripePriceId: '',
  active: true,
  sortOrder: 0,
};

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * Admin plan configuration page.
 *
 * Section 1: Expandable plan rows with full CRUD (create, edit, delete).
 * Section 2: Token pack management table with inline create/edit/delete.
 */
export default function AdminPlansPage() {
  const { lang } = useLanguage();
  const router = useRouter();
  const da = lang === 'da';

  // ── Plan state ──
  const [plans, setPlans] = useState<PlanConfig[]>([]);
  const [planEdits, setPlanEdits] = useState<Record<string, Partial<PlanConfig>>>({});
  const [planLoading, setPlanLoading] = useState(true);
  const [planError, setPlanError] = useState<string | null>(null);
  const [savingPlan, setSavingPlan] = useState<string | null>(null);
  const [savedPlan, setSavedPlan] = useState<string | null>(null);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const [deletingPlan, setDeletingPlan] = useState<string | null>(null);

  // ── New plan form state ──
  const [showNewPlanForm, setShowNewPlanForm] = useState(false);
  const [newPlanId, setNewPlanId] = useState('');
  const [newPlanData, setNewPlanData] = useState<Omit<PlanConfig, 'id'>>(NEW_PLAN_DEFAULTS);
  const [creatingPlan, setCreatingPlan] = useState(false);

  // ── Token pack state ──
  const [packs, setPacks] = useState<TokenPack[]>([]);
  const [packLoading, setPackLoading] = useState(true);
  const [packError, setPackError] = useState<string | null>(null);
  const [packActionLoading, setPackActionLoading] = useState<string | null>(null);
  const [showPackForm, setShowPackForm] = useState(false);
  const [editingPackId, setEditingPackId] = useState<string | null>(null);
  const [packForm, setPackForm] = useState<TokenPackForm>(EMPTY_PACK_FORM);

  // ── Translations ──
  const t = {
    back: da ? 'Tilbage' : 'Back',
    title: da ? 'Plankonfiguration' : 'Plan Configuration',
    subtitle: da
      ? 'Administrer abonnementsplaner og token-pakker'
      : 'Manage subscription plans and token packs',
    refresh: da ? 'Opdater' : 'Refresh',
    users: da ? 'Brugere' : 'Users',
    billing: da ? 'Fakturering' : 'Billing',
    plans: da ? 'Planer' : 'Plans',
    analytics: da ? 'Analyse' : 'Analytics',
    loading: da ? 'Henter data...' : 'Loading data...',
    errorMsg: da ? 'Fejl ved hentning' : 'Error fetching data',
    retry: da ? 'Prøv igen' : 'Retry',
    planSectionTitle: da ? 'Abonnementsplaner' : 'Subscription Plans',
    planSectionDesc: da
      ? 'Opret, rediger og slet abonnementsplaner'
      : 'Create, edit and delete subscription plans',
    newPlan: da ? 'Ny plan' : 'New plan',
    planId: da ? 'Plan-ID (unikt, ingen mellemrum)' : 'Plan ID (unique, no spaces)',
    nameDa: da ? 'Navn (DA)' : 'Name (DA)',
    nameEn: da ? 'Navn (EN)' : 'Name (EN)',
    descDa: da ? 'Beskrivelse (DA)' : 'Description (DA)',
    descEn: da ? 'Beskrivelse (EN)' : 'Description (EN)',
    color: da ? 'Farve' : 'Color',
    price: da ? 'Pris (DKK)' : 'Price (DKK)',
    aiTokens: da ? 'AI tokens/md' : 'AI tokens/mo',
    durationMonths: da ? 'Måneder' : 'Months',
    durationDays: da ? 'Dage' : 'Days',
    capMultiplier: da ? 'Loft (x)' : 'Cap (x)',
    aiEnabled: da ? 'AI aktiveret' : 'AI enabled',
    requiresApproval: da ? 'Kræver godkendelse' : 'Requires approval',
    active: da ? 'Aktiv' : 'Active',
    freeTrialDays: da ? 'Gratis dage' : 'Free trial days',
    save: da ? 'Gem' : 'Save',
    saved: da ? 'Gemt!' : 'Saved!',
    saving: da ? 'Gemmer...' : 'Saving...',
    create: da ? 'Opret' : 'Create',
    creating: da ? 'Opretter...' : 'Creating...',
    cancel: da ? 'Annuller' : 'Cancel',
    deletePlan: da ? 'Slet plan' : 'Delete plan',
    confirmDeletePlan: da
      ? 'Er du sikker? Denne plan slettes permanent.'
      : 'Are you sure? This plan will be permanently deleted.',
    durationLabel: da ? 'Varighed' : 'Duration',
    durationHint: da
      ? 'Dage har forrang over måneder hvis > 0'
      : 'Days take precedence over months if > 0',
    // Token pack section
    packSectionTitle: da ? 'Token-pakker' : 'Token Packs',
    packSectionDesc: da
      ? 'Administrer token-pakker som brugere kan tilkobe'
      : 'Manage token packs users can purchase',
    packNameDa: da ? 'Navn (DA)' : 'Name (DA)',
    packNameEn: da ? 'Navn (EN)' : 'Name (EN)',
    packTokens: da ? 'Tokens' : 'Tokens',
    packPrice: da ? 'Pris (DKK)' : 'Price (DKK)',
    packStripeId: da ? 'Stripe Price ID' : 'Stripe Price ID',
    packActive: da ? 'Aktiv' : 'Active',
    packSort: da ? 'Sortering' : 'Sort',
    addPack: da ? 'Tilfoj pakke' : 'Add pack',
    editPack: da ? 'Rediger' : 'Edit',
    deletePack: da ? 'Slet' : 'Delete',
    cancelAction: da ? 'Annuller' : 'Cancel',
    createPack: da ? 'Opret' : 'Create',
    updatePack: da ? 'Opdater' : 'Update',
    noPacks: da ? 'Ingen token-pakker endnu' : 'No token packs yet',
    confirmDelete: da
      ? 'Er du sikker pa du vil slette denne pakke?'
      : 'Are you sure you want to delete this pack?',
    maxSales: da ? 'Maks salg' : 'Max sales',
    salesCount: da ? 'Solgt' : 'Sold',
    unlimited: da ? 'Ubegrænset' : 'Unlimited',
    maxSalesHint: da ? 'Tomt = ubegrænset' : 'Empty = unlimited',
  };

  // ─── Data fetching ─────────────────────────────────────────────────────────

  /** Fetch all plan configurations from admin API. */
  const fetchPlans = useCallback(async () => {
    setPlanLoading(true);
    setPlanError(null);
    try {
      const res = await fetch('/api/admin/plans');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: PlanConfig[] = await res.json();
      setPlans(data);
      setPlanEdits({});
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setPlanLoading(false);
    }
  }, []);

  /** Fetch all token packs from admin API. */
  const fetchPacks = useCallback(async () => {
    setPackLoading(true);
    setPackError(null);
    try {
      const res = await fetch('/api/admin/token-packs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: TokenPack[] = await res.json();
      setPacks(data);
    } catch (err) {
      setPackError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setPackLoading(false);
    }
  }, []);

  /** Initial data load on mount. */
  useEffect(() => {
    fetchPlans();
    fetchPacks();
  }, [fetchPlans, fetchPacks]);

  // ─── Plan actions ──────────────────────────────────────────────────────────

  /**
   * Update a local plan edit field.
   *
   * @param planId - Which plan to update
   * @param field - The field name to change
   * @param value - New value for the field
   */
  const updatePlanField = (
    planId: string,
    field: keyof PlanConfig,
    value: number | boolean | string
  ) => {
    setPlanEdits((prev) => ({
      ...prev,
      [planId]: { ...prev[planId], [field]: value },
    }));
  };

  /**
   * Save a plan configuration to the API via upsert.
   *
   * @param planId - Which plan to save
   */
  const savePlan = async (planId: string) => {
    const plan = plans.find((p) => p.id === planId);
    if (!plan) return;

    const edits = planEdits[planId] || {};
    const merged = { ...plan, ...edits };

    setSavingPlan(planId);
    try {
      const res = await fetch('/api/admin/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          planId,
          nameDa: merged.nameDa,
          nameEn: merged.nameEn,
          descDa: merged.descDa,
          descEn: merged.descEn,
          color: merged.color,
          priceDkk: merged.priceDkk,
          aiTokensPerMonth: merged.aiTokensPerMonth,
          durationMonths: merged.durationMonths,
          durationDays: merged.durationDays,
          tokenAccumulationCapMultiplier: merged.tokenAccumulationCapMultiplier,
          aiEnabled: merged.aiEnabled,
          requiresApproval: merged.requiresApproval,
          isActive: merged.isActive,
          freeTrialDays: merged.freeTrialDays,
          stripePriceId: merged.stripePriceId,
          maxSales: merged.maxSales,
          salesCount: merged.salesCount,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setSavedPlan(planId);
      setTimeout(() => setSavedPlan(null), 2000);
      await fetchPlans();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSavingPlan(null);
    }
  };

  /**
   * Create a new plan via the API.
   */
  const createPlan = async () => {
    if (!newPlanId.trim()) return;

    setCreatingPlan(true);
    try {
      const res = await fetch('/api/admin/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          planId: newPlanId.trim().toLowerCase().replace(/\s+/g, '-'),
          ...newPlanData,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setShowNewPlanForm(false);
      setNewPlanId('');
      setNewPlanData(NEW_PLAN_DEFAULTS);
      await fetchPlans();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setCreatingPlan(false);
    }
  };

  /**
   * Delete a plan via the API.
   *
   * @param planId - Which plan to delete
   */
  const handleDeletePlan = async (planId: string) => {
    if (!confirm(t.confirmDeletePlan)) return;

    setDeletingPlan(planId);
    try {
      const res = await fetch('/api/admin/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', planId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      if (expandedPlan === planId) setExpandedPlan(null);
      await fetchPlans();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeletingPlan(null);
    }
  };

  // ─── Token pack actions ────────────────────────────────────────────────────

  /** Open the inline form to create a new token pack. */
  const openCreatePackForm = () => {
    setEditingPackId(null);
    setPackForm(EMPTY_PACK_FORM);
    setShowPackForm(true);
  };

  /**
   * Open the inline form pre-filled for editing an existing pack.
   *
   * @param pack - The token pack to edit
   */
  const openEditPackForm = (pack: TokenPack) => {
    setEditingPackId(pack.id);
    setPackForm({
      nameDa: pack.nameDa,
      nameEn: pack.nameEn,
      tokens: pack.tokens,
      priceDkk: pack.priceDkk,
      stripePriceId: pack.stripePriceId,
      active: pack.active,
      sortOrder: pack.sortOrder,
    });
    setShowPackForm(true);
  };

  /** Close the inline form and reset state. */
  const closePackForm = () => {
    setShowPackForm(false);
    setEditingPackId(null);
    setPackForm(EMPTY_PACK_FORM);
  };

  /** Submit the token pack form — creates or updates depending on editingPackId. */
  const submitPackForm = async () => {
    const action = editingPackId ? 'update' : 'create';
    setPackActionLoading(editingPackId || 'new');
    try {
      const res = await fetch('/api/admin/token-packs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          ...(editingPackId ? { id: editingPackId } : {}),
          nameDa: packForm.nameDa,
          nameEn: packForm.nameEn,
          tokenAmount: packForm.tokens,
          priceDkk: packForm.priceDkk,
          stripePriceId: packForm.stripePriceId,
          isActive: packForm.active,
          sortOrder: packForm.sortOrder,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      closePackForm();
      await fetchPacks();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setPackActionLoading(null);
    }
  };

  /**
   * Delete a token pack after confirmation.
   *
   * @param packId - ID of the pack to delete
   */
  const deletePack = async (packId: string) => {
    if (!confirm(t.confirmDelete)) return;

    setPackActionLoading(packId);
    try {
      const res = await fetch('/api/admin/token-packs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id: packId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await fetchPacks();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setPackActionLoading(null);
    }
  };

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Get the effective value for a plan field, using local edits if present.
   *
   * @param plan - The original plan config
   * @param field - The field to read
   * @returns The edited value if present, otherwise the original
   */
  const getPlanValue = <K extends keyof PlanConfig>(plan: PlanConfig, field: K): PlanConfig[K] => {
    const edits = planEdits[plan.id];
    if (edits && field in edits) return edits[field] as PlanConfig[K];
    return plan[field];
  };

  /**
   * Check if a plan has unsaved changes.
   *
   * @param planId - The plan to check
   * @returns True if there are pending edits
   */
  const planHasChanges = (planId: string): boolean => {
    const edits = planEdits[planId];
    return !!edits && Object.keys(edits).length > 0;
  };

  /**
   * Get the color classes for a plan badge.
   *
   * @param color - The plan color key
   * @returns Tailwind class strings for bg, text, border
   */
  const getBadgeClasses = (color: string) => {
    return PLAN_COLORS[color] || PLAN_COLORS.slate;
  };

  /**
   * Render a toggle switch button.
   *
   * @param checked - Whether the toggle is on
   * @param onChange - Callback when toggled
   * @param activeColor - Tailwind bg class when active
   */
  const renderToggle = (checked: boolean, onChange: () => void, activeColor = 'bg-blue-600') => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
        checked ? activeColor : 'bg-slate-600'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );

  /**
   * Render a numeric text input for plan fields.
   *
   * @param plan - The plan config
   * @param field - The field name
   * @param opts - Options for min value and allowed chars
   */
  const renderNumInput = (
    plan: PlanConfig,
    field: keyof PlanConfig,
    opts: { allowNeg?: boolean; allowDot?: boolean; min?: number; className?: string } = {}
  ) => {
    const pattern = opts.allowNeg
      ? opts.allowDot
        ? /[^0-9.\-]/g
        : /[^0-9\-]/g
      : opts.allowDot
        ? /[^0-9.]/g
        : /[^0-9]/g;
    return (
      <input
        type="text"
        inputMode={opts.allowDot ? 'decimal' : 'numeric'}
        value={String(getPlanValue(plan, field))}
        onChange={(e) => {
          const v = e.target.value.replace(pattern, '');
          const num = v === '' || v === '-' ? 0 : Number(v);
          updatePlanField(plan.id, field, opts.min !== undefined ? Math.max(opts.min, num) : num);
        }}
        className={`bg-slate-900/50 border border-slate-700/40 rounded-lg px-2.5 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500/50 transition-colors ${opts.className || 'w-full'}`}
      />
    );
  };

  /**
   * Render a color selector grid.
   *
   * @param currentColor - Currently selected color key
   * @param onSelect - Callback when a color is selected
   */
  const renderColorPicker = (currentColor: string, onSelect: (color: string) => void) => (
    <div className="flex flex-wrap gap-1.5">
      {COLOR_OPTIONS.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onSelect(c.key)}
          className={`w-6 h-6 rounded-full ${c.classes} transition-all ${
            currentColor === c.key
              ? 'ring-2 ring-white ring-offset-2 ring-offset-slate-800 scale-110'
              : 'opacity-60 hover:opacity-100'
          }`}
          title={c.label}
        />
      ))}
    </div>
  );

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ─── Header ─── */}
      <div className="sticky top-0 z-20 px-3 sm:px-6 pt-5 pb-0 border-b border-slate-700/50 bg-slate-900/30 backdrop-blur-sm">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
          >
            <ArrowLeft size={16} /> {t.back}
          </button>
        </div>
        <div className="flex items-center gap-3 mb-1">
          <Settings size={22} className="text-blue-400" />
          <div>
            <h1 className="text-white text-xl font-bold">{t.title}</h1>
            <p className="text-slate-400 text-sm">{t.subtitle}</p>
          </div>
        </div>

        {/* Tab navigation */}
        <div className="flex gap-1 -mb-px overflow-x-auto mt-4">
          <Link
            href="/dashboard/admin/users"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
          >
            <Users size={14} /> {t.users}
          </Link>
          <Link
            href="/dashboard/admin/billing"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
          >
            <CreditCard size={14} /> {t.billing}
          </Link>
          <span className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-blue-500 text-blue-300 font-medium cursor-default">
            <Settings size={14} /> {t.plans}
          </span>
          <Link
            href="/dashboard/admin/analytics"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
          >
            <BarChart3 size={14} /> {t.analytics}
          </Link>
        </div>
      </div>

      {/* ─── Scrollable content ─── */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-6">
        <div className="max-w-7xl mx-auto space-y-6">
          {/* ─── Section 1: Plan Configuration ─────────────────────────────────── */}
          <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-white font-semibold text-base flex items-center gap-2">
                <Settings size={16} className="text-blue-400" />
                {t.planSectionTitle}
                <span className="text-slate-500 text-sm font-normal ml-2">{t.planSectionDesc}</span>
              </h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    fetchPlans();
                    fetchPacks();
                  }}
                  className="flex items-center gap-1.5 text-slate-400 hover:text-white text-sm transition-colors px-3 py-1.5 rounded-lg hover:bg-white/5"
                >
                  <RefreshCw size={14} /> {t.refresh}
                </button>
                <button
                  onClick={() => {
                    setShowNewPlanForm(true);
                    setNewPlanId('');
                    setNewPlanData(NEW_PLAN_DEFAULTS);
                  }}
                  disabled={showNewPlanForm}
                  className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 border border-blue-500/60 disabled:bg-blue-600/50 disabled:cursor-not-allowed text-white text-sm px-3 py-1.5 rounded-lg transition-colors"
                >
                  <Plus size={14} /> {t.newPlan}
                </button>
              </div>
            </div>

            {planLoading && (
              <div className="flex items-center gap-2 text-slate-400 py-8 justify-center">
                <Loader2 size={16} className="animate-spin" /> {t.loading}
              </div>
            )}

            {planError && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-3">
                <AlertTriangle size={16} className="text-red-400" />
                <span className="text-red-400 text-sm">
                  {t.errorMsg}: {planError}
                </span>
                <button
                  onClick={fetchPlans}
                  className="ml-auto text-red-400 hover:text-red-300 text-sm underline"
                >
                  {t.retry}
                </button>
              </div>
            )}

            {!planLoading && !planError && (
              <div className="space-y-2">
                {/* New plan form */}
                {showNewPlanForm && (
                  <div className="bg-slate-900/50 border border-blue-500/30 rounded-xl p-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-blue-400 flex items-center gap-2">
                        <Plus size={14} /> {t.newPlan}
                      </h3>
                      <button
                        onClick={() => setShowNewPlanForm(false)}
                        className="text-slate-400 hover:text-white transition-colors"
                      >
                        <X size={16} />
                      </button>
                    </div>

                    {/* Plan ID */}
                    <div>
                      <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                        {t.planId}
                      </label>
                      <input
                        type="text"
                        value={newPlanId}
                        onChange={(e) =>
                          setNewPlanId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                        }
                        placeholder="my-new-plan"
                        className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2.5 py-1.5 text-white text-sm w-64 focus:outline-none focus:border-blue-500/50 transition-colors"
                      />
                    </div>

                    {/* Names */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                          {t.nameDa}
                        </label>
                        <input
                          type="text"
                          value={newPlanData.nameDa}
                          onChange={(e) =>
                            setNewPlanData((d) => ({ ...d, nameDa: e.target.value }))
                          }
                          className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2.5 py-1.5 text-white text-sm w-full focus:outline-none focus:border-blue-500/50 transition-colors"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                          {t.nameEn}
                        </label>
                        <input
                          type="text"
                          value={newPlanData.nameEn}
                          onChange={(e) =>
                            setNewPlanData((d) => ({ ...d, nameEn: e.target.value }))
                          }
                          className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2.5 py-1.5 text-white text-sm w-full focus:outline-none focus:border-blue-500/50 transition-colors"
                        />
                      </div>
                    </div>

                    {/* Descriptions */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                          {t.descDa}
                        </label>
                        <input
                          type="text"
                          value={newPlanData.descDa}
                          onChange={(e) =>
                            setNewPlanData((d) => ({ ...d, descDa: e.target.value }))
                          }
                          className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2.5 py-1.5 text-white text-sm w-full focus:outline-none focus:border-blue-500/50 transition-colors"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                          {t.descEn}
                        </label>
                        <input
                          type="text"
                          value={newPlanData.descEn}
                          onChange={(e) =>
                            setNewPlanData((d) => ({ ...d, descEn: e.target.value }))
                          }
                          className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2.5 py-1.5 text-white text-sm w-full focus:outline-none focus:border-blue-500/50 transition-colors"
                        />
                      </div>
                    </div>

                    {/* Color */}
                    <div>
                      <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1.5">
                        {t.color}
                      </label>
                      {renderColorPicker(newPlanData.color, (c) =>
                        setNewPlanData((d) => ({ ...d, color: c }))
                      )}
                    </div>

                    {/* Numeric fields */}
                    <div className="grid grid-cols-4 gap-3">
                      <div>
                        <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                          {t.price}
                        </label>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={String(newPlanData.priceDkk)}
                          onChange={(e) => {
                            const v = e.target.value.replace(/[^0-9]/g, '');
                            setNewPlanData((d) => ({ ...d, priceDkk: v === '' ? 0 : Number(v) }));
                          }}
                          className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2.5 py-1.5 text-white text-sm w-full focus:outline-none focus:border-blue-500/50 transition-colors"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                          {t.aiTokens}
                        </label>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={String(newPlanData.aiTokensPerMonth)}
                          onChange={(e) => {
                            const v = e.target.value.replace(/[^0-9-]/g, '');
                            setNewPlanData((d) => ({
                              ...d,
                              aiTokensPerMonth: v === '' || v === '-' ? 0 : Number(v),
                            }));
                          }}
                          className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2.5 py-1.5 text-white text-sm w-full focus:outline-none focus:border-blue-500/50 transition-colors"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                          {t.durationMonths}
                        </label>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={String(newPlanData.durationMonths)}
                          onChange={(e) => {
                            const v = e.target.value.replace(/[^0-9]/g, '');
                            setNewPlanData((d) => ({
                              ...d,
                              durationMonths: v === '' ? 0 : Number(v),
                            }));
                          }}
                          className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2.5 py-1.5 text-white text-sm w-full focus:outline-none focus:border-blue-500/50 transition-colors"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                          {t.durationDays}
                        </label>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={String(newPlanData.durationDays)}
                          onChange={(e) => {
                            const v = e.target.value.replace(/[^0-9]/g, '');
                            setNewPlanData((d) => ({
                              ...d,
                              durationDays: v === '' ? 0 : Number(v),
                            }));
                          }}
                          className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2.5 py-1.5 text-white text-sm w-full focus:outline-none focus:border-blue-500/50 transition-colors"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-4 gap-3">
                      <div>
                        <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                          {t.capMultiplier}
                        </label>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={String(newPlanData.tokenAccumulationCapMultiplier)}
                          onChange={(e) => {
                            const v = e.target.value.replace(/[^0-9.]/g, '');
                            setNewPlanData((d) => ({
                              ...d,
                              tokenAccumulationCapMultiplier:
                                v === '' ? 1 : Math.max(1, Number(v) || 1),
                            }));
                          }}
                          className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2.5 py-1.5 text-white text-sm w-full focus:outline-none focus:border-blue-500/50 transition-colors"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                          {t.freeTrialDays}
                        </label>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={String(newPlanData.freeTrialDays)}
                          onChange={(e) => {
                            const v = e.target.value.replace(/[^0-9]/g, '');
                            setNewPlanData((d) => ({
                              ...d,
                              freeTrialDays: v === '' ? 0 : Number(v),
                            }));
                          }}
                          className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2.5 py-1.5 text-white text-sm w-full focus:outline-none focus:border-blue-500/50 transition-colors"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                          {t.maxSales}
                        </label>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={newPlanData.maxSales == null ? '' : String(newPlanData.maxSales)}
                          onChange={(e) => {
                            const v = e.target.value.replace(/[^0-9]/g, '');
                            setNewPlanData((d) => ({
                              ...d,
                              maxSales: v === '' ? null : Number(v),
                            }));
                          }}
                          placeholder={t.unlimited}
                          className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2.5 py-1.5 text-white text-sm w-full focus:outline-none focus:border-blue-500/50 transition-colors placeholder-slate-600"
                        />
                        <p className="text-[10px] text-slate-600 mt-0.5">{t.maxSalesHint}</p>
                      </div>
                    </div>

                    {/* Toggles */}
                    <div className="flex items-center gap-6">
                      <label className="flex items-center gap-2 text-sm text-slate-300">
                        {renderToggle(newPlanData.aiEnabled, () =>
                          setNewPlanData((d) => ({ ...d, aiEnabled: !d.aiEnabled }))
                        )}
                        {t.aiEnabled}
                      </label>
                      <label className="flex items-center gap-2 text-sm text-slate-300">
                        {renderToggle(
                          newPlanData.requiresApproval,
                          () =>
                            setNewPlanData((d) => ({
                              ...d,
                              requiresApproval: !d.requiresApproval,
                            })),
                          'bg-amber-600'
                        )}
                        {t.requiresApproval}
                      </label>
                      <label className="flex items-center gap-2 text-sm text-slate-300">
                        {renderToggle(
                          newPlanData.isActive,
                          () => setNewPlanData((d) => ({ ...d, isActive: !d.isActive })),
                          'bg-emerald-600'
                        )}
                        {t.active}
                      </label>
                    </div>

                    {/* Create button */}
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={createPlan}
                        disabled={creatingPlan || !newPlanId.trim() || !newPlanData.nameDa.trim()}
                        className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 border border-blue-500/60 disabled:bg-blue-600/50 disabled:cursor-not-allowed text-white text-sm px-4 py-1.5 rounded-lg transition-colors"
                      >
                        {creatingPlan ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Plus size={14} />
                        )}
                        {creatingPlan ? t.creating : t.create}
                      </button>
                      <button
                        onClick={() => setShowNewPlanForm(false)}
                        className="text-slate-400 hover:text-white text-sm px-3 py-1.5 rounded-lg transition-colors"
                      >
                        {t.cancel}
                      </button>
                    </div>
                  </div>
                )}

                {/* Plan rows */}
                {plans.map((plan) => {
                  const badge = getBadgeClasses(getPlanValue(plan, 'color') as string);
                  const isSaving = savingPlan === plan.id;
                  const isSaved = savedPlan === plan.id;
                  const hasChanges = planHasChanges(plan.id);
                  const isExpanded = expandedPlan === plan.id;
                  const isDeleting = deletingPlan === plan.id;

                  return (
                    <div
                      key={plan.id}
                      className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden hover:bg-slate-800/60 transition-colors"
                    >
                      {/* Summary row */}
                      <div
                        className="flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors"
                        onClick={() => setExpandedPlan(isExpanded ? null : plan.id)}
                      >
                        {/* Color badge + name */}
                        <span
                          className={`text-xs font-medium px-2.5 py-0.5 rounded-md border shrink-0 ${badge.bg} ${badge.text} ${badge.border}`}
                        >
                          {da ? getPlanValue(plan, 'nameDa') : getPlanValue(plan, 'nameEn')}
                        </span>

                        {/* Key info pills */}
                        <span className="text-slate-400 text-xs">
                          {getPlanValue(plan, 'priceDkk')} DKK
                        </span>
                        <span className="text-slate-600 text-xs">|</span>
                        <span className="text-slate-400 text-xs">
                          {getPlanValue(plan, 'aiTokensPerMonth') === -1
                            ? da
                              ? 'Ubegranset AI'
                              : 'Unlimited AI'
                            : `${Number(getPlanValue(plan, 'aiTokensPerMonth')).toLocaleString()} tokens`}
                        </span>
                        <span className="text-slate-600 text-xs">|</span>
                        <span className="text-slate-400 text-xs">
                          {Number(getPlanValue(plan, 'durationDays')) > 0
                            ? `${getPlanValue(plan, 'durationDays')} ${da ? 'dage' : 'days'}`
                            : `${getPlanValue(plan, 'durationMonths')} ${da ? 'md' : 'mo'}`}
                        </span>

                        {/* Status indicators */}
                        <div className="ml-auto flex items-center gap-2">
                          {!getPlanValue(plan, 'isActive') && (
                            <span className="text-xs text-red-400 bg-red-500/20 px-2 py-0.5 rounded-md border border-red-500/30">
                              {da ? 'Inaktiv' : 'Inactive'}
                            </span>
                          )}
                          {getPlanValue(plan, 'requiresApproval') && (
                            <span className="text-xs text-amber-400 bg-amber-500/20 px-2 py-0.5 rounded-md border border-amber-500/30">
                              {da ? 'Godkendelse' : 'Approval'}
                            </span>
                          )}
                          {hasChanges && (
                            <span className="text-xs text-blue-400 bg-blue-500/20 px-2 py-0.5 rounded-md border border-blue-500/30">
                              {da ? 'Usaved' : 'Unsaved'}
                            </span>
                          )}
                          {isExpanded ? (
                            <ChevronUp size={14} className="text-slate-500" />
                          ) : (
                            <ChevronDown size={14} className="text-slate-500" />
                          )}
                        </div>
                      </div>

                      {/* Expanded edit form */}
                      {isExpanded && (
                        <div className="border-t border-slate-700/40 px-4 py-4 space-y-4 bg-slate-900/30">
                          {/* Names */}
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                                {t.nameDa}
                              </label>
                              <input
                                type="text"
                                value={getPlanValue(plan, 'nameDa') as string}
                                onChange={(e) => updatePlanField(plan.id, 'nameDa', e.target.value)}
                                className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2.5 py-1.5 text-white text-sm w-full focus:outline-none focus:border-blue-500/50 transition-colors"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                                {t.nameEn}
                              </label>
                              <input
                                type="text"
                                value={getPlanValue(plan, 'nameEn') as string}
                                onChange={(e) => updatePlanField(plan.id, 'nameEn', e.target.value)}
                                className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2.5 py-1.5 text-white text-sm w-full focus:outline-none focus:border-blue-500/50 transition-colors"
                              />
                            </div>
                          </div>

                          {/* Descriptions */}
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                                {t.descDa}
                              </label>
                              <input
                                type="text"
                                value={getPlanValue(plan, 'descDa') as string}
                                onChange={(e) => updatePlanField(plan.id, 'descDa', e.target.value)}
                                className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2.5 py-1.5 text-white text-sm w-full focus:outline-none focus:border-blue-500/50 transition-colors"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                                {t.descEn}
                              </label>
                              <input
                                type="text"
                                value={getPlanValue(plan, 'descEn') as string}
                                onChange={(e) => updatePlanField(plan.id, 'descEn', e.target.value)}
                                className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2.5 py-1.5 text-white text-sm w-full focus:outline-none focus:border-blue-500/50 transition-colors"
                              />
                            </div>
                          </div>

                          {/* Color */}
                          <div>
                            <label className="text-[10px] text-slate-500 uppercase tracking-wider flex items-center gap-1 mb-1.5">
                              <Palette size={10} /> {t.color}
                            </label>
                            {renderColorPicker(getPlanValue(plan, 'color') as string, (c) =>
                              updatePlanField(plan.id, 'color', c)
                            )}
                          </div>

                          {/* Numeric fields row 1 */}
                          <div className="grid grid-cols-5 gap-3">
                            <div>
                              <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                                {t.price}
                              </label>
                              {renderNumInput(plan, 'priceDkk')}
                            </div>
                            <div>
                              <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                                {t.aiTokens}
                              </label>
                              {renderNumInput(plan, 'aiTokensPerMonth', { allowNeg: true })}
                            </div>
                            <div>
                              <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                                {t.durationMonths}
                              </label>
                              {renderNumInput(plan, 'durationMonths', { min: 0 })}
                            </div>
                            <div>
                              <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                                {t.durationDays}
                              </label>
                              {renderNumInput(plan, 'durationDays', { min: 0 })}
                            </div>
                            <div>
                              <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                                {t.capMultiplier}
                              </label>
                              {renderNumInput(plan, 'tokenAccumulationCapMultiplier', {
                                allowDot: true,
                                min: 1,
                              })}
                            </div>
                          </div>

                          {/* Duration hint */}
                          <p className="text-[10px] text-slate-600 -mt-2">{t.durationHint}</p>

                          {/* Free trial + toggles */}
                          <div className="grid grid-cols-5 gap-3 items-end">
                            <div>
                              <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                                {t.freeTrialDays}
                              </label>
                              {renderNumInput(plan, 'freeTrialDays', { min: 0 })}
                            </div>
                            <label className="flex items-center gap-2 text-sm text-slate-300 pb-1">
                              {renderToggle(getPlanValue(plan, 'aiEnabled') as boolean, () =>
                                updatePlanField(
                                  plan.id,
                                  'aiEnabled',
                                  !getPlanValue(plan, 'aiEnabled')
                                )
                              )}
                              {t.aiEnabled}
                            </label>
                            <label className="flex items-center gap-2 text-sm text-slate-300 pb-1">
                              {renderToggle(
                                getPlanValue(plan, 'requiresApproval') as boolean,
                                () =>
                                  updatePlanField(
                                    plan.id,
                                    'requiresApproval',
                                    !getPlanValue(plan, 'requiresApproval')
                                  ),
                                'bg-amber-600'
                              )}
                              {t.requiresApproval}
                            </label>
                            <label className="flex items-center gap-2 text-sm text-slate-300 pb-1">
                              {renderToggle(
                                getPlanValue(plan, 'isActive') as boolean,
                                () =>
                                  updatePlanField(
                                    plan.id,
                                    'isActive',
                                    !getPlanValue(plan, 'isActive')
                                  ),
                                'bg-emerald-600'
                              )}
                              {t.active}
                            </label>
                          </div>

                          {/* Max sales + sales count */}
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                                {t.maxSales}
                              </label>
                              <input
                                type="text"
                                inputMode="numeric"
                                value={
                                  (getPlanValue(plan, 'maxSales') as number | null) == null
                                    ? ''
                                    : String(getPlanValue(plan, 'maxSales'))
                                }
                                onChange={(e) => {
                                  const v = e.target.value.replace(/[^0-9]/g, '');
                                  updatePlanField(
                                    plan.id,
                                    'maxSales',
                                    v === '' ? (null as unknown as number) : Number(v)
                                  );
                                }}
                                placeholder={t.unlimited}
                                className="w-full px-2.5 py-1.5 rounded-lg bg-slate-900/50 border border-slate-700/40 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-blue-500/50 transition-colors"
                              />
                              <p className="text-[10px] text-slate-600 mt-0.5">{t.maxSalesHint}</p>
                            </div>
                            <div>
                              <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                                {t.salesCount}
                              </label>
                              <div className="flex items-center gap-2 h-[34px]">
                                <span className="text-white text-sm font-mono">
                                  {getPlanValue(plan, 'salesCount') ?? 0}
                                </span>
                                {(getPlanValue(plan, 'maxSales') as number | null) != null && (
                                  <span className="text-slate-500 text-xs">
                                    / {getPlanValue(plan, 'maxSales')}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Stripe Price ID */}
                          <div>
                            <label className="text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                              Stripe Price ID
                            </label>
                            <input
                              type="text"
                              value={String(getPlanValue(plan, 'stripePriceId') ?? '')}
                              onChange={(e) =>
                                updatePlanField(plan.id, 'stripePriceId', e.target.value)
                              }
                              placeholder="price_..."
                              className="w-full px-2.5 py-1.5 rounded-lg bg-slate-900/50 border border-slate-700/40 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-blue-500/50 transition-colors"
                            />
                            <p className="text-[10px] text-slate-600 mt-0.5">
                              {da
                                ? 'Fra Stripe Dashboard → Products → Price ID'
                                : 'From Stripe Dashboard → Products → Price ID'}
                            </p>
                          </div>

                          {/* Action buttons */}
                          <div className="flex items-center gap-2 pt-2 border-t border-slate-700/40">
                            <button
                              onClick={() => savePlan(plan.id)}
                              disabled={isSaving || !hasChanges}
                              className={`flex items-center gap-1.5 text-sm px-4 py-1.5 rounded-lg transition-colors ${
                                isSaved
                                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                  : hasChanges
                                    ? 'bg-blue-600 hover:bg-blue-500 border border-blue-500/60 text-white'
                                    : 'bg-white/5 text-slate-500 cursor-not-allowed border border-slate-700/40'
                              }`}
                            >
                              {isSaving ? (
                                <>
                                  <Loader2 size={14} className="animate-spin" /> {t.saving}
                                </>
                              ) : isSaved ? (
                                <>
                                  <Check size={14} /> {t.saved}
                                </>
                              ) : (
                                <>
                                  <Save size={14} /> {t.save}
                                </>
                              )}
                            </button>

                            <button
                              onClick={() => handleDeletePlan(plan.id)}
                              disabled={isDeleting}
                              className="flex items-center gap-1.5 text-sm text-red-400 bg-red-600/20 border border-red-500/30 px-3 py-1.5 rounded-lg hover:bg-red-600/30 transition-colors ml-auto"
                            >
                              {isDeleting ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Trash2 size={14} />
                              )}
                              {t.deletePlan}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ─── Section 2: Token Packs ────────────────────────────────────────── */}
          <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-white font-semibold text-base flex items-center gap-2">
                <Package size={16} className="text-blue-400" />
                {t.packSectionTitle}
                <span className="text-slate-500 text-sm font-normal ml-2">{t.packSectionDesc}</span>
              </h2>
              <button
                onClick={openCreatePackForm}
                disabled={showPackForm}
                className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 border border-blue-500/60 disabled:bg-blue-600/50 disabled:cursor-not-allowed text-white text-sm px-3 py-1.5 rounded-lg transition-colors"
              >
                <Plus size={14} /> {t.addPack}
              </button>
            </div>

            {packLoading && (
              <div className="flex items-center gap-2 text-slate-400 py-8 justify-center">
                <Loader2 size={16} className="animate-spin" /> {t.loading}
              </div>
            )}

            {packError && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-3">
                <AlertTriangle size={16} className="text-red-400" />
                <span className="text-red-400 text-sm">
                  {t.errorMsg}: {packError}
                </span>
                <button
                  onClick={fetchPacks}
                  className="ml-auto text-red-400 hover:text-red-300 text-sm underline"
                >
                  {t.retry}
                </button>
              </div>
            )}

            {!packLoading && !packError && (
              <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl overflow-hidden">
                {/* Table header */}
                <div className="grid grid-cols-[1fr_1fr_0.7fr_0.7fr_1.2fr_0.5fr_0.5fr_auto] gap-2 px-4 py-2.5 border-b border-slate-700/40 text-slate-500 text-xs uppercase tracking-wide">
                  <span>{t.packNameDa}</span>
                  <span>{t.packNameEn}</span>
                  <span>{t.packTokens}</span>
                  <span>{t.packPrice}</span>
                  <span>{t.packStripeId}</span>
                  <span>{t.packActive}</span>
                  <span>{t.packSort}</span>
                  <span />
                </div>

                {/* Pack rows */}
                {packs.length === 0 && !showPackForm && (
                  <div className="text-slate-500 text-sm text-center py-8">{t.noPacks}</div>
                )}

                {packs.map((pack) => (
                  <div
                    key={pack.id}
                    className="grid grid-cols-[1fr_1fr_0.7fr_0.7fr_1.2fr_0.5fr_0.5fr_auto] gap-2 px-4 py-2.5 border-b border-slate-700/20 items-center text-sm"
                  >
                    <span className="text-white truncate">{pack.nameDa}</span>
                    <span className="text-slate-300 truncate">{pack.nameEn}</span>
                    <span className="text-white font-mono">{pack.tokens.toLocaleString()}</span>
                    <span className="text-white">{pack.priceDkk} DKK</span>
                    <span className="text-slate-400 text-xs truncate font-mono">
                      {pack.stripePriceId || '\u2014'}
                    </span>
                    <span>
                      {pack.active ? (
                        <span className="text-xs text-emerald-400 bg-emerald-500/20 px-1.5 py-0.5 rounded-md border border-emerald-500/30">
                          On
                        </span>
                      ) : (
                        <span className="text-xs text-slate-500 bg-slate-600/20 px-1.5 py-0.5 rounded-md border border-slate-600/30">
                          Off
                        </span>
                      )}
                    </span>
                    <span className="text-slate-400">{pack.sortOrder}</span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => openEditPackForm(pack)}
                        disabled={!!packActionLoading}
                        className="text-slate-400 hover:text-blue-400 p-1 transition-colors"
                        aria-label={t.editPack}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={() => deletePack(pack.id)}
                        disabled={!!packActionLoading}
                        className="text-slate-400 hover:text-red-400 p-1 transition-colors"
                        aria-label={t.deletePack}
                      >
                        {packActionLoading === pack.id ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <Trash2 size={13} />
                        )}
                      </button>
                    </div>
                  </div>
                ))}

                {/* Inline create/edit form */}
                {showPackForm && (
                  <div className="grid grid-cols-[1fr_1fr_0.7fr_0.7fr_1.2fr_0.5fr_0.5fr_auto] gap-2 px-4 py-3 border-b border-blue-500/30 bg-slate-900/70 items-center">
                    <input
                      type="text"
                      placeholder={t.packNameDa}
                      value={packForm.nameDa}
                      onChange={(e) => setPackForm((f) => ({ ...f, nameDa: e.target.value }))}
                      className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2 py-1 text-white text-sm focus:outline-none focus:border-blue-500/50 transition-colors"
                    />
                    <input
                      type="text"
                      placeholder={t.packNameEn}
                      value={packForm.nameEn}
                      onChange={(e) => setPackForm((f) => ({ ...f, nameEn: e.target.value }))}
                      className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2 py-1 text-white text-sm focus:outline-none focus:border-blue-500/50 transition-colors"
                    />
                    <input
                      type="text"
                      inputMode="numeric"
                      value={String(packForm.tokens)}
                      onChange={(e) => {
                        const v = e.target.value.replace(/[^0-9]/g, '');
                        setPackForm((f) => ({ ...f, tokens: v === '' ? 0 : Number(v) }));
                      }}
                      className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2 py-1 text-white text-sm focus:outline-none focus:border-blue-500/50 transition-colors"
                    />
                    <input
                      type="text"
                      inputMode="numeric"
                      value={String(packForm.priceDkk)}
                      onChange={(e) => {
                        const v = e.target.value.replace(/[^0-9]/g, '');
                        setPackForm((f) => ({ ...f, priceDkk: v === '' ? 0 : Number(v) }));
                      }}
                      className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2 py-1 text-white text-sm focus:outline-none focus:border-blue-500/50 transition-colors"
                    />
                    <input
                      type="text"
                      placeholder="price_..."
                      value={packForm.stripePriceId}
                      onChange={(e) =>
                        setPackForm((f) => ({ ...f, stripePriceId: e.target.value }))
                      }
                      className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2 py-1 text-white text-xs font-mono focus:outline-none focus:border-blue-500/50 transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() => setPackForm((f) => ({ ...f, active: !f.active }))}
                      className={`text-xs px-2 py-1 rounded-md border transition-colors ${
                        packForm.active
                          ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                          : 'bg-slate-600/20 text-slate-500 border-slate-600/30'
                      }`}
                    >
                      {packForm.active ? 'On' : 'Off'}
                    </button>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={String(packForm.sortOrder)}
                      onChange={(e) => {
                        const v = e.target.value.replace(/[^0-9]/g, '');
                        setPackForm((f) => ({ ...f, sortOrder: v === '' ? 0 : Number(v) }));
                      }}
                      className="bg-slate-900/50 border border-slate-700/40 rounded-lg px-2 py-1 text-white text-sm w-full focus:outline-none focus:border-blue-500/50 transition-colors"
                    />
                    <div className="flex items-center gap-1">
                      <button
                        onClick={submitPackForm}
                        disabled={!!packActionLoading || !packForm.nameDa || !packForm.nameEn}
                        className="flex items-center gap-1 bg-blue-600 hover:bg-blue-500 border border-blue-500/60 disabled:bg-blue-600/50 disabled:cursor-not-allowed text-white text-xs px-2 py-1 rounded-lg transition-colors"
                      >
                        {packActionLoading ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <Check size={11} />
                        )}
                        {editingPackId ? t.updatePack : t.createPack}
                      </button>
                      <button
                        onClick={closePackForm}
                        className="text-slate-400 hover:text-white p-1 transition-colors"
                        aria-label={t.cancelAction}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
