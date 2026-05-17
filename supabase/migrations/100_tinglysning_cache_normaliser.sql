-- ============================================================================
-- 100_tinglysning_cache_normaliser.sql — BIZZ-1275
-- ============================================================================
-- Tilføj normaliserede kolonner til tinglysning_cache for pivot og analyse.
-- Ekstraherer primære værdier fra JSONB data-kolonne.
--
-- BEMÆRK: Hæftelser/servitutter hentes via separate tinglysning.dk API-kald
-- og er IKKE i den cachede JSONB. Kolonner for hæftelser tilføjes med NULL
-- — de populeres ved fremtidig udvidelse af cron refresh.
-- ============================================================================

-- Normaliserede kolonner fra JSONB data
ALTER TABLE public.tinglysning_cache
  ADD COLUMN IF NOT EXISTS ejendoms_vurdering bigint,
  ADD COLUMN IF NOT EXISTS grund_vaerdi bigint,
  ADD COLUMN IF NOT EXISTS tinglyst_areal integer,
  ADD COLUMN IF NOT EXISTS kommune_nummer text,
  ADD COLUMN IF NOT EXISTS ejendomstype text;

-- Hæftelse-kolonner (NULL indtil cron-refresh udvides)
ALTER TABLE public.tinglysning_cache
  ADD COLUMN IF NOT EXISTS antal_haeftelser integer,
  ADD COLUMN IF NOT EXISTS samlet_gaeld bigint,
  ADD COLUMN IF NOT EXISTS antal_servitutter integer,
  ADD COLUMN IF NOT EXISTS har_pant boolean;

COMMENT ON COLUMN public.tinglysning_cache.ejendoms_vurdering IS 'BIZZ-1275: Ejendomsvurdering i DKK fra tingbogen';
COMMENT ON COLUMN public.tinglysning_cache.grund_vaerdi IS 'BIZZ-1275: Grundværdi i DKK fra tingbogen';
COMMENT ON COLUMN public.tinglysning_cache.tinglyst_areal IS 'BIZZ-1275: Tinglyst areal i kvm';
COMMENT ON COLUMN public.tinglysning_cache.kommune_nummer IS 'BIZZ-1275: Kommunenummer (4 cifre)';
COMMENT ON COLUMN public.tinglysning_cache.antal_haeftelser IS 'BIZZ-1275: Antal hæftelser (populeres af fremtidig cron)';
COMMENT ON COLUMN public.tinglysning_cache.samlet_gaeld IS 'BIZZ-1275: Samlet gæld i DKK (populeres af fremtidig cron)';

-- Backfill fra eksisterende JSONB data
UPDATE public.tinglysning_cache
SET
  ejendoms_vurdering = (data->>'ejendomsVurdering')::bigint,
  grund_vaerdi = (data->>'grundVaerdi')::bigint,
  tinglyst_areal = (data->>'tinglystAreal')::integer,
  kommune_nummer = data->>'kommuneNummer',
  ejendomstype = data->>'ejendomstype'
WHERE data IS NOT NULL
  AND ejendoms_vurdering IS NULL;

-- Indeks for pivot-analyse
CREATE INDEX IF NOT EXISTS idx_tinglysning_cache_kommune
  ON public.tinglysning_cache (kommune_nummer)
  WHERE kommune_nummer IS NOT NULL;
