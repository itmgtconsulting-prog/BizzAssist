-- BIZZ-1162: Tinglysning cache — tingbogsdata med 7-dags TTL
-- Eliminerer live tinglysning.dk API-kald for cached ejendomme.
-- Estimat: ~4M rækker ved fuld population.

CREATE TABLE IF NOT EXISTS public.tinglysning_cache (
  bfe_nummer BIGINT PRIMARY KEY,
  -- Rå tingbogsdata (TinglysningData JSON)
  data JSONB,
  -- Metadata
  fetched_at TIMESTAMPTZ DEFAULT now(),
  stale_after TIMESTAMPTZ DEFAULT (now() + interval '7 days')
);

-- RLS
ALTER TABLE public.tinglysning_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tinglysning_cache: service_role full"
  ON public.tinglysning_cache FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "tinglysning_cache: authenticated read"
  ON public.tinglysning_cache FOR SELECT
  TO authenticated USING (true);

-- Index for stale-detection (cron refresh)
CREATE INDEX IF NOT EXISTS idx_tinglysning_cache_stale
  ON public.tinglysning_cache (stale_after);

COMMENT ON TABLE public.tinglysning_cache IS 'BIZZ-1162: Cached tingbogsdata — 7d TTL, daglig refresh';
