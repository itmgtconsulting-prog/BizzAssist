/**
 * Stripe subscription cancellation — POST /api/stripe/cancel-subscription
 *
 * Cancels the authenticated user's active Stripe subscription at the end
 * of the current billing period (i.e. the user retains access until period end).
 *
 * Flow:
 *   1. Authenticate the user via Supabase JWT
 *   2. Retrieve the user's stripe_customer_id from app_metadata
 *   3. List active subscriptions for the Stripe customer
 *   4. Cancel the subscription at period end (cancel_at_period_end = true)
 *   5. Update app_metadata to reflect the pending cancellation
 *
 * @returns JSON with { ok: true, cancelAt: string } or error
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { stripe } from '@/app/lib/stripe';
import { logger } from '@/app/lib/logger';

export async function POST(_req: NextRequest): Promise<NextResponse> {
  if (!stripe) {
    return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 });
  }

  try {
    // 1. Authenticate
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Get stripe_customer_id from app_metadata
    const admin = createAdminClient();
    const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
    const metadata = freshUser?.user?.app_metadata ?? {};
    const stripeCustomerId = metadata.stripe_customer_id as string | undefined;

    if (!stripeCustomerId) {
      return NextResponse.json(
        { error: 'No Stripe customer found. Cannot cancel.' },
        { status: 400 }
      );
    }

    // 3. List active subscriptions for this customer
    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: 'active',
      limit: 10,
    });

    if (subscriptions.data.length === 0) {
      return NextResponse.json({ error: 'No active subscription found.' }, { status: 400 });
    }

    // 4. Cancel the first active subscription at period end
    const activeSub = subscriptions.data[0];
    const cancelled = await stripe.subscriptions.update(activeSub.id, {
      cancel_at_period_end: true,
    });

    // In Stripe v21+, current_period_end lives on subscription items
    const firstItem = cancelled.items?.data?.[0];
    const periodEndUnix = firstItem?.current_period_end ?? 0;
    const cancelAt = periodEndUnix
      ? new Date(periodEndUnix * 1000).toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // 5. Update app_metadata to reflect cancellation
    const currentSub = (metadata.subscription as Record<string, unknown>) ?? {};
    await admin.auth.admin.updateUserById(user.id, {
      app_metadata: {
        ...metadata,
        subscription: {
          ...currentSub,
          cancelAtPeriodEnd: true,
          cancelAt,
        },
      },
    });

    // Audit log — fire-and-forget (ISO 27001 A.12.4)
    void admin.from('audit_log').insert({
      action: 'stripe.subscription.cancel',
      resource_type: 'subscription',
      resource_id: activeSub.id,
      metadata: JSON.stringify({
        userId: user.id,
        stripeCustomerId,
        cancelAt,
      }),
    });

    return NextResponse.json({ ok: true, cancelAt });
  } catch (err) {
    logger.error('[stripe/cancel-subscription] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
