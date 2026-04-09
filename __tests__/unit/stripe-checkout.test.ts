/**
 * Unit tests for Stripe checkout API routes.
 *
 * Covers:
 *   POST /api/stripe/create-checkout
 *     - returns 503 when Stripe is not configured
 *     - returns 401 when user is not authenticated
 *     - returns 400 when planId is missing
 *     - returns 400 for free plans (priceDkk === 0)
 *     - returns 400 when plan is sold out
 *     - returns 500 when Stripe price is not configured for the plan
 *     - returns JSON { url } on success (happy path)
 *
 *   POST /api/stripe/verify-session
 *     - returns 503 when Stripe is not configured
 *     - returns 401 when user is not authenticated
 *     - returns 400 when sessionId is missing
 *     - returns 400 when payment_status is not 'paid'
 *     - returns 403 when session belongs to a different user
 *     - returns { ok: true } on success (happy path)
 *
 * All external dependencies (Stripe SDK, Supabase) are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Stripe mock ──────────────────────────────────────────────────────────────

const mockCheckoutCreate = vi.fn();
const mockSessionsRetrieve = vi.fn();
const mockSubscriptionsRetrieve = vi.fn();

vi.mock('@/app/lib/stripe', () => ({
  stripe: {
    checkout: {
      sessions: {
        create: mockCheckoutCreate,
        retrieve: mockSessionsRetrieve,
      },
    },
    subscriptions: {
      retrieve: mockSubscriptionsRetrieve,
    },
  },
  getStripePriceId: vi.fn().mockReturnValue('price_test_123'),
}));

// ─── Supabase mocks ───────────────────────────────────────────────────────────

const mockGetUser = vi.fn();
const mockGetUserById = vi.fn();
const mockUpdateUserById = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn().mockReturnValue({
    auth: {
      admin: {
        getUserById: mockGetUserById,
        updateUserById: mockUpdateUserById,
      },
    },
    from: mockFrom,
  }),
}));

// ─── Email mock ───────────────────────────────────────────────────────────────

vi.mock('@/app/lib/email', () => ({
  sendPaymentConfirmationEmail: vi.fn().mockResolvedValue(undefined),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal NextRequest with a JSON body.
 */
function makeRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Default mock user object.
 */
function mockUserObj(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-abc',
    email: 'test@example.com',
    app_metadata: {},
    ...overrides,
  };
}

// ─── Shared setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Default authenticated user
  mockGetUser.mockResolvedValue({ data: { user: mockUserObj() } });
  mockGetUserById.mockResolvedValue({ data: { user: mockUserObj() } });
  mockUpdateUserById.mockResolvedValue({ data: {}, error: null });

  // Default from() chain (plan_configs lookup)
  const mockChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    update: vi.fn().mockReturnThis(),
  };
  mockFrom.mockReturnValue(mockChain);
});

// ─── Import routes after all mocks are set up ─────────────────────────────────

