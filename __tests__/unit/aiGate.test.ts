/**
 * Unit-tests for BIZZ-649 P0 — central AI billing-gate (`assertAiAllowed`).
 *
 * Dette er den delte gate-helper der wraps `decideAiGate()` og tilføjer
 *  - admin-bypass (`app_metadata.isAdmin === true`)
 *  - -1 unlimited plan-konvention
 *  - Sentry-breadcrumb på zero_budget
 *  - HTTP-response mapping (403/429/402)
 *
 * `decideAiGate()` har sine egne unit-tests i `decideAiGate.test.ts`. Her
 * verificerer vi KUN den kode der ligger uden om den rene decision-funktion
 * (Supabase-opslag, admin-check, -1 check, response-mapping).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────
// Hoisted: factory må ikke referere variabler deklareret nedenfor.

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  addBreadcrumb: vi.fn(),
}));

vi.mock('@/app/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── Import efter mocks ──────────────────────────────────────────────────

import { assertAiAllowed, UNLIMITED_TOKENS_SENTINEL } from '@/app/lib/aiGate';
import { createAdminClient } from '@/lib/supabase/admin';
import * as Sentry from '@sentry/nextjs';

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Build a mock admin-client where:
 *  - `getUserById(userId)` returns `{ data: { user: { app_metadata } }, error: null }`
 *  - `.from('plan_configs').select(...).eq(...).single()` returns planRow
 */
