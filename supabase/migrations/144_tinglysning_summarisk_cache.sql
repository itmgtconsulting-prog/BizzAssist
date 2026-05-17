-- 144: Persistent cache for tinglysning summarisk — BIZZ-1615
--
-- Cacher parsed ejere/haeftelser/servitutter per ejendoms-UUID.
-- Bruges som fallback når Tinglysning API returnerer 429.
-- TTL 7 dage — tinglysningsdata ændrer sig sjældent.

CREATE TABLE IF NOT EXISTS public.tinglysning_summarisk_cache (
  uuid        TEXT PRIMARY KEY,
  bfe_nummer  INTEGER,
  payload     JSONB NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ttl_hours   INTEGER NOT NULL DEFAULT 168,
  hit_count   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_tl_sum_cache_bfe ON public.tinglysning_summarisk_cache (bfe_nummer);

COMMENT ON TABLE public.tinglysning_summarisk_cache IS 'BIZZ-1615: Persistent cache for tinglysning summarisk. Fallback ved 429 rate-limit.';

ALTER TABLE public.tinglysning_summarisk_cache ENABLE ROW LEVEL SECURITY;
