-- Migration 019: Ensure plan_configs has all required columns
--
-- Idempotent catch-up migration for instances where migrations 009–012
-- were not fully applied (e.g. the table was created via a pre-010 snapshot).
-- All statements use ADD COLUMN IF NOT EXISTS and are safe to re-run.

-- From migration 009 core columns (may be missing if table was created without requires_approval)
ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT false;

-- From migration 010
ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS free_trial_days INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS duration_days INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS name_da TEXT NOT NULL DEFAULT '';

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS name_en TEXT NOT NULL DEFAULT '';

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS desc_da TEXT NOT NULL DEFAULT '';

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS desc_en TEXT NOT NULL DEFAULT '';

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT 'blue';

-- From migration 011
ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS stripe_price_id TEXT DEFAULT NULL;

-- From migration 012
ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS max_sales INTEGER DEFAULT NULL;

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS sales_count INTEGER NOT NULL DEFAULT 0;

-- Backfill names for plans that have empty name_da (idempotent)
UPDATE public.plan_configs
  SET name_da = 'Demo', name_en = 'Demo',
      color = 'amber',
      requires_approval = true
  WHERE plan_id = 'demo' AND name_da = '';

UPDATE public.plan_configs
  SET name_da = 'Basis', name_en = 'Basis', color = 'slate'
  WHERE plan_id = 'basis' AND name_da = '';

UPDATE public.plan_configs
  SET name_da = 'Professionel', name_en = 'Professional', color = 'blue'
  WHERE plan_id = 'professionel' AND name_da = '';

UPDATE public.plan_configs
  SET name_da = 'Enterprise', name_en = 'Enterprise', color = 'purple'
  WHERE plan_id = 'enterprise' AND name_da = '';
