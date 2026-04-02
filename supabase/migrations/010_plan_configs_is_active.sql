-- 010: Extend plan_configs with full CRUD fields
-- is_active: allows admin to deactivate plans so users cannot select them.
-- free_trial_days: number of free days when a user first subscribes (0 = none).
-- duration_days: billing cycle in days (0 = use duration_months instead).
-- name_da/en, desc_da/en, color: allow admin to fully customize plan display.

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS free_trial_days integer NOT NULL DEFAULT 0;

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS duration_days integer NOT NULL DEFAULT 0;

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS name_da text NOT NULL DEFAULT '';

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS name_en text NOT NULL DEFAULT '';

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS desc_da text NOT NULL DEFAULT '';

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS desc_en text NOT NULL DEFAULT '';

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT 'blue';

-- Seed names for existing plans
UPDATE public.plan_configs SET name_da='Demo', name_en='Demo', desc_da='Gratis prøveperiode med fuld adgang. Kræver godkendelse.', desc_en='Free trial with full access. Requires approval.', color='amber' WHERE plan_id='demo' AND name_da='';
UPDATE public.plan_configs SET name_da='Basis', name_en='Basis', desc_da='Adgang til basisdata.', desc_en='Access to basic data.', color='slate' WHERE plan_id='basis' AND name_da='';
UPDATE public.plan_configs SET name_da='Professionel', name_en='Professional', desc_da='Alt i Basis + AI-assistent.', desc_en='Everything in Basis + AI assistant.', color='blue' WHERE plan_id='professionel' AND name_da='';
UPDATE public.plan_configs SET name_da='Enterprise', name_en='Enterprise', desc_da='Fuld adgang med ubegrænset AI.', desc_en='Full access with unlimited AI.', color='purple' WHERE plan_id='enterprise' AND name_da='';
