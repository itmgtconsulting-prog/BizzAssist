/**
 * Unit tests for the Stripe webhook handler.
 *
 * Tests all five handled event types plus the security validation layer:
 *   - checkout.session.completed (subscription + token top-up)
 *   - customer.subscription.updated
 *   - customer.subscription.deleted
 *   - invoice.payment_succeeded
 *   - invoice.payment_failed
 *   - unknown event types (passthrough)
 *
 * All external dependencies (Stripe SDK, Supabase admin, email) are mocked
 * so the tests run offline with no real credentials required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Stripe mock ─────────────────────────────────────────────────────────────

const mockConstructEvent = vi.fn();
const mockSubscriptionsRetrieve = vi.fn();
const mockCustomersRetrieve = vi.fn();

vi.mock('@/app/lib/stripe', () => ({
  stripe: {
    webhooks: { constructEvent: mockConstructEvent },
    subscriptions: { retrieve: mockSubscriptionsRetrieve },
    customers: { retrieve: mockCustomersRetrieve },
  },
}));

// ─── Supabase admin mock ──────────────────────────────────────────────────────

const mockUpdateUserById = vi.fn();
const mockGetUserById = vi.fn();
const mockListUsers = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        updateUserById: mockUpdateUserById,
        getUserById: mockGetUserById,
        listUsers: mockListUsers,
      },
    },
    from: mockFrom,
  }),
}));

// ─── Email mock ───────────────────────────────────────────────────────────────

const mockSendRecurringPaymentEmail = vi.fn();

vi.mock('@/app/lib/email', () => ({
  sendRecurringPaymentEmail: mockSendRecurringPaymentEmail,
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Builds a minimal NextRequest with the given body and optional stripe-signature header.
 */
function buildRequest(body: string, signature?: string): NextRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (signature !== undefined) {
    headers['stripe-signature'] = signature;
  }
  return new NextRequest('http://localhost/api/stripe/webhook', {
    method: 'POST',
    body,
    headers,
  });
}

/**
 * Builds a Stripe-like event object for use in mockConstructEvent.
 */
function makeEvent(type: string, data: unknown): Record<string, unknown> {
  return { type, data: { object: data } };
}

/**
 * Default mock user returned by getUserById.
 * BIZZ-543: includes `id` so resolveUserId's step-1 direct lookup succeeds.
 */
function mockUser(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      user: {
        id: (overrides as { id?: string }).id ?? 'mock-user-id',
        email: 'test@example.com',
        app_metadata: {
          subscription: { planId: 'basis', status: 'active', tokensUsedThisMonth: 0 },
        },
        ...overrides,
      },
    },
    error: null,
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.RESEND_API_KEY = '';

  // Default: updateUserById succeeds silently
  mockUpdateUserById.mockResolvedValue({ data: {}, error: null });
  // Default: getUserById echoes the requested id so resolveUserId step-1 succeeds
  mockGetUserById.mockImplementation((id: string) => Promise.resolve(mockUser({ id })));
  // Default: listUsers returns empty list
  mockListUsers.mockResolvedValue({ data: { users: [] } });
  // Default: from().select().eq().single() returns null (plan name lookup)
  const mockChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
  mockFrom.mockReturnValue(mockChain);
});

// ─── Import after mocks ────────────────────────────────────────────────────────

const { POST } = await import('@/app/api/stripe/webhook/route');

// ─── Security validation ──────────────────────────────────────────────────────

describe('POST /api/stripe/webhook — security', () => {
  it('returns 400 when stripe-signature header is missing', async () => {
    const req = buildRequest('{}'); // no signature
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/signature/i);
  });

  it('returns 400 when signature verification fails', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature');
    });
    const req = buildRequest('{}', 'bad-signature');
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/signature/i);
  });

  it('returns 500 when STRIPE_WEBHOOK_SECRET is not set', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const req = buildRequest('{}', 'some-sig');
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});

// ─── checkout.session.completed (subscription) ────────────────────────────────

describe('checkout.session.completed — subscription', () => {
  it('activates subscription in Supabase with planId and status=active', async () => {
    const session = {
      metadata: { supabase_user_id: 'user-123', plan_id: 'professionel' },
      customer: 'cus_abc',
      subscription: 'sub_xyz',
    };
    mockConstructEvent.mockReturnValue(makeEvent('checkout.session.completed', session));

    const req = buildRequest('{}', 'valid-sig');
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({
        app_metadata: expect.objectContaining({
          stripe_customer_id: 'cus_abc',
          stripe_subscription_id: 'sub_xyz',
          subscription: expect.objectContaining({
            planId: 'professionel',
            status: 'active',
          }),
        }),
      })
    );
  });

  it('returns 200 but skips update when supabase_user_id is missing', async () => {
    const session = { metadata: {}, customer: 'cus_abc', subscription: 'sub_xyz' };
    mockConstructEvent.mockReturnValue(makeEvent('checkout.session.completed', session));

    const req = buildRequest('{}', 'valid-sig');
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });
});

// ─── checkout.session.completed (token top-up) ────────────────────────────────

describe('checkout.session.completed — token top-up', () => {
  it('adds tokens to user account', async () => {
    const session = {
      metadata: { type: 'token_topup', supabase_user_id: 'user-123', token_amount: '50000' },
    };
    mockConstructEvent.mockReturnValue(makeEvent('checkout.session.completed', session));
    mockGetUserById.mockResolvedValue(
      mockUser({
        app_metadata: { subscription: { planId: 'basis', status: 'active', topUpTokens: 10000 } },
      })
    );

    const req = buildRequest('{}', 'valid-sig');
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({
        app_metadata: expect.objectContaining({
          subscription: expect.objectContaining({ topUpTokens: 60000 }),
        }),
      })
    );
  });
});

