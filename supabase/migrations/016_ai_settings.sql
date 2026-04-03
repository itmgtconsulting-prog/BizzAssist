-- 016_ai_settings.sql
-- AI-indstillinger til confidence-baseret link-scoring og læringsloop.
-- Gemmer nøgle/værdi-par med JSONB-værdier — kan udvides uden schema-ændring.

CREATE TABLE IF NOT EXISTS public.ai_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger: opdater updated_at automatisk ved ændringer
CREATE OR REPLACE FUNCTION public.ai_settings_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_settings_updated_at ON public.ai_settings;
CREATE TRIGGER ai_settings_updated_at
  BEFORE UPDATE ON public.ai_settings
  FOR EACH ROW EXECUTE FUNCTION public.ai_settings_set_updated_at();

-- Standard-tærskler:
-- min_confidence_threshold: links under denne score vises ikke (gemmes som alternativ)
-- confidence_levels: { hide: under threshold, uncertain: 70-85 (gul), confident: 85+ (grøn) }
INSERT INTO public.ai_settings (key, value) VALUES
  ('min_confidence_threshold', '70'),
  ('confidence_levels', '{"hide": 70, "uncertain": 85, "confident": 100}')
ON CONFLICT (key) DO NOTHING;

-- RLS: alle autentificerede brugere kan læse
ALTER TABLE public.ai_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_settings_select_authenticated"
  ON public.ai_settings FOR SELECT
  TO authenticated
  USING (true);

-- Skriv/opdater kun tilladt via service-role (admin-routes) — ingen bruger-RLS for UPDATE
