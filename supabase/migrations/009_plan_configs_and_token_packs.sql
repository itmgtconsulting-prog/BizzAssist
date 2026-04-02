-- Migration 009: Configurable plan parameters + purchasable token packs
--
-- plan_configs: admin-configurable overrides for the four canonical plans
-- token_packs: one-time purchasable token bundles

-- ─── Plan Configs ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.plan_configs (
  plan_id                          TEXT PRIMARY KEY,
  price_dkk                        INTEGER NOT NULL,
  ai_tokens_per_month              INTEGER NOT NULL,
  duration_months                  INTEGER NOT NULL DEFAULT 1,
  token_accumulation_cap_multiplier NUMERIC(4,1) NOT NULL DEFAULT 5.0,
  ai_enabled                       BOOLEAN NOT NULL DEFAULT true,
  requires_approval                BOOLEAN NOT NULL DEFAULT false,
  updated_at                       TIMESTAMPTZ DEFAULT now(),
  updated_by                       UUID REFERENCES auth.users
);

-- Seed with current hardcoded values
INSERT INTO public.plan_configs (plan_id, price_dkk, ai_tokens_per_month, duration_months, token_accumulation_cap_multiplier, ai_enabled, requires_approval)
VALUES
  ('demo',          0,    10000,  1, 5.0, true,  true),
  ('basis',       299,        0,  1, 5.0, false, false),
  ('professionel', 799,   50000,  1, 5.0, true,  false),
  ('enterprise',  2499,      -1,  1, 5.0, true,  false)
ON CONFLICT (plan_id) DO NOTHING;

-- ─── Token Packs ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.token_packs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name_da          TEXT NOT NULL,
  name_en          TEXT NOT NULL,
  token_amount     INTEGER NOT NULL,
  price_dkk        INTEGER NOT NULL,
  stripe_price_id  TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- Seed default token packs
INSERT INTO public.token_packs (name_da, name_en, token_amount, price_dkk, sort_order)
VALUES
  ('10.000 tokens',  '10,000 tokens',  10000,   49, 1),
  ('50.000 tokens',  '50,000 tokens',  50000,  199, 2),
  ('100.000 tokens', '100,000 tokens', 100000, 349, 3)
ON CONFLICT DO NOTHING;

-- ─── RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE public.plan_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.token_packs ENABLE ROW LEVEL SECURITY;

-- Plan configs: readable by all authenticated, writable by service role only
CREATE POLICY "plan_configs_read" ON public.plan_configs
  FOR SELECT USING (true);

-- Token packs: readable by all authenticated, writable by service role only
CREATE POLICY "token_packs_read" ON public.token_packs
  FOR SELECT USING (true);
