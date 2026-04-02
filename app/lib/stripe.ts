/**
 * Stripe server-side client — app/lib/stripe.ts
 *
 * Initializes the Stripe SDK for server-side use in API routes.
 * Uses STRIPE_SECRET_KEY from environment variables.
 *
 * RESTRICTED — SERVER-SIDE ONLY. Never import in Client Components.
 *
 * @see /api/stripe/create-checkout — Checkout session creation
 * @see /api/stripe/webhook — Webhook event handler
 * @see /api/stripe/portal — Customer portal session
 */

import Stripe from 'stripe';

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error(
    'STRIPE_SECRET_KEY is not set. ' +
      'Add it to .env.local (never commit this value). ' +
      'Get it from: https://dashboard.stripe.com/apikeys'
  );
}

/**
 * Singleton Stripe server client.
 * Uses API version 2025-04-30 for latest features.
 */
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  typescript: true,
});

/**
 * Resolve the Stripe Price ID for a BizzAssist plan.
 * Prefers the DB-stored stripe_price_id (from plan_configs table),
 * then falls back to legacy environment variables.
 *
 * @param planId - The BizzAssist plan identifier
 * @param dbStripePriceId - Optional Stripe Price ID from the plan_configs DB table
 * @returns The Stripe Price ID, or null if not configured or demo plan
 */
export function getStripePriceId(planId: string, dbStripePriceId?: string | null): string | null {
  // Prefer DB value if available
  if (dbStripePriceId) return dbStripePriceId;

  // Fall back to legacy env vars for hardcoded plans
  switch (planId) {
    case 'basis':
      return process.env.STRIPE_PRICE_BASIS ?? null;
    case 'professionel':
      return process.env.STRIPE_PRICE_PROFESSIONEL ?? null;
    case 'enterprise':
      return process.env.STRIPE_PRICE_ENTERPRISE ?? null;
    default:
      return null;
  }
}
