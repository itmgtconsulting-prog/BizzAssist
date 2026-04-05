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
import { stripe } from '@/app/lib/stripe';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendRecurringPaymentEmail } from '@/app/lib/email';

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
    console.error('[stripe/webhook] STRIPE_WEBHOOK_SECRET not configured');
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
    console.error('[stripe/webhook] Signature verification failed:', message);
    return NextResponse.json(
      { error: `Webhook signature verification failed: ${message}` },
      { status: 400 }
    );
  }

  // ── Handle events ──
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
        console.log(`[stripe/webhook] Unhandled event type: ${event.type}`);
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error('[stripe/webhook] Error processing event:', err);
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
  const userId = session.metadata?.supabase_user_id;
  const planId = session.metadata?.plan_id;

  if (!userId || !planId) {
    console.error('[stripe/webhook] checkout.session.completed missing metadata:', {
      userId,
      planId,
    });
    return;
  }

  const admin = createAdminClient();
  const now = new Date().toISOString();

  // Get existing app_metadata to merge with
  const { data: existingUser } = await admin.auth.admin.getUserById(userId);
  const existingMeta = existingUser?.user?.app_metadata ?? {};

  await admin.auth.admin.updateUserById(userId, {
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

  console.log(`[stripe/webhook] Activated plan "${planId}" for user ${userId}`);
}

/**
 * Handles customer.subscription.updated — syncs plan/status changes.
 * Detects plan changes (up/downgrade) and status transitions.
 *
 * @param subscription - The updated Stripe subscription
 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  const userId = subscription.metadata?.supabase_user_id;
  if (!userId) {
    console.error('[stripe/webhook] subscription.updated missing supabase_user_id in metadata');
    return;
  }

  const admin = createAdminClient();
  const { data: existingUser } = await admin.auth.admin.getUserById(userId);
  const existingMeta = existingUser?.user?.app_metadata ?? {};
  const existingSub = (existingMeta.subscription as Record<string, unknown>) ?? {};

  // Determine status from Stripe subscription state
  let status: string;
  switch (subscription.status) {
    case 'active':
    case 'trialing':
      status = 'active';
      break;
    case 'past_due':
      status = 'payment_failed';
      break;
    case 'canceled':
    case 'unpaid':
      status = 'cancelled';
      break;
    default:
      status = subscription.status;
  }

  // Get current plan from subscription items
  const planId = subscription.metadata?.plan_id ?? existingSub.planId ?? 'basis';

  await admin.auth.admin.updateUserById(userId, {
    app_metadata: {
      ...existingMeta,
      subscription: {
        ...existingSub,
        planId,
        status,
        periodStart: new Date(
          ((subscription as unknown as Record<string, unknown>).current_period_start as number) *
            1000
        ).toISOString(),
      },
    },
  });

  console.log(
    `[stripe/webhook] Updated subscription for user ${userId}: plan=${planId}, status=${status}`
  );
}

/**
 * Handles customer.subscription.deleted — marks subscription as cancelled.
 *
 * @param subscription - The deleted Stripe subscription
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const userId = subscription.metadata?.supabase_user_id;
  if (!userId) {
    console.error('[stripe/webhook] subscription.deleted missing supabase_user_id in metadata');
    return;
  }

  const admin = createAdminClient();
  const { data: existingUser } = await admin.auth.admin.getUserById(userId);
  const existingMeta = existingUser?.user?.app_metadata ?? {};
  const existingSub = (existingMeta.subscription as Record<string, unknown>) ?? {};

  await admin.auth.admin.updateUserById(userId, {
    app_metadata: {
      ...existingMeta,
      stripe_subscription_id: null,
      subscription: {
        ...existingSub,
        status: 'cancelled',
      },
    },
  });

  console.log(`[stripe/webhook] Cancelled subscription for user ${userId}`);
}

/**
 * Handles invoice.payment_succeeded — sends a payment confirmation email
 * for recurring subscription payments. Skips the first invoice (handled
 * by verify-session endpoint instead).
 *
 * @param invoice - The succeeded Stripe invoice
 */
async function handlePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
  // Log billing_reason so we can see exactly what Stripe sent
  const billingReason = (invoice as unknown as Record<string, unknown>).billing_reason;
  console.log(
    `[stripe/webhook] invoice.payment_succeeded — billing_reason="${billingReason}" invoice_id="${invoice.id}"`
  );

  // Skip first invoice — checkout.session.completed + verify-session handles that
  if (billingReason === 'subscription_create') {
    console.log(
      '[stripe/webhook] Skipping payment_succeeded for initial subscription invoice (billing_reason=subscription_create)'
    );
    return;
  }

  const rawSub = (invoice as unknown as Record<string, unknown>).subscription;
  const subscriptionId =
    typeof rawSub === 'string' ? rawSub : ((rawSub as { id?: string } | null)?.id ?? null);

  console.log(`[stripe/webhook] invoice.payment_succeeded — subscriptionId="${subscriptionId}"`);

  if (!subscriptionId) {
    console.log(
      '[stripe/webhook] invoice.payment_succeeded missing subscription ID — skipping email'
    );
    return;
  }

  // Get subscription to find user ID and plan
  const sub = await stripe!.subscriptions.retrieve(subscriptionId);
  let userId = sub.metadata?.supabase_user_id;

  console.log(
    `[stripe/webhook] invoice.payment_succeeded — userId from sub.metadata="${userId ?? 'none'}"`
  );

  const admin = createAdminClient();

  // Fallback: look up user by Stripe customer ID or email if metadata is missing.
  // This handles subscriptions assigned via admin panel (not through checkout flow).
  if (!userId) {
    const customerId =
      typeof sub.customer === 'string' ? sub.customer : (sub.customer as { id?: string })?.id;

    console.log(
      `[stripe/webhook] invoice.payment_succeeded — no userId in metadata, trying fallbacks. customerId="${customerId}"`
    );

    // Fetch full user list once — reused for both fallback strategies
    const { data: usersPage } = await admin.auth.admin.listUsers({ perPage: 1000 });

    // Fallback 2: match by stripe_customer_id stored in app_metadata
    if (customerId) {
      const match = usersPage?.users?.find(
        (u) => (u.app_metadata?.stripe_customer_id as string | undefined) === customerId
      );
      if (match?.id) {
        userId = match.id;
        console.log(
          `[stripe/webhook] invoice.payment_succeeded: resolved user ${userId} via Stripe customer ID fallback`
        );
      }
    }

    // Fallback 3: match by invoice.customer_email (directly on invoice — no extra API call)
    if (!userId) {
      const invoiceEmail = (invoice as unknown as Record<string, unknown>).customer_email as
        | string
        | null
        | undefined;
      console.log(
        `[stripe/webhook] invoice.payment_succeeded — trying email fallback, invoiceEmail="${invoiceEmail}"`
      );
      if (invoiceEmail) {
        const emailMatch = usersPage?.users?.find((u) => u.email === invoiceEmail);
        if (emailMatch?.id) {
          userId = emailMatch.id;
          console.log(
            `[stripe/webhook] invoice.payment_succeeded: resolved user ${userId} via invoice.customer_email (${invoiceEmail})`
          );
        }
      }
    }

    // Fallback 4: retrieve Stripe customer and match by email (covers cases where
    // invoice.customer_email differs from the subscription customer email)
    if (!userId && invoice.customer) {
      const customer = await stripe!.customers.retrieve(invoice.customer as string);
      if (customer && !customer.deleted && customer.email) {
        const emailMatch = usersPage?.users?.find((u) => u.email === customer.email);
        if (emailMatch?.id) {
          userId = emailMatch.id;
          console.log(
            '[stripe/webhook] Found user via Stripe customer email match:',
            customer.email
          );
        }
      }
    }

    if (!userId) {
      console.error(
        '[stripe/webhook] invoice.payment_succeeded: could not resolve user from subscription metadata, customer ID, or email'
      );
      return;
    }
  }

  // Get user email from Supabase
  const { data: userData } = await admin.auth.admin.getUserById(userId);
  const userEmail = userData?.user?.email;
  console.log(`[stripe/webhook] invoice.payment_succeeded — userEmail found="${!!userEmail}"`);
  if (!userEmail) {
    console.error('[stripe/webhook] invoice.payment_succeeded: user has no email');
    return;
  }

  // Extract payment details from invoice
  const amountPaid = ((invoice as unknown as Record<string, unknown>).amount_paid as number) ?? 0;
  const priceDkk = Math.round(amountPaid / 100); // Stripe uses øre/cents
  const planId = sub.metadata?.plan_id ?? 'basis';
  const periodEnd = new Date(
    ((sub as unknown as Record<string, unknown>).current_period_end as number) * 1000
  );

  console.log(
    `[stripe/webhook] invoice.payment_succeeded — planId="${planId}" priceDkk=${priceDkk} RESEND_API_KEY_SET=${!!process.env.RESEND_API_KEY}`
  );

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.bizzassist.dk';
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

  console.log(
    `[stripe/webhook] Recurring payment email dispatched for user ${userId} (plan=${planId}, amount=${priceDkk} DKK)`
  );
}

