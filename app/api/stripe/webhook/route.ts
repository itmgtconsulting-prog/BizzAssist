/**
 * Stripe webhook handler — POST /api/stripe/webhook
 *
 * Receives and processes Stripe webhook events to keep Supabase user
 * app_metadata in sync with the Stripe subscription state.
 *
 * Handled events:
 *   - checkout.session.completed → activate subscription + store customer ID
 *   - customer.subscription.updated → update plan/status on changes
 *   - customer.subscription.deleted → mark subscription as cancelled
 *   - invoice.payment_succeeded → send recurring payment confirmation email
 *   - invoice.payment_failed → mark status as payment_failed
 *
 * Security:
 *   - Verifies Stripe webhook signature using STRIPE_WEBHOOK_SECRET
 *   - Uses raw body (not JSON-parsed) for signature verification
 *   - Updates Supabase via admin client (service role key)
 */

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { stripe } from '@/app/lib/stripe';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendRecurringPaymentEmail, sendPaymentFailedEmail } from '@/app/lib/email';
import { logger } from '@/app/lib/logger';
import { writeAuditLog } from '@/app/lib/auditLog';

/**
 * BIZZ-543: Shared 3-step fallback lookup that resolves a Supabase user ID
 * from partial Stripe data. Used by every webhook handler so a stale
 * `supabase_user_id` in Stripe metadata (e.g. pointing at a deleted user)
 * can never cause a webhook to silently drop an event.
 *
 * Steps, in order:
 *   1. Direct lookup by `userId` — verifies user still exists
 *   2. Scan auth.users for matching `app_metadata.stripe_customer_id`
 *   3. Scan auth.users for matching email
 *
 * @param admin      - Supabase admin client
 * @param candidates - Any known identifiers from the webhook payload
 * @returns The resolved Supabase user ID, or null if no match
 */
async function resolveUserId(
  admin: SupabaseClient,
  candidates: { userId?: string | null; customerId?: string | null; email?: string | null }
): Promise<string | null> {
  const { userId, customerId, email } = candidates;

  // Step 1: direct lookup — confirms user still exists
  if (userId) {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (!error && data?.user?.id) {
      return data.user.id;
    }
  }

  // Steps 2 + 3 require scanning users — fetch once, reuse
  if (!customerId && !email) return null;

  const { data: usersPage } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const users = usersPage?.users ?? [];

  if (customerId) {
    const match = users.find(
      (u) => (u.app_metadata?.stripe_customer_id as string | undefined) === customerId
    );
    if (match?.id) return match.id;
  }

  if (email) {
    const match = users.find((u) => u.email === email);
    if (match?.id) return match.id;
  }

  return null;
}

/**
 * BIZZ-543: Report an unmatched webhook event to Sentry so silent drops
 * become visible in production monitoring. Always safe to call — Sentry
 * degrades gracefully when DSN is not configured.
 *
 * @param eventType - Stripe event type (e.g. 'invoice.payment_failed')
 * @param context   - Identifiers known at time of failed resolution
 */
function captureUnmatchedEvent(
  eventType: string,
  context: {
    userId?: string | null;
    customerId?: string | null;
    email?: string | null;
    subscriptionId?: string | null;
  }
): void {
  Sentry.captureMessage(`[stripe/webhook] Unmatched ${eventType}`, {
    level: 'error',
    tags: { webhook_event: eventType },
    extra: {
      attempted_user_id: context.userId ?? null,
      attempted_customer_id: context.customerId ?? null,
      attempted_email: context.email ?? null,
      subscription_id: context.subscriptionId ?? null,
    },
  });
}

/**
 * Disable Next.js body parsing — Stripe signature verification
 * requires the raw request body as a buffer/string.
 */
export const runtime = 'nodejs';

