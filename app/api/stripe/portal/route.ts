/**
 * Stripe Customer Portal — POST /api/stripe/portal
 *
 * Creates a Stripe Customer Portal session so authenticated users can
 * manage their subscription, update payment methods, and view invoices.
 *
 * Flow:
 *   1. Authenticate the user via Supabase JWT
 *   2. Look up their Stripe customer ID from app_metadata
 *   3. Create a Stripe portal session with a return URL
 *   4. Return the portal URL for client-side redirect
 *
 * @see https://stripe.com/docs/customer-management/integrate-customer-portal
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { stripe } from '@/app/lib/stripe';

/**
 * POST /api/stripe/portal
 *
 * @returns JSON with { url: string } (Stripe Portal URL) or error
 */
export async function POST(): Promise<NextResponse> {
  try {
    // ── 1. Authenticate ──
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // ── 2. Get Stripe customer ID from Supabase app_metadata ──
    const admin = createAdminClient();
    const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
    const stripeCustomerId = (freshUser?.user?.app_metadata?.stripe_customer_id as string) ?? null;

    if (!stripeCustomerId) {
      return NextResponse.json(
        { error: 'No Stripe customer found. You need an active subscription first.' },
        { status: 400 }
      );
    }

    // ── 3. Create portal session ──
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${appUrl}/dashboard/settings?tab=abonnement`,
    });

    // ── 4. Return portal URL ──
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error('[stripe/portal] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