// ─── customer.subscription.updated ────────────────────────────────────────────

describe('customer.subscription.updated', () => {
  it('updates plan and status=active for active subscription', async () => {
    const subscription = {
      metadata: { supabase_user_id: 'user-123', plan_id: 'enterprise' },
      status: 'active',
      current_period_start: Math.floor(Date.now() / 1000),
    };
    mockConstructEvent.mockReturnValue(makeEvent('customer.subscription.updated', subscription));

    const req = buildRequest('{}', 'valid-sig');
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({
        app_metadata: expect.objectContaining({
          subscription: expect.objectContaining({ planId: 'enterprise', status: 'active' }),
        }),
      })
    );
  });

  it('maps past_due Stripe status to payment_failed', async () => {
    const subscription = {
      metadata: { supabase_user_id: 'user-456', plan_id: 'basis' },
      status: 'past_due',
      current_period_start: Math.floor(Date.now() / 1000),
    };
    mockConstructEvent.mockReturnValue(makeEvent('customer.subscription.updated', subscription));

    const req = buildRequest('{}', 'valid-sig');
    await POST(req);

    expect(mockUpdateUserById).toHaveBeenCalledWith(
      'user-456',
      expect.objectContaining({
        app_metadata: expect.objectContaining({
          subscription: expect.objectContaining({ status: 'payment_failed' }),
        }),
      })
    );
  });

  it('maps canceled Stripe status to cancelled', async () => {
    const subscription = {
      metadata: { supabase_user_id: 'user-789', plan_id: 'basis' },
      status: 'canceled',
      current_period_start: Math.floor(Date.now() / 1000),
    };
    mockConstructEvent.mockReturnValue(makeEvent('customer.subscription.updated', subscription));

    const req = buildRequest('{}', 'valid-sig');
    await POST(req);

    expect(mockUpdateUserById).toHaveBeenCalledWith(
      'user-789',
      expect.objectContaining({
        app_metadata: expect.objectContaining({
          subscription: expect.objectContaining({ status: 'cancelled' }),
        }),
      })
    );
  });
});

// ─── customer.subscription.deleted ────────────────────────────────────────────

describe('customer.subscription.deleted', () => {
  it('marks subscription as cancelled', async () => {
    const subscription = {
      metadata: { supabase_user_id: 'user-del' },
    };
    mockConstructEvent.mockReturnValue(makeEvent('customer.subscription.deleted', subscription));

    const req = buildRequest('{}', 'valid-sig');
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledWith(
      'user-del',
      expect.objectContaining({
        app_metadata: expect.objectContaining({
          stripe_subscription_id: null,
          subscription: expect.objectContaining({ status: 'cancelled' }),
        }),
      })
    );
  });
});

// ─── invoice.payment_succeeded ────────────────────────────────────────────────

describe('invoice.payment_succeeded', () => {
  it('skips initial subscription invoice (billing_reason=subscription_create)', async () => {
    const invoice = { billing_reason: 'subscription_create', id: 'inv_001', subscription: null };
    mockConstructEvent.mockReturnValue(makeEvent('invoice.payment_succeeded', invoice));

    const req = buildRequest('{}', 'valid-sig');
    const res = await POST(req);

    expect(res.status).toBe(200);
    // No email sent, no subscription retrieved
    expect(mockSendRecurringPaymentEmail).not.toHaveBeenCalled();
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
  });

  it('sends recurring payment email for renewal invoices', async () => {
    const sub = {
      metadata: { supabase_user_id: 'user-renewal', plan_id: 'professionel' },
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    };
    mockSubscriptionsRetrieve.mockResolvedValue(sub);
    mockSendRecurringPaymentEmail.mockResolvedValue(undefined);
    process.env.RESEND_API_KEY = 'test-key';

    const invoice = {
      billing_reason: 'subscription_cycle',
      id: 'inv_002',
      subscription: 'sub_renewal',
      amount_paid: 29900,
    };
    mockConstructEvent.mockReturnValue(makeEvent('invoice.payment_succeeded', invoice));

    const req = buildRequest('{}', 'valid-sig');
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith('sub_renewal');
    expect(mockSendRecurringPaymentEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'test@example.com',
        priceDkk: 299,
      })
    );
  });
});

// ─── invoice.payment_failed ───────────────────────────────────────────────────

describe('invoice.payment_failed', () => {
  it('marks subscription as payment_failed', async () => {
    const sub = { metadata: { supabase_user_id: 'user-fail' } };
    mockSubscriptionsRetrieve.mockResolvedValue(sub);

    const invoice = { subscription: 'sub_fail' };
    mockConstructEvent.mockReturnValue(makeEvent('invoice.payment_failed', invoice));

    const req = buildRequest('{}', 'valid-sig');
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledWith(
      'user-fail',
      expect.objectContaining({
        app_metadata: expect.objectContaining({
          subscription: expect.objectContaining({ status: 'payment_failed' }),
        }),
      })
    );
  });

  it('returns 200 when invoice has no subscription ID', async () => {
    const invoice = { subscription: null };
    mockConstructEvent.mockReturnValue(makeEvent('invoice.payment_failed', invoice));

    const req = buildRequest('{}', 'valid-sig');
    const res = await POST(req);

    // Returns ok (Stripe expects 200 — the error is logged, not surfaced)
    expect(res.status).toBe(200);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });
});

// ─── Unknown event types ──────────────────────────────────────────────────────

describe('unhandled event types', () => {
  it('returns 200 for unknown event types without calling Supabase', async () => {
    mockConstructEvent.mockReturnValue(makeEvent('charge.refunded', {}));

    const req = buildRequest('{}', 'valid-sig');
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });
});
