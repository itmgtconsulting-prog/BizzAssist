/**
 * Unit-tests for BIZZ-649 P0 — AI-gating decision logic.
 *
 * Safety-kritisk: regression her er en direkte billing-lækage. Hver permutation
 * af subscription-state skal dækkes.
 */

import { describe, it, expect } from 'vitest';
import { decideAiGate } from '@/app/api/ai/chat/route';

describe('decideAiGate — BIZZ-649 P0 billing gate', () => {
  it('blocks when there is no subscription (null/undefined)', () => {
    expect(decideAiGate(null).decision).toBe('no_subscription');
    expect(decideAiGate(undefined).decision).toBe('no_subscription');
    expect(decideAiGate({}).decision).toBe('no_subscription');
  });

  it('blocks non-active/non-trialing status (past_due, canceled, paused)', () => {
    expect(decideAiGate({ status: 'past_due' }).decision).toBe('no_subscription');
    expect(decideAiGate({ status: 'canceled' }).decision).toBe('no_subscription');
    expect(decideAiGate({ status: 'paused' }).decision).toBe('no_subscription');
    expect(decideAiGate({ status: '' }).decision).toBe('no_subscription');
  });

  it('BIZZ-649: blocks active user with plan=0 bonus=0 topUp=0 (zero budget)', () => {
    const res = decideAiGate({
      status: 'active',
      planTokens: 0,
      bonusTokens: 0,
      topUpTokens: 0,
      tokensUsedThisMonth: 0,
    });
    expect(res.decision).toBe('zero_budget');
    expect(res.isTrial).toBe(false);
    expect(res.effectiveLimit).toBe(0);
  });

  it('BIZZ-649: blocks trialing user with no topUp/bonus (zero budget)', () => {
    const res = decideAiGate({
      status: 'trialing',
      planTokens: 0,
      bonusTokens: 0,
      topUpTokens: 0,
      tokensUsedThisMonth: 0,
    });
    expect(res.decision).toBe('zero_budget');
    expect(res.isTrial).toBe(true);
  });

  it('allows trialing user with purchased token-pack (topUp > 0)', () => {
    const res = decideAiGate({
      status: 'trialing',
      planTokens: 0,
      bonusTokens: 0,
      topUpTokens: 5000,
      tokensUsedThisMonth: 0,
    });
    expect(res.decision).toBe('allow');
    expect(res.isTrial).toBe(true);
    expect(res.effectiveLimit).toBe(5000);
  });

  it('allows trialing user with admin-granted bonus tokens', () => {
    expect(
      decideAiGate({
        status: 'trialing',
        planTokens: 0,
        bonusTokens: 1000,
        topUpTokens: 0,
      }).decision
    ).toBe('allow');
  });

  it('allows active user with plan quota', () => {
    const res = decideAiGate({
      status: 'active',
      planTokens: 50_000,
      bonusTokens: 0,
      topUpTokens: 0,
      tokensUsedThisMonth: 1000,
    });
    expect(res.decision).toBe('allow');
    expect(res.effectiveLimit).toBe(50_000);
  });

  it('blocks with quota_exceeded when tokensUsed >= limit', () => {
    const res = decideAiGate({
      status: 'active',
      planTokens: 1000,
      bonusTokens: 0,
      topUpTokens: 0,
      tokensUsedThisMonth: 1000,
    });
    expect(res.decision).toBe('quota_exceeded');
  });

  it('blocks with quota_exceeded even when topUp pool exists but total used', () => {
    const res = decideAiGate({
      status: 'active',
      planTokens: 1000,
      bonusTokens: 500,
      topUpTokens: 500,
      tokensUsedThisMonth: 2000,
    });
    expect(res.decision).toBe('quota_exceeded');
    expect(res.effectiveLimit).toBe(2000);
  });

  it('handles partial undefined fields gracefully (defaults to 0)', () => {
    expect(decideAiGate({ status: 'active' }).decision).toBe('zero_budget');
    expect(decideAiGate({ status: 'active', planTokens: 100 }).decision).toBe('allow');
  });

  it('isTrial flag reflects status for UI messaging', () => {
    expect(decideAiGate({ status: 'trialing' }).isTrial).toBe(true);
    expect(decideAiGate({ status: 'active' }).isTrial).toBe(false);
  });
});
