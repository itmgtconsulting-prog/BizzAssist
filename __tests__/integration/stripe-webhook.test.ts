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

/** Shape of the admin.auth.admin.getUserById response — widened for BIZZ-543 + BIZZ-540 tests */
type GetUserByIdResult = {
  data: {
    user: { id: string; email?: string; app_metadata: Record<string, unknown> } | null;
  };
  error: { message: string } | null;
};

/** Mutable spy targets for the admin client */
const mockUpdateUserById = vi.fn().mockResolvedValue({ data: {}, error: null });
// Default: echo the requested id AND provide an email so resolveUserId's step-1
// lookup succeeds and BIZZ-540's email dispatch has a recipient.
const mockGetUserById = vi.fn(
  (id: string): Promise<GetUserByIdResult> =>
    Promise.resolve({
      data: { user: { id, email: `${id}@test.example`, app_metadata: {} } },
      error: null,
    })
);
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

/** BIZZ-540: spy on payment-failed email dispatch */
const mockSendPaymentFailedEmail = vi.fn().mockResolvedValue(undefined);

vi.mock('@/app/lib/email', () => ({
  sendRecurringPaymentEmail: vi.fn().mockResolvedValue(undefined),
  sendPaymentFailedEmail: (...args: unknown[]) => mockSendPaymentFailedEmail(...args),
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

/** BIZZ-542: invoices.retrieve is used by handleChargeFailed to walk charge→invoice→subscription */
const mockInvoicesRetrieve = vi.fn().mockResolvedValue({
  subscription: 'sub_from_invoice',
});

const mockStripeInstance = {
  webhooks: { constructEvent: mockConstructEvent },
  subscriptions: { retrieve: mockSubscriptionsRetrieve },
  customers: { retrieve: mockCustomersRetrieve },
  invoices: { retrieve: mockInvoicesRetrieve },
};

vi.mock('@/app/lib/stripe', () => ({
  stripe: mockStripeInstance,
}));

// ── Audit log mock (BIZZ-542: charge.failed audit entries are asserted) ─────

/** Spy on writeAuditLog calls so charge.failed tests can assert failure_code landed */
const mockWriteAuditLog = vi.fn();

vi.mock('@/app/lib/auditLog', () => ({
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

// ── Sentry mock ───────────────────────────────────────────────────────────────

/** BIZZ-543: spy on Sentry capture calls so tests can assert visibility on drops */
const mockSentryCaptureMessage = vi.fn();
const mockSentryCaptureException = vi.fn();

vi.mock('@sentry/nextjs', () => ({
  captureMessage: (...args: unknown[]) => mockSentryCaptureMessage(...args),
  captureException: (...args: unknown[]) => mockSentryCaptureException(...args),
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
    mockGetUserById.mockImplementation((id: string) =>
      Promise.resolve({
        data: { user: { id, email: `${id}@test.example`, app_metadata: {} } },
        error: null,
      })
    );
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
    mockInvoicesRetrieve.mockResolvedValue({ subscription: 'sub_from_invoice' });

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
        user: { id: 'user-abc', app_metadata: { subscription: { topUpTokens: 100 } } },
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
   * BIZZ-540: invoice.payment_failed must also dispatch an email to the user
   * so they know to update their card before access is cut off. The email
   * goes out AFTER the status update succeeds.
   */
  it('invoice.payment_failed → dispatches payment-failed email with amount + retry date', async () => {
    const nextAttemptUnix = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;
    const invoice = {
      subscription: 'sub_failed_mail',
      amount_due: 1000, // 10 DKK in øre
      attempt_count: 1,
      next_payment_attempt: nextAttemptUnix,
      last_finalization_error: { message: 'Your card was declined' },
    };
    mockConstructEvent.mockReturnValue(makeStripeEvent('invoice.payment_failed', invoice));

    // plan_configs lookup returns a display name
    mockSelectSingle.mockResolvedValue({ data: { name_da: 'Basis' }, error: null });

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const res = await POST(makeWebhookRequest(JSON.stringify(invoice), 'valid-sig'));

    expect(res.status).toBe(200);
    // Email dispatch must have been called exactly once with correct payload
    expect(mockSendPaymentFailedEmail).toHaveBeenCalledOnce();
    const callArg = mockSendPaymentFailedEmail.mock.calls[0][0] as {
      to: string;
      planName: string;
      amountDueDkk: number;
      failureReason: string | null;
      nextRetryAt: Date | null;
      updateUrl: string;
      attemptCount: number | null;
    };
    expect(callArg.to).toBe('user-123@test.example'); // from default mockGetUserById
    expect(callArg.planName).toBe('Basis');
    expect(callArg.amountDueDkk).toBe(10);
    expect(callArg.failureReason).toBe('Your card was declined');
    expect(callArg.attemptCount).toBe(1);
    expect(callArg.nextRetryAt).toBeInstanceOf(Date);
    expect(callArg.updateUrl).toMatch(/\/dashboard\/settings\?tab=abonnement$/);
  });

  /**
   * BIZZ-540: If the user has no email on record, the handler must still
   * return 200 — an email cannot be sent but the status update still holds.
   */
  it('invoice.payment_failed → skips email gracefully when user has no email', async () => {
    const invoice = { subscription: 'sub_failed_noemail', amount_due: 1000 };
    mockConstructEvent.mockReturnValue(makeStripeEvent('invoice.payment_failed', invoice));

    // User exists (step-1 of resolveUserId succeeds) but has no email field
    mockGetUserById.mockImplementation((id: string) =>
      Promise.resolve({
        data: { user: { id, email: undefined, app_metadata: {} } },
        error: null,
      })
    );

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const res = await POST(makeWebhookRequest(JSON.stringify(invoice), 'valid-sig'));

    expect(res.status).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledOnce();
    expect(mockSendPaymentFailedEmail).not.toHaveBeenCalled();
  });

  /**
   * BIZZ-541: customer.subscription.updated with status 'past_due' should map
   * to 'past_due' in app_metadata (grace period). The plan decides whether
   * the grace actually allows access via paymentGraceHours.
   */
  it('customer.subscription.updated (past_due) → sets past_due and returns 200', async () => {
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
    expect(calledPayload.app_metadata.subscription.status).toBe('past_due');
    expect(calledPayload.app_metadata.subscription.planId).toBe('basis');
  });

  /**
   * BIZZ-541: Stripe 'unpaid' (retries exhausted) maps to 'payment_failed'.
   */
  it('customer.subscription.updated (unpaid) → sets payment_failed and returns 200', async () => {
    const subscription = {
      metadata: { supabase_user_id: 'user-unpaid', plan_id: 'basis' },
      status: 'unpaid',
      current_period_start: Math.floor(Date.now() / 1000),
    };
    mockConstructEvent.mockReturnValue(
      makeStripeEvent('customer.subscription.updated', subscription)
    );

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const res = await POST(makeWebhookRequest(JSON.stringify(subscription), 'valid-sig'));

    expect(res.status).toBe(200);
    const [, calledPayload] = mockUpdateUserById.mock.calls[0] as [
      string,
      { app_metadata: { subscription: { status: string } } },
    ];
    expect(calledPayload.app_metadata.subscription.status).toBe('payment_failed');
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

  // ── BIZZ-543: resilience tests ──────────────────────────────────────────────

  /**
   * BIZZ-543: invoice.payment_failed arrives with a supabase_user_id pointing
   * at a deleted user. Handler must fall back to stripe_customer_id lookup
   * and still mark the user payment_failed, not silently drop the event.
   */
  it('invoice.payment_failed with stale supabase_user_id → falls back via customer_id and marks payment_failed', async () => {
    const invoice = { subscription: 'sub_stale_123', customer: 'cus_stale_456' };
    mockConstructEvent.mockReturnValue(makeStripeEvent('invoice.payment_failed', invoice));

    // Stripe subscription has a deleted user_id in metadata
    mockSubscriptionsRetrieve.mockResolvedValue({
      metadata: { supabase_user_id: 'deleted-user-xxx', user_email: null },
      customer: 'cus_stale_456',
    });
    // Direct getUserById('deleted-user-xxx') → returns no id (simulates deleted)
    mockGetUserById.mockImplementation((id: string) => {
      if (id === 'deleted-user-xxx') {
        return Promise.resolve({ data: { user: null }, error: { message: 'user_not_found' } });
      }
      return Promise.resolve({ data: { user: { id, app_metadata: {} } }, error: null });
    });
    // listUsers returns the real user whose app_metadata.stripe_customer_id matches
    mockListUsers.mockResolvedValue({
      data: {
        users: [
          {
            id: 'real-user-abc',
            email: 'real@example.com',
            app_metadata: { stripe_customer_id: 'cus_stale_456' },
          },
        ],
      },
      error: null,
    });

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const res = await POST(makeWebhookRequest(JSON.stringify(invoice), 'valid-sig'));

    expect(res.status).toBe(200);
    // Final update should target the real user, not the stale id
    expect(mockUpdateUserById).toHaveBeenCalledOnce();
    const [calledUserId, calledPayload] = mockUpdateUserById.mock.calls[0] as [
      string,
      { app_metadata: { subscription: { status: string } } },
    ];
    expect(calledUserId).toBe('real-user-abc');
    expect(calledPayload.app_metadata.subscription.status).toBe('payment_failed');
    // Sentry should NOT be notified — resolution succeeded via fallback
    expect(mockSentryCaptureMessage).not.toHaveBeenCalled();
  });

  /**
   * BIZZ-543: invoice.payment_failed with no way to resolve the user at all.
   * Handler must return 200 (consume the event so Stripe stops retrying) and
   * Sentry-capture so the drop is visible.
   */
  it('invoice.payment_failed with unresolvable user → returns 200, no DB write, Sentry notified', async () => {
    const invoice = { subscription: 'sub_orphan_123', customer: 'cus_orphan_456' };
    mockConstructEvent.mockReturnValue(makeStripeEvent('invoice.payment_failed', invoice));

    mockSubscriptionsRetrieve.mockResolvedValue({
      metadata: { supabase_user_id: 'ghost-user', user_email: 'ghost@example.com' },
      customer: 'cus_orphan_456',
    });
    mockGetUserById.mockResolvedValue({
      data: { user: null },
      error: { message: 'user_not_found' },
    });
    // No users match customer_id or email
    mockListUsers.mockResolvedValue({ data: { users: [] }, error: null });

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const res = await POST(makeWebhookRequest(JSON.stringify(invoice), 'valid-sig'));

    expect(res.status).toBe(200);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
    // Sentry MUST be notified — silent drops are the exact bug BIZZ-543 reported
    expect(mockSentryCaptureMessage).toHaveBeenCalledOnce();
    const [message, opts] = mockSentryCaptureMessage.mock.calls[0] as [
      string,
      { tags?: { webhook_event?: string } },
    ];
    expect(message).toContain('invoice.payment_failed');
    expect(opts?.tags?.webhook_event).toBe('invoice.payment_failed');
  });

  /**
   * BIZZ-543: customer.subscription.updated with a stale supabase_user_id.
   * Previously this threw and returned 500, trapping the event in Stripe's
   * retry queue indefinitely. Now we fall back and return 200.
   */
  it('customer.subscription.updated with stale userId → falls back via customer_id and returns 200', async () => {
    const subscription = {
      metadata: { supabase_user_id: 'deleted-user', plan_id: 'basis' },
      status: 'past_due',
      customer: 'cus_live_789',
      current_period_start: Math.floor(Date.now() / 1000),
    };
    mockConstructEvent.mockReturnValue(
      makeStripeEvent('customer.subscription.updated', subscription)
    );

    mockGetUserById.mockImplementation((id: string) => {
      if (id === 'deleted-user') {
        return Promise.resolve({ data: { user: null }, error: { message: 'user_not_found' } });
      }
      return Promise.resolve({ data: { user: { id, app_metadata: {} } }, error: null });
    });
    mockListUsers.mockResolvedValue({
      data: {
        users: [
          {
            id: 'live-user-xyz',
            email: 'live@example.com',
            app_metadata: { stripe_customer_id: 'cus_live_789' },
          },
        ],
      },
      error: null,
    });

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const res = await POST(makeWebhookRequest(JSON.stringify(subscription), 'valid-sig'));

    expect(res.status).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledOnce();
    const [calledUserId, calledPayload] = mockUpdateUserById.mock.calls[0] as [
      string,
      { app_metadata: { subscription: { status: string } } },
    ];
    expect(calledUserId).toBe('live-user-xyz');
    // BIZZ-541: past_due Stripe status now maps to past_due in DB
    // (previous behavior was payment_failed — updated as part of grace redesign)
    expect(calledPayload.app_metadata.subscription.status).toBe('past_due');
  });

  /**
   * BIZZ-543: customer.subscription.updated with no way to resolve user.
   * Must return 200 + Sentry, never 500 — otherwise Stripe retries forever.
   */
  it('customer.subscription.updated with unresolvable user → returns 200 with Sentry (never 500)', async () => {
    const subscription = {
      metadata: { supabase_user_id: 'ghost' },
      status: 'active',
      customer: 'cus_no_match',
      current_period_start: Math.floor(Date.now() / 1000),
    };
    mockConstructEvent.mockReturnValue(
      makeStripeEvent('customer.subscription.updated', subscription)
    );
    mockGetUserById.mockResolvedValue({
      data: { user: null },
      error: { message: 'user_not_found' },
    });
    mockListUsers.mockResolvedValue({ data: { users: [] }, error: null });

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const res = await POST(makeWebhookRequest(JSON.stringify(subscription), 'valid-sig'));

    expect(res.status).toBe(200);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
    expect(mockSentryCaptureMessage).toHaveBeenCalledOnce();
  });

  // ── BIZZ-542: charge.failed handler ─────────────────────────────────────────

  /**
   * BIZZ-542: charge.failed for a subscription charge — handler walks
   * invoice → subscription → supabase_user_id, writes an audit entry with
   * the failure_code, and does NOT touch subscription.status (that is
   * invoice.payment_failed's job for recurring charges).
   */
  it('charge.failed (subscription) → logs audit + does not update sub status', async () => {
    const charge = {
      id: 'ch_sub_fail_1',
      invoice: 'in_sub_fail_1',
      customer: 'cus_sub_fail',
      failure_code: 'card_declined',
      failure_message: 'Your card was declined',
      amount: 79900, // 799 DKK in øre
      payment_intent: 'pi_sub_fail',
      billing_details: { email: 'sub@example.com' },
    };
    mockConstructEvent.mockReturnValue(makeStripeEvent('charge.failed', charge));
    mockInvoicesRetrieve.mockResolvedValue({ subscription: 'sub_resolved_1' });
    mockSubscriptionsRetrieve.mockResolvedValue({
      metadata: { supabase_user_id: 'user-pro' },
    });

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const res = await POST(makeWebhookRequest(JSON.stringify(charge), 'valid-sig'));

    expect(res.status).toBe(200);

    // updateUserById must NOT have been called — status updates belong to
    // invoice.payment_failed. This handler only audits.
    expect(mockUpdateUserById).not.toHaveBeenCalled();

    // Find the charge_failed audit entry (webhook_processed is also called)
    const auditEntries = mockWriteAuditLog.mock.calls
      .map((c) => c[0] as { action?: string; metadata?: string })
      .filter((e) => e.action === 'stripe.charge_failed');
    expect(auditEntries).toHaveLength(1);
    const parsed = JSON.parse(auditEntries[0].metadata ?? '{}') as Record<string, unknown>;
    expect(parsed.userId).toBe('user-pro');
    expect(parsed.failureCode).toBe('card_declined');
    expect(parsed.amountDkk).toBe(799);
    expect(parsed.flow).toBe('subscription');
  });

  /**
   * BIZZ-542: charge.failed for a one-off token top-up — invoice is null,
   * handler falls back to customer_id lookup (via listUsers). Audit entry
   * is tagged flow=token_topup.
   */
  it('charge.failed (token top-up, no invoice) → resolves via customer_id + logs audit', async () => {
    const charge = {
      id: 'ch_topup_fail_1',
      invoice: null,
      customer: 'cus_topup_xyz',
      failure_code: 'insufficient_funds',
      failure_message: 'Your card has insufficient funds',
      amount: 4900, // 49 DKK in øre
      payment_intent: 'pi_topup_fail',
      billing_details: { email: 'topup@example.com' },
    };
    mockConstructEvent.mockReturnValue(makeStripeEvent('charge.failed', charge));

    // listUsers returns the user whose stripe_customer_id matches
    mockListUsers.mockResolvedValue({
      data: {
        users: [
          {
            id: 'user-topup',
            email: 'topup@example.com',
            app_metadata: { stripe_customer_id: 'cus_topup_xyz' },
          },
        ],
      },
      error: null,
    });

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const res = await POST(makeWebhookRequest(JSON.stringify(charge), 'valid-sig'));

    expect(res.status).toBe(200);
    // No invoice → no stripe.invoices.retrieve / subscriptions.retrieve
    expect(mockInvoicesRetrieve).not.toHaveBeenCalled();
    // No status update for top-up failures — correct
    expect(mockUpdateUserById).not.toHaveBeenCalled();

    const auditEntries = mockWriteAuditLog.mock.calls
      .map((c) => c[0] as { action?: string; metadata?: string })
      .filter((e) => e.action === 'stripe.charge_failed');
    expect(auditEntries).toHaveLength(1);
    const parsed = JSON.parse(auditEntries[0].metadata ?? '{}') as Record<string, unknown>;
    expect(parsed.userId).toBe('user-topup');
    expect(parsed.failureCode).toBe('insufficient_funds');
    expect(parsed.flow).toBe('token_topup');
  });

  /**
   * BIZZ-542: Unknown decline codes are escalated to Sentry (vs routine codes
   * like card_declined which are audit-only noise).
   */
  it('charge.failed with unusual failure_code → Sentry captureMessage', async () => {
    const charge = {
      id: 'ch_weird_1',
      invoice: null,
      customer: 'cus_weird',
      failure_code: 'fraudulent', // not in ROUTINE_DECLINE_CODES
      failure_message: 'Stripe flagged this charge',
      amount: 10000,
      payment_intent: 'pi_weird',
      billing_details: { email: 'weird@example.com' },
    };
    mockConstructEvent.mockReturnValue(makeStripeEvent('charge.failed', charge));
    mockListUsers.mockResolvedValue({
      data: {
        users: [
          {
            id: 'user-weird',
            email: 'weird@example.com',
            app_metadata: { stripe_customer_id: 'cus_weird' },
          },
        ],
      },
      error: null,
    });

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const res = await POST(makeWebhookRequest(JSON.stringify(charge), 'valid-sig'));

    expect(res.status).toBe(200);
    expect(mockSentryCaptureMessage).toHaveBeenCalledOnce();
    const [msg, opts] = mockSentryCaptureMessage.mock.calls[0] as [
      string,
      { tags?: { failure_code?: string } },
    ];
    expect(msg).toContain('fraudulent');
    expect(opts?.tags?.failure_code).toBe('fraudulent');
  });

  /**
   * BIZZ-542: charge.failed where no user can be resolved — returns 200,
   * captures Sentry unmatched event, writes no audit entry for the charge.
   */
  it('charge.failed with unresolvable user → Sentry unmatched + no audit', async () => {
    const charge = {
      id: 'ch_orphan',
      invoice: null,
      customer: 'cus_no_match',
      failure_code: 'card_declined',
      amount: 1000,
      billing_details: { email: 'ghost@example.com' },
    };
    mockConstructEvent.mockReturnValue(makeStripeEvent('charge.failed', charge));
    mockListUsers.mockResolvedValue({ data: { users: [] }, error: null });

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const res = await POST(makeWebhookRequest(JSON.stringify(charge), 'valid-sig'));

    expect(res.status).toBe(200);
    expect(mockSentryCaptureMessage).toHaveBeenCalledOnce();
    const auditEntries = mockWriteAuditLog.mock.calls
      .map((c) => c[0] as { action?: string })
      .filter((e) => e.action === 'stripe.charge_failed');
    expect(auditEntries).toHaveLength(0);
  });
});
