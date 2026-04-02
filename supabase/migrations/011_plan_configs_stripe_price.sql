-- 011: Add stripe_price_id to plan_configs
-- Allows admin to configure Stripe price IDs for custom plans.
-- For legacy plans, env vars (STRIPE_PRICE_*) take precedence if set.

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS stripe_price_id text DEFAULT NULL;

-- Seed known Stripe price IDs for legacy plans (will be overridden by env vars at runtime)
-- Leave NULL — admin or env vars provide the actual values.
