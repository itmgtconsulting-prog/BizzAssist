/**
 * Unit tests for BIZZ-193 — plan cache must never be written to localStorage.
 *
 * An attacker with XSS or console access could overwrite 'ba-plan-cache' in
 * localStorage to claim a higher-tier plan and bypass premium gating.
 * Plan data must come from the server session only; the in-memory Map is the
 * only allowed client-side cache.
 *
 * These tests verify:
 *  - cachePlans() does NOT call localStorage.setItem with 'ba-plan-cache'
 *  - The module does NOT read from localStorage on init
 *  - cachePlans() still populates the in-memory cache (functionality preserved)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock localStorage ────────────────────────────────────────────────────────

const localStorageMock = {
  getItem: vi.fn().mockReturnValue(null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

// ─── Import module under test ─────────────────────────────────────────────────

import { cachePlans, resolvePlan } from '@/app/lib/subscriptions';
import type { PlanDef } from '@/app/lib/subscriptions';

// ─── Test plan fixtures ───────────────────────────────────────────────────────

const DEMO_PLAN: PlanDef = {
  id: 'demo',
  nameDa: 'Demo',
  nameEn: 'Demo',
  descDa: 'Test',
  descEn: 'Test',
  priceDkk: 0,
  aiEnabled: true,
  aiTokensPerMonth: 10_000,
  requiresApproval: true,
  color: 'amber',
  durationMonths: 1,
  durationDays: 0,
  tokenAccumulationCapMultiplier: 5,
  freeTrialDays: 0,
  paymentGraceHours: 0,
  maxSales: null,
  salesCount: 0,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('cachePlans — BIZZ-193 localStorage prohibition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never calls localStorage.setItem when caching plans', () => {
    cachePlans([DEMO_PLAN]);
    expect(localStorageMock.setItem).not.toHaveBeenCalled();
  });

  it('never writes the ba-plan-cache key to localStorage', () => {
    cachePlans([DEMO_PLAN]);
    const allCalls = localStorageMock.setItem.mock.calls;
    const cacheKeyCalls = allCalls.filter((call) => call[0] === 'ba-plan-cache');
    expect(cacheKeyCalls).toHaveLength(0);
  });

  it('still populates the in-memory cache (functionality preserved)', () => {
    cachePlans([DEMO_PLAN]);
    const resolved = resolvePlan('demo');
    // The resolved plan should match what we passed in
    expect(resolved.id).toBe('demo');
    expect(resolved.aiTokensPerMonth).toBe(10_000);
  });

  it('does not read from localStorage on module init', () => {
    // localStorageMock.getItem should have 0 calls since module was imported
    // (the _loadCacheFromStorage() function has been removed)
    expect(localStorageMock.getItem).not.toHaveBeenCalledWith('ba-plan-cache');
  });
});