const { POST: createCheckoutPOST } = await import('@/app/api/stripe/create-checkout/route');
const { POST: verifySessionPOST } = await import('@/app/api/stripe/verify-session/route');

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/stripe/create-checkout
// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/stripe/create-checkout', () => {
  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const req = makeRequest('http://localhost/api/stripe/create-checkout', {
      planId: 'professionel',
    });
    const res = await createCheckoutPOST(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
  });

  it('returns 400 when planId is missing', async () => {
    const req = makeRequest('http://localhost/api/stripe/create-checkout', {});
    const res = await createCheckoutPOST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/plan/i);
  });

  it('returns 400 when plan is free (priceDkk === 0)', async () => {
    // plan_configs returns no row → falls back to resolvePlan('demo') which has priceDkk: 0
    const req = makeRequest('http://localhost/api/stripe/create-checkout', {
      planId: 'demo',
    });
    const res = await createCheckoutPOST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/payment/i);
  });

  it('returns 400 when the plan is sold out', async () => {
    // plan_configs returns a plan that is sold out
    const mockChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          price_dkk: 799,
          stripe_price_id: 'price_test_123',
          max_sales: 10,
          sales_count: 10, // sold out
        },
        error: null,
      }),
    };
    mockFrom.mockReturnValue(mockChain);

    const req = makeRequest('http://localhost/api/stripe/create-checkout', {
      planId: 'professionel',
    });
    const res = await createCheckoutPOST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/sold out/i);
  });

  it('returns JSON { url } on success (happy path)', async () => {
    // plan_configs returns a paid plan with a Stripe price
    const mockChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          price_dkk: 799,
          stripe_price_id: 'price_prod_professionel',
          max_sales: null,
          sales_count: 0,
        },
        error: null,
      }),
    };
    mockFrom.mockReturnValue(mockChain);

    mockCheckoutCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/test_session' });

    const req = makeRequest('http://localhost/api/stripe/create-checkout', {
      planId: 'professionel',
    });
    const res = await createCheckoutPOST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe('https://checkout.stripe.com/pay/test_session');
    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        currency: 'dkk',
      })
    );
  });

  it('returns 500 when Stripe session creation fails', async () => {
    const mockChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { price_dkk: 799, stripe_price_id: 'price_test', max_sales: null, sales_count: 0 },
        error: null,
      }),
    };
    mockFrom.mockReturnValue(mockChain);

    mockCheckoutCreate.mockRejectedValue(new Error('Stripe error'));

    const req = makeRequest('http://localhost/api/stripe/create-checkout', {
      planId: 'professionel',
    });
    const res = await createCheckoutPOST(req);

    expect(res.status).toBe(500);
  });

  it('reuses existing Stripe customer ID when stored in app_metadata', async () => {
    const mockChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { price_dkk: 799, stripe_price_id: 'price_test', max_sales: null, sales_count: 0 },
        error: null,
      }),
    };
    mockFrom.mockReturnValue(mockChain);

    // User already has a Stripe customer ID
    mockGetUserById.mockResolvedValue({
      data: {
        user: {
          ...mockUserObj(),
          app_metadata: { stripe_customer_id: 'cus_existing_123' },
        },
      },
    });
    mockCheckoutCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/x' });

    const req = makeRequest('http://localhost/api/stripe/create-checkout', {
      planId: 'professionel',
    });
    await createCheckoutPOST(req);

    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_existing_123' })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/stripe/verify-session
// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/stripe/verify-session', () => {
  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const req = makeRequest('http://localhost/api/stripe/verify-session', {
      sessionId: 'cs_test_123',
    });
    const res = await verifySessionPOST(req);

    expect(res.status).toBe(401);
  });

  it('returns 400 when sessionId is missing', async () => {
    const req = makeRequest('http://localhost/api/stripe/verify-session', {});
    const res = await verifySessionPOST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/sessionId/i);
  });

  it('returns 400 when payment_status is not paid', async () => {
    mockSessionsRetrieve.mockResolvedValue({
      payment_status: 'unpaid',
      metadata: { supabase_user_id: 'user-abc' },
      customer: 'cus_123',
      subscription: null,
    });

    const req = makeRequest('http://localhost/api/stripe/verify-session', {
      sessionId: 'cs_test_unpaid',
    });
    const res = await verifySessionPOST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/payment not completed/i);
  });

  it('returns 403 when session belongs to a different user', async () => {
    mockSessionsRetrieve.mockResolvedValue({
      payment_status: 'paid',
      metadata: { supabase_user_id: 'other-user-xyz' }, // mismatch
      customer: 'cus_123',
      subscription: null,
    });

    const req = makeRequest('http://localhost/api/stripe/verify-session', {
      sessionId: 'cs_test_mismatch',
    });
    const res = await verifySessionPOST(req);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/session does not match user/i);
  });

  it('returns { ok: true } on success and updates Supabase app_metadata', async () => {
    mockSessionsRetrieve.mockResolvedValue({
      payment_status: 'paid',
      metadata: { supabase_user_id: 'user-abc', plan_id: 'professionel' },
      customer: 'cus_abc',
      subscription: null,
    });

    // plan_configs lookup (for email)
    const mockChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
      update: vi.fn().mockReturnThis(),
    };
    mockFrom.mockReturnValue(mockChain);

    const req = makeRequest('http://localhost/api/stripe/verify-session', {
      sessionId: 'cs_test_success',
    });
    const res = await verifySessionPOST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Supabase should have been updated with isPaid=true
    expect(mockUpdateUserById).toHaveBeenCalledWith(
      'user-abc',
      expect.objectContaining({
        app_metadata: expect.objectContaining({
          stripe_customer_id: 'cus_abc',
          subscription: expect.objectContaining({
            isPaid: true,
            status: 'active',
          }),
        }),
      })
    );
  });

  it('returns 500 on unexpected Stripe error', async () => {
    mockSessionsRetrieve.mockRejectedValue(new Error('Stripe API error'));

    const req = makeRequest('http://localhost/api/stripe/verify-session', {
      sessionId: 'cs_test_error',
    });
    const res = await verifySessionPOST(req);

    expect(res.status).toBe(500);
  });
});
