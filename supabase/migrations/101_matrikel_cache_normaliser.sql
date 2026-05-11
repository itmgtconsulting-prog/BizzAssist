-- ============================================================================
-- 101_matrikel_cache_normaliser.sql — BIZZ-1276
-- ============================================================================
-- Tilføj normaliserede kolonner til matrikel_cache for søgbarhed og pivot.
-- Ekstraherer primære værdier fra JSONB jordstykker/ejendom.
-- ============================================================================

-- Normaliserede kolonner
ALTER TABLE public.matrikel_cache
  ADD COLUMN IF NOT EXISTS matrikelnummer text,
  ADD COLUMN IF NOT EXISTS ejerlav_navn text,
  ADD COLUMN IF NOT EXISTS ejerlav_kode integer,
  ADD COLUMN IF NOT EXISTS samlet_areal integer,
  ADD COLUMN IF NOT EXISTS antal_jordstykker smallint,
  ADD COLUMN IF NOT EXISTS landbrugsnotering boolean;

COMMENT ON COLUMN public.matrikel_cache.matrikelnummer IS 'BIZZ-1276: Primært matrikelnummer (første jordstykke)';
COMMENT ON COLUMN public.matrikel_cache.ejerlav_navn IS 'BIZZ-1276: Ejerlav navn';
COMMENT ON COLUMN public.matrikel_cache.ejerlav_kode IS 'BIZZ-1276: Ejerlav kode';
COMMENT ON COLUMN public.matrikel_cache.samlet_areal IS 'BIZZ-1276: Samlet registreret areal i m²';
COMMENT ON COLUMN public.matrikel_cache.antal_jordstykker IS 'BIZZ-1276: Antal jordstykker';
COMMENT ON COLUMN public.matrikel_cache.landbrugsnotering IS 'BIZZ-1276: Har landbrugsnotering';

-- Backfill fra eksisterende JSONB data
UPDATE public.matrikel_cache
SET
  matrikelnummer = jordstykker->0->>'matrikelnummer',
  ejerlav_navn = jordstykker->0->>'ejerlavsnavn',
  ejerlav_kode = (jordstykker->0->>'ejerlavskode')::integer,
  samlet_areal = (
    SELECT COALESCE(SUM((j->>'registreret_areal')::integer), 0)
    FROM jsonb_array_elements(jordstykker) j
    WHERE j->>'registreret_areal' IS NOT NULL
  ),
  antal_jordstykker = jsonb_array_length(jordstykker)::smallint,
  landbrugsnotering = COALESCE((ejendom->>'landbrugsnotering')::boolean, false)
WHERE jordstykker IS NOT NULL
  AND jsonb_array_length(jordstykker) > 0
  AND matrikelnummer IS NULL;

-- Indeks for søgning på matrikelnummer
CREATE INDEX IF NOT EXISTS idx_matrikel_cache_matrnr
  ON public.matrikel_cache (matrikelnummer)
  WHERE matrikelnummer IS NOT NULL;
