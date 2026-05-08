-- BIZZ-1162: Person cache — personroller og ejendomme med 14-dags TTL
-- Aggregerer CVR-roller og ejf_ejerskab for person-sider.
-- Estimat: ~5M rækker ved fuld population.

CREATE TABLE IF NOT EXISTS public.person_cache (
  enheds_nummer BIGINT PRIMARY KEY,
  -- Virksomhedsroller (array af {cvr, navn, roller, form})
  roller JSONB,
  -- BFE-numre for ejendomme personen ejer direkte
  ejendomme JSONB,
  -- Metadata
  fetched_at TIMESTAMPTZ DEFAULT now(),
  stale_after TIMESTAMPTZ DEFAULT (now() + interval '14 days')
);

-- RLS
ALTER TABLE public.person_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "person_cache: service_role full"
  ON public.person_cache FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "person_cache: authenticated read"
  ON public.person_cache FOR SELECT
  TO authenticated USING (true);

-- Index for stale-detection (cron refresh)
CREATE INDEX IF NOT EXISTS idx_person_cache_stale
  ON public.person_cache (stale_after);

COMMENT ON TABLE public.person_cache IS 'BIZZ-1162: Cached persondata — 14d TTL, daglig refresh';
