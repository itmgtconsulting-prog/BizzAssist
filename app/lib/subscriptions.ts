/**
 * Subscription plan definitions and helpers.
 *
 * Defines the available plans, their features, token limits, and pricing.
 * Used by settings page (subscription tab), sign-up flow, and admin panel.
 *
 * Plans:
 *   - demo:       Gratis prøveperiode, kræver admin-godkendelse
 *   - basis:      Basisdata uden AI
 *   - professionel: AI med 50.000 tokens/måned
 *   - enterprise:  AI med 500.000 tokens/måned + eksport
 *
 * @see /dashboard/settings — brugerens abonnement-tab
 * @see /dashboard/admin/users — admin-godkendelse af demo-brugere
 */

// ─── Plan types ──────────────────────────────────────────────────────────────

/** Plan identifier */
export type PlanId = 'demo' | 'basis' | 'professionel' | 'enterprise';

/** Subscription status */
export type SubStatus = 'pending' | 'active' | 'cancelled' | 'expired';

/** Full plan definition with features and pricing */
export interface PlanDef {
  /** Unique plan identifier */
  id: PlanId;
  /** Danish name */
  nameDa: string;
  /** English name */
  nameEn: string;
  /** Danish description */
  descDa: string;
  /** English description */
  descEn: string;
  /** Monthly price in DKK (0 = free) */
  priceDkk: number;
  /** Whether AI chat is enabled */
  aiEnabled: boolean;
  /** Monthly AI token limit (0 = no AI, -1 = unlimited) */
  aiTokensPerMonth: number;
  /** Whether admin approval is required to activate */
  requiresApproval: boolean;
  /** Badge color for UI */
  color: string;
  /** Billing cycle length in months (default 1, 0 if using days instead) */
  durationMonths: number;
  /** Billing cycle length in days (default 0, takes precedence over months when > 0) */
  durationDays: number;
  /** Max accumulated tokens = multiplier * aiTokensPerMonth (default 5) */
  tokenAccumulationCapMultiplier: number;
  /** Free trial days for new subscribers (0 = no trial, must pay immediately) */
  freeTrialDays: number;
  /** Maximum number of sales allowed (null/undefined = unlimited) */
  maxSales?: number | null;
  /** Current number of sales completed */
  salesCount?: number;
}

// ─── Plan definitions ────────────────────────────────────────────────────────

export const PLANS: Record<PlanId, PlanDef> = {
  demo: {
    id: 'demo',
    nameDa: 'Demo',
    nameEn: 'Demo',
    descDa: 'Gratis prøveperiode med fuld adgang.',
    descEn: 'Free trial with full access.',
    priceDkk: 0,
    aiEnabled: true,
    aiTokensPerMonth: 10_000,
    requiresApproval: false,
    color: 'amber',
    durationMonths: 1,
    durationDays: 0,
    tokenAccumulationCapMultiplier: 5,
    freeTrialDays: 0,
    maxSales: null,
    salesCount: 0,
  },
  basis: {
    id: 'basis',
    nameDa: 'Basis',
    nameEn: 'Basic',
    descDa: 'Adgang til basisdata — ejendomme, virksomheder og ejere. Uden AI.',
    descEn: 'Access to basic data — properties, companies and owners. No AI.',
    priceDkk: 299,
    aiEnabled: false,
    aiTokensPerMonth: 0,
    requiresApproval: false,
    color: 'slate',
    durationMonths: 1,
    durationDays: 0,
    tokenAccumulationCapMultiplier: 5,
    freeTrialDays: 0,
    maxSales: null,
    salesCount: 0,
  },
  professionel: {
    id: 'professionel',
    nameDa: 'Professionel',
    nameEn: 'Professional',
    descDa: 'Alt i Basis + AI-assistent med 50.000 tokens pr. måned.',
    descEn: 'Everything in Basic + AI assistant with 50,000 tokens per month.',
    priceDkk: 799,
    aiEnabled: true,
    aiTokensPerMonth: 50_000,
    requiresApproval: false,
    color: 'blue',
    durationMonths: 1,
    durationDays: 0,
    tokenAccumulationCapMultiplier: 5,
    freeTrialDays: 0,
    maxSales: null,
    salesCount: 0,
  },
  enterprise: {
    id: 'enterprise',
    nameDa: 'Enterprise',
    nameEn: 'Enterprise',
    descDa: 'Ubegrænsede søgninger, ubegrænset AI-tokens, eksport og prioriteret support.',
    descEn: 'Unlimited searches, unlimited AI tokens, export and priority support.',
    priceDkk: 2499,
    aiEnabled: true,
    aiTokensPerMonth: -1,
    requiresApproval: false,
    color: 'purple',
    durationMonths: 1,
    durationDays: 0,
    tokenAccumulationCapMultiplier: 5,
    freeTrialDays: 0,
    maxSales: null,
    salesCount: 0,
  },
};

