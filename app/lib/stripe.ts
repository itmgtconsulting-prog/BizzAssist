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

/**
 * Singleton Stripe server client.
 * Returns null if STRIPE_SECRET_KEY is not configured — Stripe-routes
 * should check for null and return 503 gracefully.
 */
export const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { typescript: true })
  : null;

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
