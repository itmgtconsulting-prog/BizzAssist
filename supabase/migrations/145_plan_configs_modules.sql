-- BIZZ-1618: Tilføj modules kolonne til plan_configs
-- Gør modul-tildeling per plan dynamisk (admin kan tildele via UI)
-- Hardcoded defaults i subscriptions.ts bruges som fallback hvis kolonnen er tom

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS modules TEXT[] DEFAULT '{}';

COMMENT ON COLUMN public.plan_configs.modules IS
  'Analyse-modul IDs inkluderet i planen (fx {annonce,forsikring}). Tom array = brug hardcoded default.';
