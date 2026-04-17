-- Migration 045: Add payment_grace_hours to plan_configs (BIZZ-541)
--
-- When a recurring Stripe charge fails the subscription enters past_due.
-- This column controls how long (in hours) the user retains access while
-- Stripe retries. Default is 0 — meaning payment failure immediately revokes
-- access, behaving exactly like "not paid for the plan". Plans can be tuned
-- per-tier (e.g. enterprise gets 48h, basis gets 0h).
--
-- Zero by default is deliberate: we do not want cheap plans granting free
-- usage while a card is declined. Admins can raise the value per plan via
-- the admin panel (BIZZ-419 follow-up).

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS payment_grace_hours INTEGER NOT NULL DEFAULT 0
    CHECK (payment_grace_hours >= 0 AND payment_grace_hours <= 168);

COMMENT ON COLUMN public.plan_configs.payment_grace_hours IS
  'BIZZ-541: Hours of continued access after a failed recurring payment. 0 = no grace (default).';