/**
 * POST /api/stripe/webhook
 *
 * Receives Stripe events, verifies signature, and updates Supabase.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!stripe) {
    return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logger.error('[stripe/webhook] STRIPE_WEBHOOK_SECRET not configured');
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
  }

  // ── Read raw body for signature verification ──
  const rawBody = await req.text();
  const signature = req.headers.get('stripe-signature');

  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 });
  }

  // ── Verify signature ──
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error('[stripe/webhook] Signature verification failed:', message);
    return NextResponse.json(
      { error: `Webhook signature verification failed: ${message}` },
      { status: 400 }
    );
  }

  // ── Handle events ──
  const startMs = Date.now();
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;

      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;

      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      default:
        // Unhandled event — log but don't error
        logger.log(`[stripe/webhook] Unhandled event type: ${event.type}`);
    }

    // BIZZ-314: Log webhook processing time for monitoring
    const durationMs = Date.now() - startMs;
    writeAuditLog({
      action: 'stripe.webhook_processed',
      resource_type: 'webhook',
      resource_id: event.id,
      metadata: JSON.stringify({ type: event.type, durationMs }),
    });

    return NextResponse.json({ received: true });
  } catch (err) {
    // BIZZ-314: Log failed webhook processing
    writeAuditLog({
      action: 'stripe.webhook_failed',
      resource_type: 'webhook',
      resource_id: event.id,
      metadata: JSON.stringify({ type: event.type, error: String(err) }),
    });
    logger.error('[stripe/webhook] Error processing event:', err);
    return NextResponse.json({ error: 'Webhook handler failed' }, { status: 500 });
  }
}

// ─── Event handlers ─────────────────────────────────────────────────────────

/**
 * Handles checkout.session.completed — activates the subscription in Supabase.
 * Stores the Stripe customer ID and subscription details in app_metadata.
 *
 * @param session - The completed Stripe Checkout session
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  // ── Token top-up purchase (one-time) ──
  if (session.metadata?.type === 'token_topup') {
    await handleTokenTopUp(session);
    return;
  }

  // ── Subscription checkout ──
  const sessionUserId = session.metadata?.supabase_user_id ?? null;
  const sessionEmail = session.metadata?.user_email ?? null;
  const customerId = typeof session.customer === 'string' ? session.customer : null;
  const planId = session.metadata?.plan_id;

  if (!planId) {
    logger.error('[stripe/webhook] checkout.session.completed missing plan_id');
    captureUnmatchedEvent('checkout.session.completed', {
      userId: sessionUserId,
      customerId,
      email: sessionEmail,
    });
    return;
  }

  const admin = createAdminClient();

  // BIZZ-543: 3-step fallback — original userId may reference a deleted user
  const userId = await resolveUserId(admin, {
    userId: sessionUserId,
    customerId,
    email: sessionEmail,
  });

  if (!userId) {
    logger.error(
      '[stripe/webhook] checkout.session.completed — could not resolve user via id/customer/email'
    );
    captureUnmatchedEvent('checkout.session.completed', {
      userId: sessionUserId,
      customerId,
      email: sessionEmail,
    });
    return;
  }

  const now = new Date().toISOString();

  // Get existing app_metadata to merge with (userId is already verified above)
  const { data: existingUser } = await admin.auth.admin.getUserById(userId);
  const existingMeta = existingUser?.user?.app_metadata ?? {};

  const { error: updateErr } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: {
      ...existingMeta,
      stripe_customer_id: session.customer as string,
      stripe_subscription_id: session.subscription as string,
      subscription: {
        ...((existingMeta.subscription as Record<string, unknown>) ?? {}),
        planId,
        status: 'active',
        createdAt: now,
        approvedAt: now,
        tokensUsedThisMonth: 0,
        periodStart: now,
        isPaid: true,
      },
    },
  });

  if (updateErr) {
    // BIZZ-543: Previously this failure was silent. Surface it so activation
    // gaps are visible before a user complains about lost paid access.
    logger.error('[stripe/webhook] checkout.session.completed updateUserById failed', updateErr);
    Sentry.captureException(updateErr, {
      tags: { webhook_event: 'checkout.session.completed' },
      extra: { userId, planId },
    });
    return;
  }

  logger.log(`[stripe/webhook] Activated plan "${planId}" — ok`);
}

/**
 * Handles customer.subscription.updated — syncs plan/status changes.
 * Detects plan changes (up/downgrade) and status transitions.
 *
 * @param subscription - The updated Stripe subscription
 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  const metaUserId = subscription.metadata?.supabase_user_id ?? null;
  const metaEmail = subscription.metadata?.user_email ?? null;
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : ((subscription.customer as { id?: string })?.id ?? null);

  const admin = createAdminClient();

  // BIZZ-543: 3-step fallback. Previously, a stale supabase_user_id (e.g. after
  // a test-user re-creation) made updateUserById throw, which returned 500 and
  // trapped the event in Stripe's retry queue indefinitely. Now we try to
  // resolve via customer_id → email before giving up.
  const userId = await resolveUserId(admin, {
    userId: metaUserId,
    customerId,
    email: metaEmail,
  });

  if (!userId) {
    logger.error(
      '[stripe/webhook] subscription.updated — could not resolve user via id/customer/email'
    );
    captureUnmatchedEvent('customer.subscription.updated', {
      userId: metaUserId,
      customerId,
      email: metaEmail,
      subscriptionId: subscription.id,
    });
    // BIZZ-543: Consume the event so Stripe stops retrying. Sentry has the details.
    return;
  }

  const { data: existingUser } = await admin.auth.admin.getUserById(userId);
  const existingMeta = existingUser?.user?.app_metadata ?? {};
  const existingSub = (existingMeta.subscription as Record<string, unknown>) ?? {};

  // Determine status from Stripe subscription state.
  // BIZZ-541: `past_due` and `unpaid` are now distinct. `past_due` preserves
  // access during the grace window; `unpaid` means Stripe gave up retrying.
  let status: string;
  switch (subscription.status) {
    case 'active':
    case 'trialing':
      status = 'active';
      break;
    case 'past_due':
      status = 'past_due';
      break;
    case 'unpaid':
      status = 'payment_failed';
      break;
    case 'canceled':
      status = 'cancelled';
      break;
    default:
      status = subscription.status;
  }

  // Get current plan from subscription items
  const planId = subscription.metadata?.plan_id ?? existingSub.planId ?? 'basis';

  // BIZZ-541: When subscription transitions back to active, clear any stored
  // retry-countdown + grace-expiry fields so the warning banner disappears.
  const clearGraceFields = status === 'active' || status === 'cancelled';
  const subPayload: Record<string, unknown> = {
    ...existingSub,
    planId,
    status,
    periodStart: new Date(
      ((subscription as unknown as Record<string, unknown>).current_period_start as number) * 1000
    ).toISOString(),
  };
  if (clearGraceFields) {
    subPayload.nextPaymentAttempt = null;
    subPayload.graceExpiresAt = null;
  }

  const { error: updateErr } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: {
      ...existingMeta,
      subscription: subPayload,
    },
  });

  if (updateErr) {
    // BIZZ-543: Don't throw — that trips the outer try/catch and returns 500,
    // which Stripe then retries forever. Surface via Sentry and consume event.
    logger.error('[stripe/webhook] subscription.updated updateUserById failed', updateErr);
    Sentry.captureException(updateErr, {
      tags: { webhook_event: 'customer.subscription.updated' },
      extra: { userId, planId, status },
    });
    return;
  }

  logger.log(`[stripe/webhook] Updated subscription: plan=${planId}, status=${status}`);
}

/**
 * Handles customer.subscription.deleted — marks subscription as cancelled.
 *
 * @param subscription - The deleted Stripe subscription
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const metaUserId = subscription.metadata?.supabase_user_id ?? null;
  const metaEmail = subscription.metadata?.user_email ?? null;
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : ((subscription.customer as { id?: string })?.id ?? null);

  const admin = createAdminClient();

  // BIZZ-543: Same 3-step fallback as handleSubscriptionUpdated — a stale
  // supabase_user_id must not block cancellation sync.
  const userId = await resolveUserId(admin, {
    userId: metaUserId,
    customerId,
    email: metaEmail,
  });

  if (!userId) {
    logger.error(
      '[stripe/webhook] subscription.deleted — could not resolve user via id/customer/email'
    );
    captureUnmatchedEvent('customer.subscription.deleted', {
      userId: metaUserId,
      customerId,
      email: metaEmail,
      subscriptionId: subscription.id,
    });
    return;
  }

  const { data: existingUser } = await admin.auth.admin.getUserById(userId);
  const existingMeta = existingUser?.user?.app_metadata ?? {};
  const existingSub = (existingMeta.subscription as Record<string, unknown>) ?? {};

  const { error: updateErr } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: {
      ...existingMeta,
      stripe_subscription_id: null,
      subscription: {
        ...existingSub,
        status: 'cancelled',
      },
    },
  });

  if (updateErr) {
    logger.error('[stripe/webhook] subscription.deleted updateUserById failed', updateErr);
    Sentry.captureException(updateErr, {
      tags: { webhook_event: 'customer.subscription.deleted' },
      extra: { userId },
    });
    return;
  }

  logger.log(`[stripe/webhook] Cancelled subscription — ok`);
}

/**
 * Handles invoice.payment_succeeded — sends a payment confirmation email
 * for recurring subscription payments. Skips the first invoice (handled
 * by verify-session endpoint instead).
 *
 * Supports both the legacy `invoice.subscription` field and the newer Stripe API
 * path `invoice.parent.subscription_details.subscription`. If no subscription ID
 * is available at all, user lookup falls back directly to `invoice.customer_email`.
 *
 * @param invoice - The succeeded Stripe invoice
 */