/** Ordered list of hardcoded plans for display (legacy fallback only) */
export const PLAN_LIST: PlanDef[] = [PLANS.demo, PLANS.basis, PLANS.professionel, PLANS.enterprise];

// ─── Runtime plan cache (populated from DB via API) ─────────────────────────

const PLAN_CACHE_KEY = 'ba-plan-cache';

/** In-memory plan cache — populated from /api/plans or /api/subscription */
const _planCache = new Map<string, PlanDef>();

/**
 * Populate the plan cache with plans fetched from the DB.
 * Called by dashboard layout on mount and after admin edits.
 *
 * @param plans - Array of plan definitions from the API
 */
export function cachePlans(plans: PlanDef[]): void {
  _planCache.clear();
  for (const p of plans) _planCache.set(p.id, p);
  // Persist to localStorage so cache survives page navigations
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(PLAN_CACHE_KEY, JSON.stringify(plans));
    } catch {
      /* ignore */
    }
  }
}

/**
 * Load the plan cache from localStorage (called on module init).
 * This ensures plan data is available before the API fetch completes.
 */
function _loadCacheFromStorage(): void {
  if (typeof window === 'undefined') return;
  if (_planCache.size > 0) return; // Already populated
  try {
    const raw = localStorage.getItem(PLAN_CACHE_KEY);
    if (raw) {
      const plans: PlanDef[] = JSON.parse(raw);
      for (const p of plans) _planCache.set(p.id, p);
    }
  } catch {
    /* ignore */
  }
}

// Auto-load cache on module init (client-side only)
_loadCacheFromStorage();

/**
 * Resolve a plan definition from a planId.
 * Checks: 1) runtime cache (from DB), 2) hardcoded defaults (legacy), 3) synthetic fallback.
 * The cache is populated from the API — once loaded, DB plans always take precedence.
 *
 * @param planId - The plan identifier to resolve
 * @returns A PlanDef (cached, hardcoded legacy, or synthetic fallback)
 */
export function resolvePlan(planId: string): PlanDef {
  // 1. Runtime cache (populated from DB via API) — always preferred
  const cached = _planCache.get(planId);
  if (cached) return cached;
  // 2. Hardcoded legacy fallback (used before cache is populated on first load)
  const known = PLANS[planId as PlanId];
  if (known) return known;
  // 3. Synthetic fallback for completely unknown plans
  return {
    id: planId as PlanId,
    nameDa: planId,
    nameEn: planId,
    descDa: '',
    descEn: '',
    priceDkk: 0,
    aiEnabled: false,
    aiTokensPerMonth: 0,
    requiresApproval: false,
    color: 'slate',
    durationMonths: 1,
    durationDays: 0,
    tokenAccumulationCapMultiplier: 5,
    freeTrialDays: 0,
    maxSales: null,
    salesCount: 0,
  };
}

// ─── User subscription ──────────────────────────────────────────────────────

/** User's current subscription from Supabase app_metadata (via SubscriptionContext) */
export interface UserSubscription {
  /** User email */
  email: string;
  /** Selected plan ID */
  planId: PlanId;
  /** Subscription status */
  status: SubStatus;
  /** When the subscription was created (ISO string) */
  createdAt: string;
  /** When it was approved (ISO string, null if pending) */
  approvedAt: string | null;
  /** AI tokens used this period */
  tokensUsedThisMonth: number;
  /** Current billing period start (ISO string) */
  periodStart: string;
  /** Bonus tokens granted by admin (optional, added to plan limit) */
  bonusTokens?: number;
  /** Tokens accumulated from previous unused periods */
  accumulatedTokens?: number;
  /** Tokens purchased via top-up packs */
  topUpTokens?: number;
  /** Whether the subscription has been paid (false = awaiting first payment) */
  isPaid?: boolean;
  /** Whether the subscription is set to cancel at period end */
  cancelAtPeriodEnd?: boolean;
  /** ISO date when the subscription will be cancelled */
  cancelAt?: string;
}

// NOTE: localStorage-based getSubscription/saveSubscription/switchActiveUser/
// clearActiveSubscription have been removed. All subscription state is now
// managed via SubscriptionContext (app/context/SubscriptionContext.tsx),
// populated from /api/subscription on login. This is enterprise-compliant:
// no sensitive data persists in the browser beyond the session.

