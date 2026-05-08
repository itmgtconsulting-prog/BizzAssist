-- BIZZ-1162: Matrikel cache — MAT GraphQL data med 30-dags TTL
-- Matrikeldata ændres sjældent (ommatrikulering). Eliminerer live
-- Datafordeler MAT API-kald for cached ejendomme.
-- Estimat: ~2M rækker ved fuld population.

CREATE TABLE IF NOT EXISTS public.matrikel_cache (
  bfe_nummer BIGINT PRIMARY KEY,
  -- SFE-niveau data (status, landbrugsnotering, etc.)
  ejendom JSONB,
  -- Jordstykker array (matrikelnumre, arealer, restriktioner)
  jordstykker JSONB,
  -- Metadata
  fetched_at TIMESTAMPTZ DEFAULT now(),
  stale_after TIMESTAMPTZ DEFAULT (now() + interval '30 days')
);

-- RLS
ALTER TABLE public.matrikel_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "matrikel_cache: service_role full"
  ON public.matrikel_cache FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "matrikel_cache: authenticated read"
  ON public.matrikel_cache FOR SELECT
  TO authenticated USING (true);

-- Index for stale-detection (cron refresh)
CREATE INDEX IF NOT EXISTS idx_matrikel_cache_stale
  ON public.matrikel_cache (stale_after);

COMMENT ON TABLE public.matrikel_cache IS 'BIZZ-1162: Cached matrikeldata — 30d TTL, ugentlig refresh';