async function handlePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
  // Log billing_reason so we can see exactly what Stripe sent
  const billingReason = (invoice as unknown as Record<string, unknown>).billing_reason;
  logger.log(
    `[stripe/webhook] invoice.payment_succeeded — billing_reason="${billingReason}" invoice_id="${invoice.id}"`
  );

  // Skip first invoice — checkout.session.completed + verify-session handles that
  if (billingReason === 'subscription_create') {
    logger.log(
      '[stripe/webhook] Skipping payment_succeeded for initial subscription invoice (billing_reason=subscription_create)'
    );
    return;
  }

  // Resolve subscription ID: try legacy `invoice.subscription` first, then the newer
  // `invoice.parent.subscription_details.subscription` path (Stripe API ≥ 2025-x).
  const rawSub = (invoice as unknown as Record<string, unknown>).subscription;
  const legacySubId: string | null =
    typeof rawSub === 'string' ? rawSub : ((rawSub as { id?: string } | null)?.id ?? null);

  const rawParent = (invoice as unknown as Record<string, unknown>).parent as
    | Record<string, unknown>
    | null
    | undefined;
  const subDetails = rawParent?.subscription_details as Record<string, unknown> | null | undefined;
  const parentSubId: string | null =
    typeof subDetails?.subscription === 'string' ? subDetails.subscription : null;

  const subscriptionId: string | null = legacySubId ?? parentSubId;

  logger.log(
    `[stripe/webhook] invoice.payment_succeeded — legacySubId=${!!legacySubId} parentSubId=${!!parentSubId} resolved=${!!subscriptionId}`
  );

  // Attempt to retrieve the Stripe subscription (needed for plan/period metadata).
  // If subscriptionId is null we skip this and rely on invoice + app_metadata instead.
  let sub: Stripe.Subscription | null = null;
  if (subscriptionId) {
    sub = await stripe!.subscriptions.retrieve(subscriptionId);
  }

  let userId = sub?.metadata?.supabase_user_id;

  logger.log(
    `[stripe/webhook] invoice.payment_succeeded — userId from sub.metadata=${userId ? 'found' : 'none'}`
  );

  const admin = createAdminClient();

  // Resolve userId via fallbacks when it is not stored in subscription metadata.
  // This covers: admin-assigned subscriptions, and the newer API where subscription is null.
  if (!userId) {
    // Fetch full user list once — reused across all fallback strategies below
    const { data: usersPage } = await admin.auth.admin.listUsers({ perPage: 1000 });

    // Fallback 1: match by invoice.customer_email (no extra API call required)
    const invoiceEmail = (invoice as unknown as Record<string, unknown>).customer_email as
      | string
      | null
      | undefined;
    if (invoiceEmail) {
      const emailMatch = usersPage?.users?.find((u) => u.email === invoiceEmail);
      if (emailMatch?.id) {
        userId = emailMatch.id;
        logger.log(`[stripe/webhook] invoice.payment_succeeded: resolved user via email fallback`);
      }
    }

    // Fallback 2: match by stripe_customer_id stored in app_metadata
    if (!userId) {
      const customerId = sub
        ? typeof sub.customer === 'string'
          ? sub.customer
          : (sub.customer as { id?: string })?.id
        : typeof invoice.customer === 'string'
          ? invoice.customer
          : null;

      if (customerId) {
        const match = usersPage?.users?.find(
          (u) => (u.app_metadata?.stripe_customer_id as string | undefined) === customerId
        );
        if (match?.id) {
          userId = match.id;
          logger.log(
            `[stripe/webhook] invoice.payment_succeeded: resolved user via stripe_customer_id`
          );
        }

        // Fallback 3: retrieve Stripe customer and match by email
        if (!userId) {
          const customer = await stripe!.customers.retrieve(customerId);
          if (customer && !customer.deleted && customer.email) {
            const emailMatch = usersPage?.users?.find((u) => u.email === customer.email);
            if (emailMatch?.id) {
              userId = emailMatch.id;
              logger.log(
                '[stripe/webhook] invoice.payment_succeeded: resolved user via customer email'
              );
            }
          }
        }
      }
    }

    if (!userId) {
      logger.error(
        '[stripe/webhook] invoice.payment_succeeded: could not resolve user from subscription metadata, customer ID, or email'
      );
      return;
    }
  }

  // Get user email from Supabase
  const { data: userData } = await admin.auth.admin.getUserById(userId);
  const userEmail = userData?.user?.email;
  if (!userEmail) {
    logger.error('[stripe/webhook] invoice.payment_succeeded: user has no email');
    return;
  }

  // Extract payment details from invoice
  const amountPaid = ((invoice as unknown as Record<string, unknown>).amount_paid as number) ?? 0;
  const priceDkk = Math.round(amountPaid / 100); // Stripe uses øre/cents

  // Derive planId and periodEnd from subscription when available; fall back to
  // app_metadata (plan) and invoice.period_end / +30 days (period end).
  let planId = 'basis';
  let periodEnd: Date;

  if (sub) {
    planId = sub.metadata?.plan_id ?? 'basis';
    periodEnd = new Date(
      ((sub as unknown as Record<string, unknown>).current_period_end as number) * 1000
    );
  } else {
    // No subscription object — derive from user's existing app_metadata
    const existingMeta = userData?.user?.app_metadata ?? {};
    const existingSub = (existingMeta.subscription as Record<string, unknown>) ?? {};
    planId = (existingSub.planId as string) ?? 'basis';

    // invoice.period_end is set on renewal invoices; fall back to 30 days from now
    const invoicePeriodEnd = (invoice as unknown as Record<string, unknown>).period_end as
      | number
      | null
      | undefined;
    periodEnd = invoicePeriodEnd
      ? new Date(invoicePeriodEnd * 1000)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  }

  logger.log(
    `[stripe/webhook] invoice.payment_succeeded — plan="${planId}" amount=${priceDkk}kr resend=${!!process.env.RESEND_API_KEY}`
  );

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bizzassist.dk';
  const cancelUrl = `${appUrl}/dashboard/settings`;

  // Resolve plan display name: check DB first, then hardcoded fallbacks, then raw plan ID
  const { data: planRow } = await admin
    .from('plan_configs')
    .select('name_da')
    .eq('plan_id', planId)
    .single();
  const hardcodedNames: Record<string, string> = {
    basis: 'Basis',
    professionel: 'Professionel',
    enterprise: 'Enterprise',
    demo: 'Demo',
  };
  const planName =
    (planRow as { name_da?: string } | null)?.name_da ?? hardcodedNames[planId] ?? planId;

  // Await email send so failures surface in logs and trigger Stripe retries (via 500 response)
  await sendRecurringPaymentEmail({
    to: userEmail,
    planName,
    priceDkk,
    periodEnd,
    cancelUrl,
  });

  logger.log(
    `[stripe/webhook] Recurring payment email dispatched — plan=${planId}, amount=${priceDkk} DKK`
  );
}

