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
  /** Monthly AI token limit (0 = no AI) */
  aiTokensPerMonth: number;
  /** Whether PDF/CSV export is enabled */
  exportEnabled: boolean;
  /** Whether admin approval is required to activate */
  requiresApproval: boolean;
  /** Badge color for UI */
  color: string;
}

// ─── Plan definitions ────────────────────────────────────────────────────────

export const PLANS: Record<PlanId, PlanDef> = {
  demo: {
    id: 'demo',
    nameDa: 'Demo',
    nameEn: 'Demo',
    descDa: 'Gratis prøveperiode med fuld adgang. Kræver godkendelse.',
    descEn: 'Free trial with full access. Requires approval.',
    priceDkk: 0,

    aiEnabled: true,
    aiTokensPerMonth: 10_000,
    exportEnabled: false,
    requiresApproval: true,
    color: 'amber',
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
    exportEnabled: false,
    requiresApproval: false,
    color: 'slate',
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
    exportEnabled: true,
    requiresApproval: false,
    color: 'blue',
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
    exportEnabled: true,
    requiresApproval: false,
    color: 'purple',
  },
};

/** Ordered list of plans for display */
export const PLAN_LIST: PlanDef[] = [PLANS.demo, PLANS.basis, PLANS.professionel, PLANS.enterprise];

// ─── User subscription (localStorage for demo) ──────────────────────────────

const SUB_KEY = 'ba-subscription';

/** User's current subscription stored in localStorage */
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
  /** AI tokens used this month */
  tokensUsedThisMonth: number;
  /** Current billing period start (ISO string) */
  periodStart: string;
  /** Bonus tokens granted by admin (optional, added to plan limit) */
  bonusTokens?: number;
}

/**
 * Get the current user's subscription from localStorage.
 *
 * @returns UserSubscription or null if none exists
 */
export function getSubscription(): UserSubscription | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SUB_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as UserSubscription;
  } catch {
    return null;
  }
}

/**
 * Switch the active local subscription to match the given email.
 * Checks if a cached subscription exists in localStorage for the email.
 * If the email is the admin and has no subscription, creates a default one.
 *
 * Note: The primary subscription source is now Supabase app_metadata
 * (fetched via /api/subscription). This is a client-side fallback only.
 *
 * @param email - The email of the user who just logged in
 * @returns The active subscription or null
 */
export function switchActiveUser(email: string): UserSubscription | null {
  // Check if there's already a cached subscription for this user
  const existing = getSubscription();
  if (existing?.email === email) return existing;

  // Admin fallback — create default subscription locally
  if (email === ADMIN_EMAIL) {
    const now = new Date().toISOString();
    const sub: UserSubscription = {
      email: ADMIN_EMAIL,
      planId: 'enterprise',
      status: 'active',
      createdAt: now,
      approvedAt: now,
      tokensUsedThisMonth: 0,
      periodStart: now,
    };
    saveSubscription(sub);
    return sub;
  }

  return null;
}

/**
 * Clear the active user's subscription from localStorage.
 * Called on logout to ensure the next login loads the correct user's data.
 */
export function clearActiveSubscription(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(SUB_KEY);
  } catch {
    // ignore
  }
}

/**
 * Save/update the user's subscription in localStorage.
 *
 * @param sub - Subscription data to save
 */
export function saveSubscription(sub: UserSubscription): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SUB_KEY, JSON.stringify(sub));
  } catch {
    // ignore
  }
}

/**
 * Create a new demo subscription in pending state.
 *
 * @param email - User's email address
 * @param planId - Selected plan
 * @returns The created subscription
 */
export function createSubscription(email: string, planId: PlanId): UserSubscription {
  const now = new Date().toISOString();
  const sub: UserSubscription = {
    email,
    planId,
    status: PLANS[planId].requiresApproval ? 'pending' : 'active',
    createdAt: now,
    approvedAt: PLANS[planId].requiresApproval ? null : now,
    tokensUsedThisMonth: 0,
    periodStart: now,
  };
  saveSubscription(sub);
  return sub;
}

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
// No localStorage is used for admin data.
// ─────────────────────────────────────────────────────────────────────────────

/** Admin email that can approve demo subscriptions */
export const ADMIN_EMAIL = 'jjrchefen@hotmail.com';