/**
 * Format token count as readable Danish string with dot as thousands separator.
 * Examples: 35 → "35", 10000 → "10.000", 500000 → "500.000", 1500000 → "1,5M"
 *
 * @param tokens - Token count
 * @returns Formatted string
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace('.', ',')}M`;
  return String(tokens).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// ─── Admin ───────────────────────────────────────────────────────────────────
// Admin subscription management is now fully database-driven.
// All admin actions go through /api/admin/subscription and /api/admin/users.
// Admin access is controlled via app_metadata.isAdmin in Supabase Auth.
// No localStorage is used for admin data.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Payment / access helpers ──────────────────────────────────────────────

/**
 * Check if a subscription has functional access (paid, free plan, or within free trial).
 * A subscription is "functionally active" when:
 *   - status is 'active' AND
 *   - plan is free (priceDkk === 0), OR
 *   - subscription is marked as paid (isPaid === true), OR
 *   - user is still within the free trial window
 *
 * @param sub - User's subscription
 * @param plan - Resolved plan definition
 * @returns true if the user should have access to features
 */
export function isSubscriptionFunctional(
  sub: UserSubscription | null,
  plan: PlanDef | null
): boolean {
  if (!sub || !plan) return false;
  if (sub.status !== 'active') return false;
  // Free plans always have access
  if (plan.priceDkk === 0) return true;
  // Explicitly paid
  if (sub.isPaid) return true;
  // Within free trial period
  if (plan.freeTrialDays > 0) {
    const created = new Date(sub.createdAt).getTime();
    const trialEnd = created + plan.freeTrialDays * 24 * 60 * 60 * 1000;
    if (Date.now() < trialEnd) return true;
  }
  return false;
}

// ─── Token helpers ──────────────────────────────────────────────────────────

/**
 * Calculate the effective token limit for a subscription.
 * Includes plan allocation + accumulated + top-up + bonus tokens.
 *
 * @param sub - User's subscription
 * @param plan - Plan definition (use merged/overridden plan if available)
 * @returns Total available tokens (-1 = unlimited)
 */
export function getEffectiveTokenLimit(sub: UserSubscription, plan: PlanDef): number {
  if (plan.aiTokensPerMonth === -1) return -1; // Unlimited
  if (!plan.aiEnabled) return 0;
  return (
    plan.aiTokensPerMonth +
    (sub.accumulatedTokens ?? 0) +
    (sub.topUpTokens ?? 0) +
    (sub.bonusTokens ?? 0)
  );
}

/**
 * Get the token accumulation cap for a plan.
 *
 * @param plan - Plan definition
 * @returns Max accumulated tokens (0 for no-AI plans, -1 for unlimited)
 */
export function getTokenAccumulationCap(plan: PlanDef): number {
  if (plan.aiTokensPerMonth <= 0) return 0;
  return Math.floor(plan.aiTokensPerMonth * plan.tokenAccumulationCapMultiplier);
}

/**
 * Perform lazy token rollover for periods that have passed.
 * Returns the updated subscription fields (does NOT write to DB).
 *
 * @param sub - Current subscription data
 * @param plan - Plan definition
 * @returns Updated subscription fields after rollover, or null if no rollover needed
 */
/**
 * Get the billing period duration in milliseconds for a plan.
 * If durationDays > 0, uses days. Otherwise uses durationMonths (approx 30 days each).
 */
export function getPlanDurationMs(plan: PlanDef): number {
  const DAY_MS = 24 * 60 * 60 * 1000;
  if (plan.durationDays > 0) return plan.durationDays * DAY_MS;
  return (plan.durationMonths ?? 1) * 30 * DAY_MS;
}

export function computeTokenRollover(
  sub: UserSubscription,
  plan: PlanDef
): Partial<UserSubscription> | null {
  const periodStart = new Date(sub.periodStart);
  const durationMs = getPlanDurationMs(plan);
  const periodEnd = new Date(periodStart.getTime() + durationMs);
  const now = new Date();

  if (now < periodEnd) return null; // Period not yet ended

  let accumulated = sub.accumulatedTokens ?? 0;
  let used = sub.tokensUsedThisMonth;
  let currentStart = periodStart;
  const cap = getTokenAccumulationCap(plan);

  // Roll forward one period at a time
  while (new Date(currentStart.getTime() + durationMs) < now) {
    if (plan.aiTokensPerMonth > 0) {
      const unused = Math.max(0, plan.aiTokensPerMonth - used);
      accumulated = Math.min(accumulated + unused, cap);
    }
    used = 0;
    currentStart = new Date(currentStart.getTime() + durationMs);
  }

  return {
    accumulatedTokens: accumulated,
    tokensUsedThisMonth: used,
    periodStart: currentStart.toISOString(),
  };
}

// ─── Token pack definitions ─────────────────────────────────────────────────

/** Token pack available for purchase */
export interface TokenPack {
  id: string;
  nameDa: string;
  nameEn: string;
  tokenAmount: number;
  priceDkk: number;
  stripePriceId: string | null;
  isActive: boolean;
  sortOrder: number;
}