/**
 * Handles invoice.payment_failed — marks subscription as payment_failed.
 * The user should be prompted to update their payment method.
 *
 * @param invoice - The failed Stripe invoice
 */
async function handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  // Get the subscription to find the user ID
  const rawSub = (invoice as unknown as Record<string, unknown>).subscription;
  const subscriptionId =
    typeof rawSub === 'string' ? rawSub : ((rawSub as { id?: string } | null)?.id ?? null);

  if (!subscriptionId) {
    console.error('[stripe/webhook] invoice.payment_failed missing subscription ID');
    return;
  }

  const sub = await stripe!.subscriptions.retrieve(subscriptionId);
  const userId = sub.metadata?.supabase_user_id;
  if (!userId) {
    console.error('[stripe/webhook] invoice.payment_failed: subscription missing supabase_user_id');
    return;
  }

  const admin = createAdminClient();
  const { data: existingUser } = await admin.auth.admin.getUserById(userId);
  const existingMeta = existingUser?.user?.app_metadata ?? {};
  const existingSub = (existingMeta.subscription as Record<string, unknown>) ?? {};

  await admin.auth.admin.updateUserById(userId, {
    app_metadata: {
      ...existingMeta,
      subscription: {
        ...existingSub,
        status: 'payment_failed',
      },
    },
  });

  console.log(`[stripe/webhook] Payment failed for user ${userId}`);
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
    console.error('[stripe/webhook] token_topup missing metadata:', {
      userId,
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

  console.log(
    `[stripe/webhook] Added ${tokenAmount} top-up tokens for user ${userId} (total: ${currentTopUp + tokenAmount})`
  );
}