/**
 * Handles invoice.payment_failed — marks subscription as payment_failed.
 * The user should be prompted to update their payment method.
 *
 * @param invoice - The failed Stripe invoice
 */
async function handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  // Resolve subscription ID (legacy or newer API path)
  const rawSub = (invoice as unknown as Record<string, unknown>).subscription;
  const legacySubId: string | null =
    typeof rawSub === 'string' ? rawSub : ((rawSub as { id?: string } | null)?.id ?? null);
  const rawParent = (invoice as unknown as Record<string, unknown>).parent as
    | Record<string, unknown>
    | null
    | undefined;
  const subDetails = rawParent?.subscription_details as Record<string, unknown> | null | undefined;
  const parentSubId: string | null =
    typeof subDetails?.subscription === 'string' ? subDetails.subscription : null;
  const subscriptionId: string | null = legacySubId ?? parentSubId;

  // Gather any identifiers we can — we may need them for fallback even if
  // subscription retrieval fails.
  const invoiceCustomerId =
    typeof invoice.customer === 'string'
      ? invoice.customer
      : ((invoice.customer as { id?: string } | null)?.id ?? null);
  const invoiceEmail =
    ((invoice as unknown as Record<string, unknown>).customer_email as string | null | undefined) ??
    null;

  // Retrieve the subscription when possible — gives us metadata + customer.
  // If retrieval throws (e.g. deleted subscription), continue with invoice data.
  let sub: Stripe.Subscription | null = null;
  if (subscriptionId) {
    try {
      sub = await stripe!.subscriptions.retrieve(subscriptionId);
    } catch (err) {
      logger.error(
        `[stripe/webhook] invoice.payment_failed: subscriptions.retrieve(${subscriptionId}) failed`,
        err
      );
      Sentry.captureException(err, {
        tags: { webhook_event: 'invoice.payment_failed' },
        extra: { subscriptionId },
      });
    }
  }

  const metaUserId = sub?.metadata?.supabase_user_id ?? null;
  const metaEmail = sub?.metadata?.user_email ?? null;
  const subCustomerId = sub
    ? typeof sub.customer === 'string'
      ? sub.customer
      : ((sub.customer as { id?: string } | null)?.id ?? null)
    : null;

  const customerId = subCustomerId ?? invoiceCustomerId;
  const email = metaEmail ?? invoiceEmail;

  const admin = createAdminClient();

  // BIZZ-543: 3-step fallback — payment_failed used to silently drop when
  // subscription.metadata.supabase_user_id was missing or stale, leaving users
  // in `active` status with an unpaid card.
  const userId = await resolveUserId(admin, {
    userId: metaUserId,
    customerId,
    email,
  });

  if (!userId) {
    logger.error(
      '[stripe/webhook] invoice.payment_failed — could not resolve user via id/customer/email'
    );
    captureUnmatchedEvent('invoice.payment_failed', {
      userId: metaUserId,
      customerId,
      email,
      subscriptionId,
    });
    return;
  }

  const { data: existingUser } = await admin.auth.admin.getUserById(userId);
  const existingMeta = existingUser?.user?.app_metadata ?? {};
  const existingSub = (existingMeta.subscription as Record<string, unknown>) ?? {};

  // BIZZ-541: Look up the plan's grace window + display name in one query.
  // paymentGraceHours defaults to 0 — meaning a failed payment behaves
  // identically to "unpaid" for that plan (access revoked immediately).
  // Plans can opt in to a non-zero window via plan_configs.
  const invoiceRaw = invoice as unknown as Record<string, unknown>;
  const nextAttemptTs = invoiceRaw.next_payment_attempt as number | null | undefined;
  const planIdForGrace: string =
    sub?.metadata?.plan_id ?? (existingSub.planId as string | undefined) ?? 'basis';
  const { data: planRow } = await admin
    .from('plan_configs')
    .select('payment_grace_hours, name_da')
    .eq('plan_id', planIdForGrace)
    .single();
  const planRowTyped = planRow as { payment_grace_hours?: number; name_da?: string } | null;
  const planGraceHours = planRowTyped?.payment_grace_hours ?? 0;

  // Status: past_due only when Stripe will retry AND plan grants any grace.
  // Zero-grace plans go straight to payment_failed — same block as unpaid.
  const retryingStatus = nextAttemptTs && planGraceHours > 0 ? 'past_due' : 'payment_failed';

  // Grace expiry: keep existing if already set (don't reset on each retry),
  // otherwise start a fresh window at first failure sized to plan.
  const existingGrace = (existingSub.graceExpiresAt as string | undefined) ?? null;
  const graceExpiresAt =
    planGraceHours > 0
      ? (existingGrace ?? new Date(Date.now() + planGraceHours * 60 * 60 * 1000).toISOString())
      : null;

  const { error: updateErr } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: {
      ...existingMeta,
      subscription: {
        ...existingSub,
        status: retryingStatus,
        nextPaymentAttempt: nextAttemptTs ? new Date(nextAttemptTs * 1000).toISOString() : null,
        graceExpiresAt,
      },
    },
  });

  if (updateErr) {
    logger.error('[stripe/webhook] invoice.payment_failed updateUserById failed', updateErr);
    Sentry.captureException(updateErr, {
      tags: { webhook_event: 'invoice.payment_failed' },
      extra: { userId, subscriptionId },
    });
    return;
  }

  logger.log(
    `[stripe/webhook] Payment failed — subscription marked ${retryingStatus} (nextAttempt=${nextAttemptTs ? new Date(nextAttemptTs * 1000).toISOString() : 'none'})`
  );

  // ── BIZZ-540: Notify user by email ────────────────────────────────────────
  // Fire-and-forget — wrapped in try/catch so an email failure never breaks
  // the webhook-handler contract (must return 2xx to Stripe).
  const recipientEmail = existingUser?.user?.email ?? null;
  if (recipientEmail) {
    // invoiceRaw already declared above (BIZZ-541 status block) — reuse it
    const amountDueOre =
      (invoiceRaw.amount_due as number) ?? (invoiceRaw.amount_remaining as number) ?? 0;
    const amountDueDkk = Math.round(amountDueOre / 100);
    const nextRetryAt = nextAttemptTs ? new Date(nextAttemptTs * 1000) : null;
    const attemptCount = (invoiceRaw.attempt_count as number | null | undefined) ?? null;

    // Best-effort decline reason from Stripe. `last_finalization_error` exists
    // on invoices that failed to finalize. We do not retrieve the charge here
    // to avoid an extra Stripe API call in the hot path — an empty reason is
    // acceptable and the email omits the row when absent.
    const lastErr = invoiceRaw.last_finalization_error as
      | Record<string, unknown>
      | null
      | undefined;
    const failureReason = (lastErr?.message as string | undefined) ?? null;

    // Resolve plan display name — reuse the planRowTyped from the grace
    // lookup above (BIZZ-541) so we don't round-trip to plan_configs twice.
    const hardcodedNames: Record<string, string> = {
      basis: 'Basis',
      professionel: 'Professionel',
      enterprise: 'Enterprise',
      demo: 'Demo',
    };
    const planName = planRowTyped?.name_da ?? hardcodedNames[planIdForGrace] ?? planIdForGrace;

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bizzassist.dk';
    const updateUrl = `${appUrl}/dashboard/settings?tab=abonnement`;

    try {
      await sendPaymentFailedEmail({
        to: recipientEmail,
        planName,
        amountDueDkk,
        failureReason,
        nextRetryAt,
        updateUrl,
        attemptCount,
      });

      // BIZZ-540 AC: audit_log entry with user_id + event_type.
      // Do NOT include the email address — only user_id — per GDPR / ISO 27001.
      writeAuditLog({
        action: 'payment_failed_email_sent',
        resource_type: 'user',
        resource_id: userId,
        metadata: JSON.stringify({
          subscriptionId,
          planId: planIdForGrace,
          amountDueDkk,
          attemptCount,
        }),
      });
    } catch (err) {
      logger.error('[stripe/webhook] payment_failed email dispatch error:', err);
      Sentry.captureException(err, {
        tags: { webhook_event: 'invoice.payment_failed', step: 'email_dispatch' },
        extra: { userId, subscriptionId },
      });
    }
  } else {
    logger.warn(
      '[stripe/webhook] invoice.payment_failed — no email on user, skipping notification'
    );
  }
}