function mockAdminClient(opts: {
  appMetadata?: Record<string, unknown> | null;
  getUserError?: unknown;
  planRow?: { ai_tokens_per_month: number } | null;
}) {
  const getUserById = vi
    .fn()
    .mockResolvedValue(
      opts.getUserError
        ? { data: null, error: opts.getUserError }
        : { data: { user: { app_metadata: opts.appMetadata ?? {} } }, error: null }
    );

  const single = vi.fn().mockResolvedValue({ data: opts.planRow ?? null, error: null });
  const eq = vi.fn().mockReturnValue({ single });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });

  vi.mocked(createAdminClient).mockReturnValue({
    auth: { admin: { getUserById } },
    from,
  } as unknown as ReturnType<typeof createAdminClient>);

  return { getUserById, from, select, eq, single };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('assertAiAllowed — BIZZ-649 P0 central billing gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when userId is empty', async () => {
    const res = await assertAiAllowed('');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it('returns 403 when Supabase getUserById fails', async () => {
    mockAdminClient({ getUserError: new Error('boom') });
    const res = await assertAiAllowed('user-1');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('BIZZ-649 policy 1: admin-brugere bypasser gate uden subscription-check', async () => {
    const mocks = mockAdminClient({
      appMetadata: { isAdmin: true },
      // Bevidst ingen subscription — skal stadig tillades
    });
    const res = await assertAiAllowed('admin-user');
    expect(res).toBeNull();
    // Vigtigt: vi må IKKE slå plan_configs op for admins
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('BIZZ-649 policy 2: -1 plan_configs = unlimited → allow uden quota-check', async () => {
    mockAdminClient({
      appMetadata: {
        subscription: {
          status: 'active',
          planId: 'enterprise',
          tokensUsedThisMonth: 999_999_999,
        },
      },
      planRow: { ai_tokens_per_month: UNLIMITED_TOKENS_SENTINEL },
    });
    const res = await assertAiAllowed('ent-user');
    expect(res).toBeNull();
  });

  it('allows active bruger med plan-tokens og forbrug under kvote', async () => {
    mockAdminClient({
      appMetadata: {
        subscription: {
          status: 'active',
          planId: 'pro',
          tokensUsedThisMonth: 1000,
          bonusTokens: 0,
          topUpTokens: 0,
        },
      },
      planRow: { ai_tokens_per_month: 50_000 },
    });
    const res = await assertAiAllowed('pro-user');
    expect(res).toBeNull();
  });

  it('blocker trial-bruger uden bonus/topUp som zero_budget → 402 + trial_ai_blocked', async () => {
    mockAdminClient({
      appMetadata: {
        subscription: {
          status: 'trialing',
          planId: 'pro',
          tokensUsedThisMonth: 0,
          bonusTokens: 0,
          topUpTokens: 0,
        },
      },
      planRow: { ai_tokens_per_month: 50_000 },
    });
    const res = await assertAiAllowed('trial-user');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(402);
    const body = await res!.json();
    expect(body.code).toBe('trial_ai_blocked');
    expect(body.cta).toBe('buy_token_pack');
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'billing', message: 'AI blocked: zero_budget' })
    );
  });

  it('tillader trial-bruger med købt token-pakke (topUp > 0)', async () => {
    mockAdminClient({
      appMetadata: {
        subscription: {
          status: 'trialing',
          planId: 'pro',
          tokensUsedThisMonth: 0,
          topUpTokens: 5000,
          bonusTokens: 0,
        },
      },
      planRow: { ai_tokens_per_month: 50_000 },
    });
    const res = await assertAiAllowed('trial-topup-user');
    expect(res).toBeNull();
  });

  it('returnerer 403 no_subscription når subscription.status er tom', async () => {
    mockAdminClient({
      appMetadata: {
        // Ingen subscription = ingen status
      },
    });
    const res = await assertAiAllowed('user-no-sub');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('returnerer 429 quota_exceeded når tokensUsed >= effective limit', async () => {
    mockAdminClient({
      appMetadata: {
        subscription: {
          status: 'active',
          planId: 'pro',
          tokensUsedThisMonth: 50_000,
          bonusTokens: 0,
          topUpTokens: 0,
        },
      },
      planRow: { ai_tokens_per_month: 50_000 },
    });
    const res = await assertAiAllowed('used-up-user');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
  });

  it('BIZZ-653: blokerer active-men-ubetalt abonnement uanset plan-tokens', async () => {
    // Crossshoppen-scenariet: requires_approval=true plan oprettet som
    // status=active men isPaid=false indtil Stripe/admin bekræfter.
    mockAdminClient({
      appMetadata: {
        subscription: {
          status: 'active',
          isPaid: false,
          planId: 'testplan3',
          tokensUsedThisMonth: 0,
        },
      },
      planRow: { ai_tokens_per_month: 100_000 },
    });
    const res = await assertAiAllowed('unpaid-active-user');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(402);
    const body = await res!.json();
    expect(body.code).toBe('trial_ai_blocked');
    expect(body.error).toContain('ikke betalt');
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'AI blocked: active_unpaid' })
    );
  });

  it('BIZZ-653: tillader active + isPaid=true (betalt abonnement)', async () => {
    mockAdminClient({
      appMetadata: {
        subscription: {
          status: 'active',
          isPaid: true,
          planId: 'testplan3',
          tokensUsedThisMonth: 0,
        },
      },
      planRow: { ai_tokens_per_month: 100_000 },
    });
    const res = await assertAiAllowed('paid-active-user');
    expect(res).toBeNull();
  });

  it('BIZZ-653: tillader active uden isPaid-flag (backwards compat)', async () => {
    // Gamle subscriptions uden isPaid-felt skal fortsat virke.
    mockAdminClient({
      appMetadata: {
        subscription: {
          status: 'active',
          planId: 'testplan3',
          tokensUsedThisMonth: 0,
        },
      },
      planRow: { ai_tokens_per_month: 100_000 },
    });
    const res = await assertAiAllowed('legacy-active-user');
    expect(res).toBeNull();
  });

  it('active user med plan=0 bonus=0 topUp=0 → 402 zero_budget (non-trial messaging)', async () => {
    mockAdminClient({
      appMetadata: {
        subscription: {
          status: 'active',
          planId: 'basic',
          tokensUsedThisMonth: 0,
          bonusTokens: 0,
          topUpTokens: 0,
        },
      },
      planRow: { ai_tokens_per_month: 0 },
    });
    const res = await assertAiAllowed('zero-active-user');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(402);
    const body = await res!.json();
    expect(body.code).toBe('trial_ai_blocked');
    expect(body.error).toContain('ingen AI-tokens');
  });
});
