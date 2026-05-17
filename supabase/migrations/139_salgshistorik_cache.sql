-- 139: Persistent salgshistorik cache — BIZZ-1607
--
-- Erstatter in-memory LRU cache med Supabase-backed cache.
-- Cache-hit = instant return uden EJF/OAuth roundtrip.
-- TTL 24 timer — salgshistorik ændrer sig sjældent.

CREATE TABLE IF NOT EXISTS public.salgshistorik_cache (
  bfe_nummer  INTEGER PRIMARY KEY,
  payload     JSONB NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ttl_hours   INTEGER NOT NULL DEFAULT 24,
  hit_count   INTEGER NOT NULL DEFAULT 0,
  last_hit_at TIMESTAMPTZ
);

COMMENT ON TABLE public.salgshistorik_cache IS 'BIZZ-1607: Persistent cache for EJF salgshistorik — eliminerer OAuth+GraphQL roundtrip ved gentagne opslag';

CREATE INDEX IF NOT EXISTS ix_salgshistorik_cache_fetched
  ON public.salgshistorik_cache (fetched_at);

-- RLS: service_role only (backend cache — ikke bruger-tilgængelig)
ALTER TABLE public.salgshistorik_cache ENABLE ROW LEVEL SECURITY;
