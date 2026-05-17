-- ============================================================================
-- 123: Normaliser regnskab_cache JSONB til flade kolonner — BIZZ-1468
-- Ekstraherer seneste regnskabsår til separate kolonner for AI queries.
-- ============================================================================

ALTER TABLE public.regnskab_cache
  ADD COLUMN IF NOT EXISTS seneste_aar INTEGER,
  ADD COLUMN IF NOT EXISTS omsaetning BIGINT,
  ADD COLUMN IF NOT EXISTS bruttofortjeneste BIGINT,
  ADD COLUMN IF NOT EXISTS resultat_foer_skat BIGINT,
  ADD COLUMN IF NOT EXISTS aarsresultat BIGINT,
  ADD COLUMN IF NOT EXISTS egenkapital BIGINT,
  ADD COLUMN IF NOT EXISTS aktiver_i_alt BIGINT,
  ADD COLUMN IF NOT EXISTS gaeld_i_alt BIGINT,
  ADD COLUMN IF NOT EXISTS selskabskapital BIGINT,
  ADD COLUMN IF NOT EXISTS antal_ansatte INTEGER;

COMMENT ON COLUMN public.regnskab_cache.seneste_aar IS 'BIZZ-1468: Seneste regnskabsår';
COMMENT ON COLUMN public.regnskab_cache.omsaetning IS 'BIZZ-1468: Nettoomsætning i t.DKK';
COMMENT ON COLUMN public.regnskab_cache.aarsresultat IS 'BIZZ-1468: Årsresultat i t.DKK';
COMMENT ON COLUMN public.regnskab_cache.egenkapital IS 'BIZZ-1468: Egenkapital i t.DKK';

-- Backfill fra JSONB (seneste år = index 0)
UPDATE public.regnskab_cache
SET
  seneste_aar = (years->0->>'aar')::integer,
  omsaetning = (years->0->'resultat'->>'omsaetning')::bigint,
  bruttofortjeneste = (years->0->'resultat'->>'bruttofortjeneste')::bigint,
  resultat_foer_skat = (years->0->'resultat'->>'resultatFoerSkat')::bigint,
  aarsresultat = (years->0->'resultat'->>'aarsresultat')::bigint,
  egenkapital = (years->0->'balance'->>'egenkapital')::bigint,
  aktiver_i_alt = (years->0->'balance'->>'aktiverIAlt')::bigint,
  gaeld_i_alt = (years->0->'balance'->>'gaeldsforpligtelserIAlt')::bigint,
  selskabskapital = (years->0->'balance'->>'selskabskapital')::bigint,
  antal_ansatte = (years->0->>'ansatte')::integer
WHERE years IS NOT NULL
  AND jsonb_array_length(years) > 0
  AND seneste_aar IS NULL;

-- Index for AI queries
CREATE INDEX IF NOT EXISTS idx_regnskab_cache_omsaetning
  ON public.regnskab_cache (omsaetning DESC NULLS LAST)
  WHERE omsaetning IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_regnskab_cache_aar
  ON public.regnskab_cache (seneste_aar);

-- Giv ai_query_reader adgang (tabellen har allerede RLS)
GRANT SELECT ON public.regnskab_cache TO ai_query_reader;
