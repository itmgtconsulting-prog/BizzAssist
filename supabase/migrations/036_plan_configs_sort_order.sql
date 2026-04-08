-- Migration 036: Add sort_order to plan_configs
-- Allows admin to control the display order of plans on the marketing homepage.

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

-- Set default sort order for the four canonical plans
UPDATE public.plan_configs SET sort_order = 1 WHERE plan_id = 'demo';
UPDATE public.plan_configs SET sort_order = 2 WHERE plan_id = 'basis';
UPDATE public.plan_configs SET sort_order = 3 WHERE plan_id = 'professionel';
UPDATE public.plan_configs SET sort_order = 4 WHERE plan_id = 'enterprise';
