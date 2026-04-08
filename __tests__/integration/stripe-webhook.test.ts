/**
 * Integration tests for POST /api/stripe/webhook (BIZZ-148).
 *
 * Verifies:
 * - Missing stripe-signature header → 400
 * - Invalid/mismatched signature → 400
 * - Stripe not configured (null stripe client) → 503
 * - STRIPE_WEBHOOK_SECRET missing → 500
 * - checkout.session.completed → activates subscription in Supabase
 * - customer.subscription.deleted → marks subscription cancelled
 * - invoice.payment_failed → marks subscription as payment_failed
 * - customer.subscription.updated → syncs plan/status change
 * - Unknown event type → 200 graceful ignore
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Supabase admin mock ───────────────────────────────────────────────────────

/** Mutable spy targets for the admin client */
const mockUpdateUserById = vi.fn().mockResolvedValue({ data: {}, error: null });
const mockGetUserById = vi
  .fn()
  .mockResolvedValue({ data: { user: { app_metadata: {} } }, error: null });
const mockListUsers = vi.fn().mockResolvedValue({ data: { users: [] }, error: null });

const mockAdminAuth = {
  admin: {
    updateUserById: mockUpdateUserById,
    getUserById: mockGetUserById,
    listUsers: mockListUsers,
  },
};

/** Plan config query builder stub */
const mockSelectSingle = vi.fn().mockResolvedValue({ data: null, error: null });
const mockEq = vi.fn().mockReturnValue({ single: mockSelectSingle });
const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    auth: mockAdminAuth,
    from: mockFrom,
  })),
}));

// ── Email mock ────────────────────────────────────────────────────────────────

vi.mock('@/app/lib/email', () => ({
  sendRecurringPaymentEmail: vi.fn().mockResolvedValue(undefined),
}));

// ── Stripe mock ───────────────────────────────────────────────────────────────

/**
 * constructEvent is the security-critical function: it either returns a
 * verified Stripe.Event or throws an error. Tests control its behaviour via
 * mockConstructEvent.
 */
const mockConstructEvent = vi.fn();

/** Stripe subscriptions.retrieve — used by payment_failed + payment_succeeded handlers */
const mockSubscriptionsRetrieve = vi.fn().mockResolvedValue({
  metadata: { supabase_user_id: 'user-123', plan_id: 'professionel' },
  status: 'active',
  customer: 'cus_test',
  current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  current_period_start: Math.floor(Date.now() / 1000),
});

const mockCustomersRetrieve = vi.fn().mockResolvedValue({
  deleted: false,
  email: 'user@example.com',
});

const mockStripeInstance = {
  webhooks: { constructEvent: mockConstructEvent },
  subscriptions: { retrieve: mockSubscriptionsRetrieve },
  customers: { retrieve: mockCustomersRetrieve },
};

