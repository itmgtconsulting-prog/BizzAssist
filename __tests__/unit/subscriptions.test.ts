/**
 * Unit tests for app/lib/subscriptions.ts — plan definitions and billing logic.
 *
 * Covers:
 *   - PLANS constant: all four plans exist with correct IDs and feature flags
 *   - resolvePlan: cached plan takes precedence, falls back to hardcoded, then synthetic
 *   - cachePlans / resolvePlan: cache is populated and cleared correctly
 *   - formatTokens: Danish thousands separator and M suffix
 *   - isSubscriptionFunctional: active + paid, active + free, inactive, null
 *   - getEffectiveTokenLimit: plan tokens + accumulated + topUp + bonus, unlimited (-1)
 *   - getTokenAccumulationCap: multiplier * monthly tokens, 0 for no-AI plans
 *   - getPlanDurationMs: months vs days billing cycle
 *   - computeTokenRollover: no-op when period not ended, rolls unused tokens forward
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PLANS,
  PLAN_LIST,
  resolvePlan,
  cachePlans,
  formatTokens,
  isSubscriptionFunctional,
  getEffectiveTokenLimit,
  getTokenAccumulationCap,
  getPlanDurationMs,
  computeTokenRollover,
  type PlanDef,
  type UserSubscription,
} from '@/app/lib/subscriptions';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a minimal UserSubscription for testing.
 */
function makeSub(overrides: Partial<UserSubscription> = {}): UserSubscription {
  return {
    email: 'test@example.com',
    planId: 'professionel',
    status: 'active',
    createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    approvedAt: new Date().toISOString(),
    tokensUsedThisMonth: 0,
    periodStart: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    isPaid: true,
    ...overrides,
  };
}

// ─── PLANS constant ───────────────────────────────────────────────────────────

describe('PLANS constant', () => {
  it('contains all four plan IDs', () => {
    expect(Object.keys(PLANS)).toEqual(
      expect.arrayContaining(['demo', 'basis', 'professionel', 'enterprise'])
    );
  });

  it('demo plan has aiEnabled=true and requiresApproval=true', () => {
    expect(PLANS.demo.aiEnabled).toBe(true);
    expect(PLANS.demo.requiresApproval).toBe(true);
    expect(PLANS.demo.priceDkk).toBe(0);
  });

  it('basis plan has aiEnabled=false', () => {
    expect(PLANS.basis.aiEnabled).toBe(false);
    expect(PLANS.basis.aiTokensPerMonth).toBe(0);
  });

  it('professionel plan has 50 000 tokens/month', () => {
    expect(PLANS.professionel.aiTokensPerMonth).toBe(50_000);
    expect(PLANS.professionel.priceDkk).toBe(799);
  });

  it('enterprise plan has unlimited tokens (-1)', () => {
    expect(PLANS.enterprise.aiTokensPerMonth).toBe(-1);
    expect(PLANS.enterprise.priceDkk).toBe(2499);
  });

  it('PLAN_LIST contains all four plans in order', () => {
    const ids = PLAN_LIST.map((p) => p.id);
    expect(ids).toEqual(['demo', 'basis', 'professionel', 'enterprise']);
  });
});

// ─── resolvePlan / cachePlans ─────────────────────────────────────────────────

describe('resolvePlan', () => {
  beforeEach(() => {
    // Clear cache between tests by caching an empty array
    cachePlans([]);
  });

  it('returns the hardcoded plan for a known planId when cache is empty', () => {
    const plan = resolvePlan('professionel');
    expect(plan.id).toBe('professionel');
    expect(plan.aiTokensPerMonth).toBe(50_000);
  });

  it('returns a synthetic fallback for an unknown planId', () => {
    const plan = resolvePlan('custom-unknown-plan');
    expect(plan.id).toBe('custom-unknown-plan');
    expect(plan.aiEnabled).toBe(false);
    expect(plan.aiTokensPerMonth).toBe(0);
  });

  it('returns the cached plan (overrides hardcoded) when cache is populated', () => {
    const customPlan: PlanDef = {
      ...PLANS.professionel,
      id: 'professionel',
      aiTokensPerMonth: 99_999, // overridden
    };
    cachePlans([customPlan]);

    const plan = resolvePlan('professionel');
    expect(plan.aiTokensPerMonth).toBe(99_999);
  });

  it('cachePlans clears the cache on each call (replaces previous plans)', () => {
    cachePlans([{ ...PLANS.basis, aiTokensPerMonth: 1234 }]);
    cachePlans([]); // clear

    // Should fall back to hardcoded
    const plan = resolvePlan('basis');
    expect(plan.aiTokensPerMonth).toBe(0);
  });
});

// ─── formatTokens ─────────────────────────────────────────────────────────────

