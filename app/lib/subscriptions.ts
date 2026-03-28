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
 * Look up a subscription by email in the global list.
 * Used to load the correct subscription when a user logs in.
 *
 * @param email - User email to look up
 * @returns UserSubscription or null if not found
 */
export function getSubscriptionForEmail(email: string): UserSubscription | null {
  const all = getAllSubscriptions();
  return all.find((s) => s.email === email) ?? null;
}

/**
 * Switch the active local subscription to match the given email.
 * Looks up the email in the global list and saves it as the current user's subscription.
 * If the email is the admin and has no subscription yet, seeds one.
 *
 * @param email - The email of the user who just logged in
 * @returns The active subscription
 */
export function switchActiveUser(email: string): UserSubscription | null {
  // Look up existing subscription in the global list
  let sub = getSubscriptionForEmail(email);

  if (email === ADMIN_EMAIL) {
    const now = new Date().toISOString();
    if (!sub) {
      // Admin has no subscription yet — create one
      sub = {
        email: ADMIN_EMAIL,
        planId: 'enterprise',
        status: 'active',
        createdAt: now,
        approvedAt: now,
        tokensUsedThisMonth: 0,
        periodStart: now,
      };
    } else {
      // Admin exists — always ensure active + enterprise
      sub.status = 'active';
      sub.planId = 'enterprise';
      if (!sub.approvedAt) sub.approvedAt = now;
    }
    registerSubscription(sub);
  }

  if (sub) {
    saveSubscription(sub);
  }

  return sub;
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

// ─── Admin: all subscriptions (localStorage for demo) ────────────────────────

const ALL_SUBS_KEY = 'ba-all-subscriptions';

/**
 * Get all subscriptions (admin view).
 *
 * @returns Array of all user subscriptions
 */
export function getAllSubscriptions(): UserSubscription[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(ALL_SUBS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as UserSubscription[];
  } catch {
    return [];
  }
}

/**
 * Save all subscriptions (admin view).
 *
 * @param subs - Array of all user subscriptions
 */
export function saveAllSubscriptions(subs: UserSubscription[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(ALL_SUBS_KEY, JSON.stringify(subs));
  } catch {
    // ignore
  }
}

/**
 * Register a new subscription in the global list (called on sign-up).
 *
 * @param sub - New subscription to register
 */
export function registerSubscription(sub: UserSubscription): void {
  const all = getAllSubscriptions();
  // Replace if same email exists
  const idx = all.findIndex((s) => s.email === sub.email);
  if (idx >= 0) {
    all[idx] = sub;
  } else {
    all.push(sub);
  }
  saveAllSubscriptions(all);
}

/**
 * Remove a subscription from the global list (admin action).
 *
 * @param email - Email of the user to remove
 */
export function removeSubscription(email: string): void {
  const all = getAllSubscriptions();
  const filtered = all.filter((s) => s.email !== email);
  saveAllSubscriptions(filtered);

  // If it's the active user, clear their local sub too
  const current = getSubscription();
  if (current?.email === email) {
    clearActiveSubscription();
  }
}

/**
 * Approve a pending subscription (admin action).
 *
 * @param email - Email of the user to approve
 * @returns Updated subscription or null
 */
export function approveSubscription(email: string): UserSubscription | null {
  const all = getAllSubscriptions();
  const sub = all.find((s) => s.email === email);
  if (!sub) return null;
  sub.status = 'active';
  sub.approvedAt = new Date().toISOString();
  saveAllSubscriptions(all);

  // If it's the current user, update their local sub too
  const current = getSubscription();
  if (current?.email === email) {
    current.status = 'active';
    current.approvedAt = sub.approvedAt;
    saveSubscription(current);
  }

  return sub;
}

/**
 * Reject/cancel a subscription (admin action).
 *
 * @param email - Email of the user to reject
 * @returns Updated subscription or null
 */
export function rejectSubscription(email: string): UserSubscription | null {
  const all = getAllSubscriptions();
  const sub = all.find((s) => s.email === email);
  if (!sub) return null;
  sub.status = 'cancelled';
  saveAllSubscriptions(all);
  return sub;
}

/**
 * Update a user's subscription plan (admin action).
 *
 * @param email - Email of the user to update
 * @param planId - New plan ID
 * @returns Updated subscription or null
 */
export function updateSubscriptionPlan(email: string, planId: PlanId): UserSubscription | null {
  const all = getAllSubscriptions();
  const sub = all.find((s) => s.email === email);
  if (!sub) return null;
  sub.planId = planId;
  saveAllSubscriptions(all);

  // Sync current user's local sub
  const current = getSubscription();
  if (current?.email === email) {
    current.planId = planId;
    saveSubscription(current);
  }

  return sub;
}

/**
 * Update a user's subscription status (admin action).
 *
 * @param email - Email of the user to update
 * @param status - New status
 * @returns Updated subscription or null
 */
export function updateSubscriptionStatus(
  email: string,
  status: SubStatus
): UserSubscription | null {
  const all = getAllSubscriptions();
  const sub = all.find((s) => s.email === email);
  if (!sub) return null;

  sub.status = status;
  if (status === 'active' && !sub.approvedAt) {
    sub.approvedAt = new Date().toISOString();
  }
  saveAllSubscriptions(all);

  // Sync current user's local sub
  const current = getSubscription();
  if (current?.email === email) {
    current.status = status;
    if (status === 'active' && !current.approvedAt) {
      current.approvedAt = sub.approvedAt;
    }
    saveSubscription(current);
  }

  return sub;
}

/**
 * Add extra AI tokens to a user's subscription (admin action).
 *
 * @param email - Email of the user
 * @param tokens - Number of tokens to add (added to monthly limit as bonus)
 * @returns Updated subscription or null
 */
export function addBonusTokens(email: string, tokens: number): UserSubscription | null {
  const all = getAllSubscriptions();
  const sub = all.find((s) => s.email === email);
  if (!sub) return null;

  // Store bonus tokens as a separate field
  sub.bonusTokens = (sub.bonusTokens ?? 0) + tokens;
  saveAllSubscriptions(all);

  // Sync current user's local sub
  const current = getSubscription();
  if (current?.email === email) {
    current.bonusTokens = sub.bonusTokens;
    saveSubscription(current);
  }

  return sub;
}

/**
 * Reset a user's monthly token usage to 0 (admin action).
 *
 * @param email - Email of the user
 * @returns Updated subscription or null
 */
export function resetTokenUsage(email: string): UserSubscription | null {
  const all = getAllSubscriptions();
  const sub = all.find((s) => s.email === email);
  if (!sub) return null;

  sub.tokensUsedThisMonth = 0;
  sub.periodStart = new Date().toISOString();
  saveAllSubscriptions(all);

  // Sync current user's local sub
  const current = getSubscription();
  if (current?.email === email) {
    current.tokensUsedThisMonth = 0;
    current.periodStart = sub.periodStart;
    saveSubscription(current);
  }

  return sub;
}

/** Admin email that can approve demo subscriptions */
export const ADMIN_EMAIL = 'jjrchefen@hotmail.com';