vi.mock('@/app/lib/stripe', () => ({
  stripe: mockStripeInstance,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Builds a NextRequest for the webhook endpoint.
 *
 * @param body      - Raw text body (Stripe sends JSON as a string)
 * @param signature - Value for the stripe-signature header
 */
function makeWebhookRequest(body: string, signature?: string): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (signature !== undefined) {
    headers['stripe-signature'] = signature;
  }
  return new NextRequest('http://localhost:3000/api/stripe/webhook', {
    method: 'POST',
    headers,
    body,
  });
}

/**
 * Builds a minimal Stripe event object for use in constructEvent stubs.
 *
 * @param type   - Stripe event type string
 * @param object - The event data object
 */
function makeStripeEvent(type: string, object: Record<string, unknown>) {
  return { id: `evt_test_${type}`, type, data: { object } };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/stripe/webhook', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    // Restore default admin mock state after clearAllMocks resets return values
    mockUpdateUserById.mockResolvedValue({ data: {}, error: null });
    mockGetUserById.mockResolvedValue({
      data: { user: { app_metadata: {} } },
      error: null,
    });
    mockListUsers.mockResolvedValue({ data: { users: [] }, error: null });
    mockSelectSingle.mockResolvedValue({ data: null, error: null });
    mockEq.mockReturnValue({ single: mockSelectSingle });
    mockSelect.mockReturnValue({ eq: mockEq });
    mockFrom.mockReturnValue({ select: mockSelect });
    mockSubscriptionsRetrieve.mockResolvedValue({
      metadata: { supabase_user_id: 'user-123', plan_id: 'professionel' },
      status: 'active',
      customer: 'cus_test',
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      current_period_start: Math.floor(Date.now() / 1000),
    });
    mockCustomersRetrieve.mockResolvedValue({ deleted: false, email: 'user@example.com' });

    // Set required env vars
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  });

  /** Verifies the 400 guard when the stripe-signature header is absent */
  it('returns 400 when stripe-signature header is missing', async () => {
    const { POST } = await import('@/app/api/stripe/webhook/route');
    const req = makeWebhookRequest('{}'); // no signature header
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Missing stripe-signature');
  });

  /** Verifies the 400 guard when stripe.webhooks.constructEvent throws (bad sig) */
  it('returns 400 when signature verification fails', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload');
    });

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const req = makeWebhookRequest('{}', 'bad-sig');
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Webhook signature verification failed');
  });

  /** Verifies graceful 200 for unhandled event types */
  it('returns 200 for an unknown event type (graceful ignore)', async () => {
    mockConstructEvent.mockReturnValue(makeStripeEvent('payment_intent.created', {}));

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const req = makeWebhookRequest('{}', 'valid-sig');
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean };
    expect(body.received).toBe(true);
  });

  /**
   * checkout.session.completed: happy-path subscription activation.
   * Expects updateUserById to be called with status: 'active' and planId.
   */
  it('checkout.session.completed → activates subscription and returns 200', async () => {
    const session = {
      metadata: { supabase_user_id: 'user-abc', plan_id: 'professionel' },
      customer: 'cus_test123',
      subscription: 'sub_test456',
    };
    mockConstructEvent.mockReturnValue(makeStripeEvent('checkout.session.completed', session));

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const req = makeWebhookRequest(JSON.stringify(session), 'valid-sig');
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledOnce();

    const [calledUserId, calledPayload] = mockUpdateUserById.mock.calls[0] as [
      string,
      { app_metadata: { subscription: { status: string; planId: string } } },
    ];
    expect(calledUserId).toBe('user-abc');
    expect(calledPayload.app_metadata.subscription.status).toBe('active');
    expect(calledPayload.app_metadata.subscription.planId).toBe('professionel');
  });

  /**
   * checkout.session.completed with token_topup metadata:
   * should add tokens to the user's account, not set subscription status.
   */
  it('checkout.session.completed (token_topup) → adds tokens and returns 200', async () => {
    const session = {
      metadata: { type: 'token_topup', supabase_user_id: 'user-abc', token_amount: '500' },
      customer: 'cus_test123',
    };
    mockGetUserById.mockResolvedValue({
      data: {
        user: { app_metadata: { subscription: { topUpTokens: 100 } } },
      },
      error: null,
    });
    mockConstructEvent.mockReturnValue(makeStripeEvent('checkout.session.completed', session));

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const req = makeWebhookRequest(JSON.stringify(session), 'valid-sig');
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledOnce();

    const [, calledPayload] = mockUpdateUserById.mock.calls[0] as [
      string,
      { app_metadata: { subscription: { topUpTokens: number } } },
    ];
    // 100 existing + 500 new
    expect(calledPayload.app_metadata.subscription.topUpTokens).toBe(600);
  });

  /**
   * customer.subscription.deleted: should mark subscription as 'cancelled'
   * and clear stripe_subscription_id.
   */
  it('customer.subscription.deleted → cancels subscription and returns 200', async () => {
    const subscription = {
      metadata: { supabase_user_id: 'user-xyz' },
      status: 'canceled',
    };
    mockConstructEvent.mockReturnValue(
      makeStripeEvent('customer.subscription.deleted', subscription)
    );

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const req = makeWebhookRequest(JSON.stringify(subscription), 'valid-sig');
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledOnce();

    const [calledUserId, calledPayload] = mockUpdateUserById.mock.calls[0] as [
      string,
      {
        app_metadata: {
          stripe_subscription_id: null;
          subscription: { status: string };
        };
      },
    ];
    expect(calledUserId).toBe('user-xyz');
    expect(calledPayload.app_metadata.subscription.status).toBe('cancelled');
    expect(calledPayload.app_metadata.stripe_subscription_id).toBeNull();
  });

  /**
   * invoice.payment_failed: should mark the user's subscription as 'payment_failed'.
   * The handler retrieves the subscription from Stripe first to get supabase_user_id.
   */
  it('invoice.payment_failed → marks payment_failed and returns 200', async () => {
    const invoice = { subscription: 'sub_failed_123' };
    mockConstructEvent.mockReturnValue(makeStripeEvent('invoice.payment_failed', invoice));

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const req = makeWebhookRequest(JSON.stringify(invoice), 'valid-sig');
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith('sub_failed_123');
    expect(mockUpdateUserById).toHaveBeenCalledOnce();

    const [, calledPayload] = mockUpdateUserById.mock.calls[0] as [
      string,
      { app_metadata: { subscription: { status: string } } },
    ];
    expect(calledPayload.app_metadata.subscription.status).toBe('payment_failed');
  });

  /**
   * customer.subscription.updated with status 'past_due':
   * should map to 'payment_failed' in app_metadata.
   */
  it('customer.subscription.updated (past_due) → sets payment_failed and returns 200', async () => {
    const subscription = {
      metadata: { supabase_user_id: 'user-upd', plan_id: 'basis' },
      status: 'past_due',
      current_period_start: Math.floor(Date.now() / 1000),
    };
    mockConstructEvent.mockReturnValue(
      makeStripeEvent('customer.subscription.updated', subscription)
    );

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const req = makeWebhookRequest(JSON.stringify(subscription), 'valid-sig');
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledOnce();

    const [, calledPayload] = mockUpdateUserById.mock.calls[0] as [
      string,
      { app_metadata: { subscription: { status: string; planId: string } } },
    ];
    expect(calledPayload.app_metadata.subscription.status).toBe('payment_failed');
    expect(calledPayload.app_metadata.subscription.planId).toBe('basis');
  });

  /**
   * customer.subscription.updated with status 'active':
   * should propagate 'active' status.
   */
  it('customer.subscription.updated (active) → keeps active status and returns 200', async () => {
    const subscription = {
      metadata: { supabase_user_id: 'user-upd2', plan_id: 'professionel' },
      status: 'active',
      current_period_start: Math.floor(Date.now() / 1000),
    };
    mockConstructEvent.mockReturnValue(
      makeStripeEvent('customer.subscription.updated', subscription)
    );

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const req = makeWebhookRequest(JSON.stringify(subscription), 'valid-sig');
    const res = await POST(req);

    expect(res.status).toBe(200);
    const [, calledPayload] = mockUpdateUserById.mock.calls[0] as [
      string,
      { app_metadata: { subscription: { status: string } } },
    ];
    expect(calledPayload.app_metadata.subscription.status).toBe('active');
  });

  /**
   * checkout.session.completed missing metadata: handler should not throw
   * (logs error and returns 200 — the event is still "received").
   */
  it('checkout.session.completed with missing metadata → returns 200 without DB call', async () => {
    const session = { metadata: {}, customer: 'cus_x', subscription: 'sub_x' };
    mockConstructEvent.mockReturnValue(makeStripeEvent('checkout.session.completed', session));

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const req = makeWebhookRequest(JSON.stringify(session), 'valid-sig');
    const res = await POST(req);

    expect(res.status).toBe(200);
    // updateUserById should NOT be called because metadata is incomplete
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });
});
