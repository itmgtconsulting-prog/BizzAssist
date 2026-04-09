/**
 * Stripe Checkout session creation — POST /api/stripe/create-checkout
 *
 * Creates a Stripe Checkout session for upgrading to a paid plan.
 * Accepts { planId } in the request body, maps it to a Stripe price ID,
 * and returns a redirect URL to the hosted Stripe Checkout page.
 *
 * Flow:
 *   1. Authenticate the user via Supabase JWT
 *   2. Validate the plan ID and look up the Stripe price
 *   3. Check if the user already has a Stripe customer ID (from app_metadata)
 *   4. Create a Stripe Checkout session in subscription mode
 *   5. Return the session URL for client-side redirect
 *
 * @see /api/stripe/webhook — handles the checkout.session.completed event
 */

import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { stripe, getStripePriceId } from '@/app/lib/stripe';
import { resolvePlan, type PlanId } from '@/app/lib/subscriptions';

/**
 * POST /api/stripe/create-checkout
 *
 * @param req - JSON body with { planId: PlanId }
 * @returns JSON with { url: string } (Stripe Checkout URL) or error
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!stripe) {
    return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 });
  }

  try {
    // ── 1. Authenticate ──
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // ── 2. Parse and validate plan ──
    const body = await req.json();
    const planId = body.planId as PlanId;

    if (!planId) {
      return NextResponse.json({ error: 'Invalid plan ID' }, { status: 400 });
    }

    const admin = createAdminClient();

    // Fetch plan config from DB first, fall back to hardcoded resolvePlan()
    const { data: planRow } = (await admin
      .from('plan_configs')
      .select('price_dkk, stripe_price_id, max_sales, sales_count')
      .eq('plan_id', planId)
      .single()) as {
      data: {
        price_dkk: number;
        stripe_price_id: string | null;
        max_sales: number | null;
        sales_count: number;
      } | null;
    };

    // ── 2b. Check if plan is sold out ──
    if (planRow?.max_sales != null && planRow.sales_count >= planRow.max_sales) {
      return NextResponse.json({ error: 'This plan is sold out' }, { status: 400 });
    }

    const priceDkk = planRow?.price_dkk ?? resolvePlan(planId).priceDkk;

    if (priceDkk === 0) {
      return NextResponse.json({ error: 'This plan does not require payment' }, { status: 400 });
    }

    // Look up Stripe price: DB first, then env var fallback for legacy plans
    const priceId = getStripePriceId(planId, planRow?.stripe_price_id);

    if (!priceId) {
      return NextResponse.json(
        { error: `Stripe price not configured for plan: ${planId}` },
        { status: 500 }
      );
    }

    // ── 3. Get or reuse Stripe customer ID ──
    const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
    const existingCustomerId =
      (freshUser?.user?.app_metadata?.stripe_customer_id as string) ?? null;

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

    // ── 4. Create Checkout session ──
    const sessionConfig: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      currency: 'dkk',
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${appUrl}/dashboard/settings?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/dashboard/settings?payment=cancelled`,
      metadata: {
        supabase_user_id: user.id,
        user_email: user.email ?? '',
        plan_id: planId,
      },
      subscription_data: {
        metadata: {
          supabase_user_id: user.id,
          user_email: user.email ?? '',
          plan_id: planId,
        },
      },
    };

    // Reuse existing Stripe customer if available, otherwise pre-fill email
    if (existingCustomerId) {
      sessionConfig.customer = existingCustomerId;
    } else {
      sessionConfig.customer_email = user.email ?? undefined;
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);

    if (!session.url) {
      return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 });
    }

    // Audit log — fire-and-forget (ISO 27001 A.12.4)
    Promise.resolve()
      .then(() =>
        admin.from('audit_log').insert({
          action: 'stripe.checkout.create',
          resource_type: 'checkout_session',
          resource_id: session.id,
          metadata: JSON.stringify({ userId: user.id, planId }),
        })
      )
      .catch(() => {});

    // ── 5. Return checkout URL ──
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error('[stripe/create-checkout] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
