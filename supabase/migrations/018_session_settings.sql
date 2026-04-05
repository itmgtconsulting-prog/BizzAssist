-- Migration 018: Session timeout settings
--
-- Tilføjer tre session-indstillinger til ai_settings-tabellen:
--   idle_timeout_minutes   — log ud efter X minutters inaktivitet (default 60)
--   absolute_timeout_hours — log ud uanset aktivitet efter X timer (default 24)
--   refresh_token_days     — Supabase refresh-token levetid i dage (default 30)
--
-- Indstillingerne styres via admin-panelet på /dashboard/admin/security.

INSERT INTO public.ai_settings (key, value)
VALUES
  ('idle_timeout_minutes',   '60'::jsonb),
  ('absolute_timeout_hours', '24'::jsonb),
  ('refresh_token_days',     '30'::jsonb)
ON CONFLICT (key) DO NOTHING;
