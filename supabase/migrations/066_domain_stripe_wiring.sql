-- BIZZ-720: Wire the domain entity into the Stripe subscription lifecycle.
--
-- 1) Add stripe_customer_id + stripe_subscription_id to the domain table so
--    the webhook handlers can look up which domain a Stripe event pertains
--    to without going through app_metadata joins.
-- 2) Insert an `enterprise_domain` plan row into plan_configs so the webhook
--    can resolve limits (ai_tokens_per_month) from the same source of truth
--    used for tenant plans. Price + token allowance intentionally match the
--    defaults in domain.limits so existing domains keep their current cap.

ALTER TABLE public.domain
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

-- Lookup index used by syncDomainSubscription — typically 1-10 rows per
-- tenant so a btree is sufficient.
CREATE INDEX IF NOT EXISTS ix_domain_stripe_customer
  ON public.domain (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_domain_stripe_subscription
  ON public.domain (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- Seed enterprise_domain plan row. Price is indicative (4999 DKK/month per
-- docs/security/DOMAIN_SECURITY.md GA prep); Stripe product/price IDs remain
-- in Stripe Dashboard and are linked via checkout session metadata.
INSERT INTO public.plan_configs (
  plan_id, price_dkk, ai_tokens_per_month, duration_months,
  token_accumulation_cap_multiplier, ai_enabled, requires_approval
) VALUES (
  'enterprise_domain', 4999, 500000, 1, 1.0, true, true
) ON CONFLICT (plan_id) DO NOTHING;