describe('formatTokens', () => {
  it('formats small numbers without separator', () => {
    expect(formatTokens(35)).toBe('35');
    expect(formatTokens(999)).toBe('999');
  });

  it('adds dot as thousands separator', () => {
    expect(formatTokens(10_000)).toBe('10.000');
    expect(formatTokens(50_000)).toBe('50.000');
    expect(formatTokens(500_000)).toBe('500.000');
  });

  it('formats millions with M suffix and comma decimal', () => {
    expect(formatTokens(1_000_000)).toBe('1,0M');
    expect(formatTokens(1_500_000)).toBe('1,5M');
    expect(formatTokens(2_000_000)).toBe('2,0M');
  });

  it('formats 0 correctly', () => {
    expect(formatTokens(0)).toBe('0');
  });
});

// ─── isSubscriptionFunctional ─────────────────────────────────────────────────

describe('isSubscriptionFunctional', () => {
  it('returns false when sub is null', () => {
    expect(isSubscriptionFunctional(null, PLANS.professionel)).toBe(false);
  });

  it('returns false when plan is null', () => {
    expect(isSubscriptionFunctional(makeSub(), null)).toBe(false);
  });

  it('returns false when status is not active', () => {
    expect(isSubscriptionFunctional(makeSub({ status: 'cancelled' }), PLANS.professionel)).toBe(
      false
    );
    expect(isSubscriptionFunctional(makeSub({ status: 'expired' }), PLANS.professionel)).toBe(
      false
    );
    expect(isSubscriptionFunctional(makeSub({ status: 'pending' }), PLANS.professionel)).toBe(
      false
    );
  });

  it('returns true for active + paid subscription', () => {
    expect(isSubscriptionFunctional(makeSub({ isPaid: true }), PLANS.professionel)).toBe(true);
  });

  it('returns false for free plan with requiresApproval when not approved (isPaid=false)', () => {
    // BIZZ-431: Demo plan requires admin approval — isPaid must be true
    expect(isSubscriptionFunctional(makeSub({ isPaid: false }), PLANS.demo)).toBe(false);
  });

  it('returns true for free plan with requiresApproval when approved (isPaid=true)', () => {
    expect(isSubscriptionFunctional(makeSub({ isPaid: true }), PLANS.demo)).toBe(true);
  });

  it('returns false for active paid plan where isPaid is false and no trial', () => {
    const noTrialPlan: PlanDef = { ...PLANS.professionel, freeTrialDays: 0 };
    expect(isSubscriptionFunctional(makeSub({ isPaid: false }), noTrialPlan)).toBe(false);
  });

  it('returns true when within free trial window', () => {
    const trialPlan: PlanDef = { ...PLANS.professionel, freeTrialDays: 14 };
    const sub = makeSub({
      isPaid: false,
      // Created 3 days ago — still within 14-day trial
      createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(isSubscriptionFunctional(sub, trialPlan)).toBe(true);
  });

  it('returns false when free trial has expired', () => {
    const trialPlan: PlanDef = { ...PLANS.professionel, freeTrialDays: 7 };
    const sub = makeSub({
      isPaid: false,
      // Created 10 days ago — trial expired
      createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(isSubscriptionFunctional(sub, trialPlan)).toBe(false);
  });

  // ── BIZZ-541: per-plan paymentGraceHours ───────────────────────────────────

  it('past_due with paymentGraceHours=0 blocks access immediately (default behavior)', () => {
    // Default plans have paymentGraceHours=0 — failed payment = same as unpaid
    const sub = makeSub({
      status: 'past_due',
      graceExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(isSubscriptionFunctional(sub, PLANS.professionel)).toBe(false);
  });

  it('past_due with paymentGraceHours>0 and future graceExpiresAt grants access', () => {
    const gracePlan: PlanDef = { ...PLANS.professionel, paymentGraceHours: 48 };
    const sub = makeSub({
      status: 'past_due',
      graceExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(isSubscriptionFunctional(sub, gracePlan)).toBe(true);
  });

  it('past_due with paymentGraceHours>0 but expired graceExpiresAt blocks access', () => {
    const gracePlan: PlanDef = { ...PLANS.professionel, paymentGraceHours: 48 };
    const sub = makeSub({
      status: 'past_due',
      graceExpiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
    });
    expect(isSubscriptionFunctional(sub, gracePlan)).toBe(false);
  });

  it('payment_failed status always blocks regardless of plan grace', () => {
    const gracePlan: PlanDef = { ...PLANS.professionel, paymentGraceHours: 48 };
    const sub = makeSub({
      status: 'payment_failed',
      graceExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(isSubscriptionFunctional(sub, gracePlan)).toBe(false);
  });

  it('past_due with grace>0 but missing graceExpiresAt fails open (legacy records)', () => {
    const gracePlan: PlanDef = { ...PLANS.professionel, paymentGraceHours: 48 };
    const sub = makeSub({ status: 'past_due' }); // no graceExpiresAt at all
    expect(isSubscriptionFunctional(sub, gracePlan)).toBe(true);
  });
});

// ─── getEffectiveTokenLimit ───────────────────────────────────────────────────

describe('getEffectiveTokenLimit', () => {
  it('returns -1 for unlimited plans (enterprise)', () => {
    expect(getEffectiveTokenLimit(makeSub(), PLANS.enterprise)).toBe(-1);
  });

  it('returns 0 for plans with aiEnabled=false', () => {
    expect(getEffectiveTokenLimit(makeSub(), PLANS.basis)).toBe(0);
  });

  it('returns plan tokens + accumulated + topUp + bonus', () => {
    const sub = makeSub({
      accumulatedTokens: 10_000,
      topUpTokens: 5_000,
      bonusTokens: 2_000,
    });
    // professionel: 50_000 base + 10_000 accumulated + 5_000 topUp + 2_000 bonus
    expect(getEffectiveTokenLimit(sub, PLANS.professionel)).toBe(67_000);
  });

  it('treats undefined optional token fields as 0', () => {
    const sub = makeSub(); // no accumulated, topUp, or bonus
    expect(getEffectiveTokenLimit(sub, PLANS.professionel)).toBe(50_000);
  });
});

// ─── getTokenAccumulationCap ──────────────────────────────────────────────────

describe('getTokenAccumulationCap', () => {
  it('returns 0 for plans with no AI tokens', () => {
    expect(getTokenAccumulationCap(PLANS.basis)).toBe(0);
    expect(getTokenAccumulationCap(PLANS.demo)).not.toBe(0); // demo has AI
  });

  it('returns multiplier * monthly tokens for AI plans', () => {
    // professionel: 50_000 * 5 = 250_000
    expect(getTokenAccumulationCap(PLANS.professionel)).toBe(250_000);
  });

  it('returns 0 for unlimited plans (aiTokensPerMonth === -1)', () => {
    // enterprise has -1 tokens, cap formula uses <= 0 guard
    expect(getTokenAccumulationCap(PLANS.enterprise)).toBe(0);
  });
});

// ─── getPlanDurationMs ────────────────────────────────────────────────────────

describe('getPlanDurationMs', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('returns 30 days in ms for a 1-month plan', () => {
    expect(getPlanDurationMs(PLANS.professionel)).toBe(30 * DAY_MS);
  });

  it('uses durationDays when it is > 0 (overrides months)', () => {
    const weeklyPlan: PlanDef = { ...PLANS.basis, durationDays: 7, durationMonths: 0 };
    expect(getPlanDurationMs(weeklyPlan)).toBe(7 * DAY_MS);
  });

  it('falls back to months when durationDays is 0', () => {
    const threeMonthPlan: PlanDef = { ...PLANS.basis, durationDays: 0, durationMonths: 3 };
    expect(getPlanDurationMs(threeMonthPlan)).toBe(3 * 30 * DAY_MS);
  });
});

// ─── computeTokenRollover ─────────────────────────────────────────────────────

describe('computeTokenRollover', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('returns null when the current billing period has not ended yet', () => {
    const sub = makeSub({
      periodStart: new Date(Date.now() - 5 * DAY_MS).toISOString(), // 5 days in
      tokensUsedThisMonth: 10_000,
    });
    const result = computeTokenRollover(sub, PLANS.professionel);
    expect(result).toBeNull();
  });

  it('rolls over unused tokens to accumulated when period has ended', () => {
    const sub = makeSub({
      // Period started 31 days ago → ended 1 day ago
      periodStart: new Date(Date.now() - 31 * DAY_MS).toISOString(),
      tokensUsedThisMonth: 20_000, // used 20k of 50k
      accumulatedTokens: 0,
    });
    const result = computeTokenRollover(sub, PLANS.professionel);

    expect(result).not.toBeNull();
    // Unused = 50_000 - 20_000 = 30_000 accumulated
    expect(result!.accumulatedTokens).toBe(30_000);
    expect(result!.tokensUsedThisMonth).toBe(0);
  });

  it('caps accumulated tokens at the accumulation cap', () => {
    const sub = makeSub({
      periodStart: new Date(Date.now() - 31 * DAY_MS).toISOString(),
      tokensUsedThisMonth: 0, // all 50k unused
      // Already near cap (250_000 = 50_000 * 5)
      accumulatedTokens: 230_000,
    });
    const result = computeTokenRollover(sub, PLANS.professionel);

    expect(result).not.toBeNull();
    // Would add 50_000 but cap is 250_000 → clamp
    expect(result!.accumulatedTokens).toBe(250_000);
  });

  it('does not accumulate for plans with aiTokensPerMonth <= 0', () => {
    const sub = makeSub({
      planId: 'basis',
      periodStart: new Date(Date.now() - 31 * DAY_MS).toISOString(),
      tokensUsedThisMonth: 0,
      accumulatedTokens: 0,
    });
    const result = computeTokenRollover(sub, PLANS.basis);

    expect(result).not.toBeNull();
    expect(result!.accumulatedTokens).toBe(0);
  });
});
