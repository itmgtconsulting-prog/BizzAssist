/**
 * Stripe session verification — POST /api/stripe/verify-session
 *
 * After a successful Stripe Checkout redirect, this endpoint verifies the
 * session and sets isPaid: true on the user's subscription in app_metadata.
 * This handles the case where the webhook hasn't fired yet (e.g. localhost).
 *
 * @param req - JSON body with { sessionId: string }
 * @returns JSON with { ok: true } or error
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { stripe } from '@/app/lib/stripe';
import { resolvePlan } from '@/app/lib/subscriptions';
import { sendPaymentConfirmationEmail } from '@/app/lib/email';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // 1. Authenticate
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Get session ID from body
    const { sessionId } = await req.json();
    if (!sessionId || typeof sessionId !== 'string') {
      return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
    }

    // 3. Verify with Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return NextResponse.json({ error: 'Payment not completed' }, { status: 400 });
    }

    // Verify the session belongs to this user
    const sessionUserId = session.metadata?.supabase_user_id;
    if (sessionUserId !== user.id) {
      return NextResponse.json({ error: 'Session does not match user' }, { status: 403 });
    }

    // 4. Update app_metadata: set isPaid and store stripe_customer_id
    const admin = createAdminClient();
    const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
    const metadata = freshUser?.user?.app_metadata ?? {};
    const currentSub = (metadata.subscription as Record<string, unknown>) ?? {};
    const planId = session.metadata?.plan_id ?? currentSub.planId;

    const stripeCustomerId =
      typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? null);

    await admin.auth.admin.updateUserById(user.id, {
      app_metadata: {
        ...metadata,
        stripe_customer_id: stripeCustomerId ?? metadata.stripe_customer_id,
        subscription: {
          ...currentSub,
          planId,
          status: 'active',
          isPaid: true,
          approvedAt: currentSub.approvedAt ?? new Date().toISOString(),
        },
      },
    });

    // 5. Increment sales_count for the purchased plan (best-effort)
    if (planId) {
      try {
        const { data: planRow } = (await admin
          .from('plan_configs')
          .select('sales_count')
          .eq('plan_id', planId as string)
          .single()) as { data: { sales_count: number } | null };
        const currentCount = planRow?.sales_count ?? 0;
        await admin
          .from('plan_configs')
          .update({ sales_count: currentCount + 1 } as never)
          .eq('plan_id', planId as string);
      } catch (countErr) {
        console.error('[stripe/verify-session] Failed to increment sales_count:', countErr);
      }
    }

    // 6. Send payment confirmation email (best-effort, non-blocking)
    try {
      const subscriptionId =
        typeof session.subscription === 'string'
          ? session.subscription
          : (session.subscription?.id ?? null);

      let periodEnd: Date | null = null;
      if (subscriptionId) {
        const stripeSub = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ['items.data'],
        });
        // In Stripe v21+, current_period_end lives on subscription items
        const firstItem = stripeSub.items?.data?.[0];
        if (firstItem?.current_period_end) {
          periodEnd = new Date(firstItem.current_period_end * 1000);
        }
      }

      const plan = resolvePlan(String(planId ?? 'demo'));
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const cancelUrl = `${appUrl}/dashboard/settings?tab=abonnement`;

      if (user.email) {
        // Fire-and-forget — do not block the response
        sendPaymentConfirmationEmail({
          to: user.email,
          planName: `${plan.nameDa} / ${plan.nameEn}`,
          priceDkk: plan.priceDkk,
          periodEnd: periodEnd ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          cancelUrl,
        }).catch((emailErr) => {
          console.error('[stripe/verify-session] Email send error:', emailErr);
        });
      }
    } catch (emailErr) {
      // Email failure should never block payment verification
      console.error('[stripe/verify-session] Email setup error:', emailErr);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[stripe/verify-session] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
