/**
 * Stripe token top-up checkout — POST /api/stripe/create-topup-checkout
 *
 * Creates a one-time Stripe Checkout session for purchasing extra AI tokens.
 * On successful payment, the webhook handler adds tokens to the user's account.
 *
 * Body: { packId: string }
 *
 * @see app/api/stripe/webhook/route.ts — handles checkout.session.completed
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseBody } from '@/app/lib/validate';
import Stripe from 'stripe';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { stripe } from '@/app/lib/stripe';
import { logger } from '@/app/lib/logger';
import { writeAuditLog } from '@/app/lib/auditLog';

/** Row shape from token_packs table. */
interface TokenPackRow {
  id: string;
  name_en: string;
  token_amount: number;
  price_dkk: number;
  stripe_price_id: string | null;
  is_active: boolean;
}

/**
 * POST /api/stripe/create-topup-checkout — create one-time checkout for token pack.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!stripe) {
    return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 });
  }

  try {
    // Authenticate user
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const parsed = await parseBody(req, z.object({ packId: z.string().min(1, 'packId required') }));
    if (!parsed.success) return parsed.response;
    const { packId } = parsed.data;

    // Look up the token pack
    const admin = createAdminClient();
    const { data: packRows } = (await admin
      .from('token_packs')
      .select('id, name_en, token_amount, price_dkk, stripe_price_id, is_active')
      .eq('id', packId)
      .limit(1)) as { data: TokenPackRow[] | null; error: unknown };

    const pack = packRows?.[0];
    if (!pack || !pack.is_active) {
      return NextResponse.json({ error: 'Token pack not found or inactive' }, { status: 404 });
    }

    // Get existing Stripe customer ID if available
    const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
    const stripeCustomerId = freshUser?.user?.app_metadata?.stripe_customer_id as
      | string
      | undefined;

    // Build Stripe checkout session
    // BIZZ-429: Use NEXT_PUBLIC_APP_URL with request origin fallback (never localhost in prod)
    const origin =
      process.env.NEXT_PUBLIC_APP_URL || req.headers.get('origin') || 'http://localhost:3000';

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      currency: 'dkk',
      line_items: pack.stripe_price_id
        ? [{ price: pack.stripe_price_id, quantity: 1 }]
        : [
            {
              price_data: {
                currency: 'dkk',
                unit_amount: pack.price_dkk * 100, // Stripe uses cents (øre)
                product_data: {
                  name: `BizzAssist — ${pack.name_en} (${pack.token_amount.toLocaleString()} tokens)`,
                },
              },
              quantity: 1,
            },
          ],
      metadata: {
        type: 'token_topup',
        supabase_user_id: user.id,
        user_email: user.email ?? '',
        pack_id: pack.id,
        token_amount: String(pack.token_amount),
      },
      success_url: `${origin}/dashboard/tokens?payment=success`,
      cancel_url: `${origin}/dashboard/tokens?payment=cancelled`,
      ...(stripeCustomerId
        ? { customer: stripeCustomerId }
        : { customer_email: user.email ?? undefined }),
    };

    const session = await stripe.checkout.sessions.create(sessionParams);

    writeAuditLog({
      action: 'stripe.topup_checkout',
      resource_type: 'payment',
      resource_id: session.id ?? 'unknown',
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    logger.error('[stripe/create-topup-checkout] Error:', err);
    return NextResponse.json({ error: 'Failed to create checkout' }, { status: 500 });
  }
}
