-- ============================================================================
-- 099_vurdering_cache_normaliser.sql — BIZZ-1274
-- ============================================================================
-- Tilføj normaliserede kolonner til vurdering_cache for pivot og AI queries.
-- Ekstraherer primære værdier fra JSONB vurderinger-array til separate kolonner.
-- ============================================================================

-- Normaliserede kolonner (nullable — backfill populerer)
ALTER TABLE public.vurdering_cache
  ADD COLUMN IF NOT EXISTS ejendomsvaerdi bigint,
  ADD COLUMN IF NOT EXISTS grundvaerdi bigint,
  ADD COLUMN IF NOT EXISTS vurderingsaar integer,
  ADD COLUMN IF NOT EXISTS benyttelseskode text,
  ADD COLUMN IF NOT EXISTS grundskyldspromille numeric,
  ADD COLUMN IF NOT EXISTS bebyggelsesprocent numeric;

COMMENT ON COLUMN public.vurdering_cache.ejendomsvaerdi IS 'BIZZ-1274: Offentlig ejendomsværdi i DKK (seneste vurdering)';
COMMENT ON COLUMN public.vurdering_cache.grundvaerdi IS 'BIZZ-1274: Grundværdi i DKK (seneste vurdering)';
COMMENT ON COLUMN public.vurdering_cache.vurderingsaar IS 'BIZZ-1274: Vurderingsår (seneste vurdering)';
COMMENT ON COLUMN public.vurdering_cache.benyttelseskode IS 'BIZZ-1274: Benyttelseskode (seneste vurdering)';
COMMENT ON COLUMN public.vurdering_cache.grundskyldspromille IS 'BIZZ-1274: Kommunens grundskyldspromille';
COMMENT ON COLUMN public.vurdering_cache.bebyggelsesprocent IS 'BIZZ-1274: Bebyggelsesprocent (0-100)';

-- Backfill fra eksisterende JSONB data (seneste vurdering = index 0)
UPDATE public.vurdering_cache
SET
  ejendomsvaerdi = (vurderinger->0->>'ejendomsvaerdi')::bigint,
  grundvaerdi = (vurderinger->0->>'grundvaerdi')::bigint,
  vurderingsaar = (vurderinger->0->>'aar')::integer,
  benyttelseskode = vurderinger->0->>'benyttelseskode',
  grundskyldspromille = (vurderinger->0->>'grundskyldspromille')::numeric,
  bebyggelsesprocent = (vurderinger->0->>'bebyggelsesprocent')::numeric
WHERE vurderinger IS NOT NULL
  AND jsonb_array_length(vurderinger) > 0
  AND ejendomsvaerdi IS NULL;

-- Indeks for pivot-analyse: filtrer/gruppér på vurderingsaar og ejendomsværdi
CREATE INDEX IF NOT EXISTS idx_vurdering_cache_vaerdi
  ON public.vurdering_cache (vurderingsaar)
  WHERE ejendomsvaerdi IS NOT NULL;