/**
 * Handles token top-up purchase — adds purchased tokens to user's account.
 *
 * @param session - Completed Stripe Checkout session with token_topup metadata
 */
async function handleTokenTopUp(session: Stripe.Checkout.Session): Promise<void> {
  const userId = session.metadata?.supabase_user_id;
  const tokenAmount = parseInt(session.metadata?.token_amount ?? '0', 10);

  if (!userId || tokenAmount <= 0) {
    logger.error('[stripe/webhook] token_topup missing metadata', {
      hasUserId: !!userId,
      tokenAmount,
    });
    return;
  }

  const admin = createAdminClient();
  const { data: existingUser } = await admin.auth.admin.getUserById(userId);
  const existingMeta = existingUser?.user?.app_metadata ?? {};
  const existingSub = (existingMeta.subscription as Record<string, unknown>) ?? {};
  const currentTopUp = (existingSub.topUpTokens as number) ?? 0;

  await admin.auth.admin.updateUserById(userId, {
    app_metadata: {
      ...existingMeta,
      subscription: {
        ...existingSub,
        topUpTokens: currentTopUp + tokenAmount,
      },
    },
  });

  logger.log(
    `[stripe/webhook] Added ${tokenAmount} top-up tokens (total: ${currentTopUp + tokenAmount})`
  );
}
