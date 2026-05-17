-- ============================================================================
-- 133: Ejerskab cache table — BIZZ-1582
-- ============================================================================
-- Server-side cache for ejerskab-chain responses (Tinglysning + CVR ES +
-- EJF aggregat). Default TTL 6 timer — invalideres af nightly tinglysning-
-- aendringer cron når en BFE har haft tinglysningshændelser.
--
-- Cache-keys følger format: 'ejerskab-chain:bfe:{bfe}:type:{type}' så
-- ejerlejlighed-variant (skipTinglysning) caches separat fra fuld-variant.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ejerskab_cache (
  cache_key      TEXT        PRIMARY KEY,
  bfe_nummer     BIGINT,
  payload        JSONB       NOT NULL,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ttl_minutes    INTEGER     NOT NULL DEFAULT 360,
  hit_count      INTEGER     NOT NULL DEFAULT 0,
  last_hit_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ejerskab_cache_fetched
  ON public.ejerskab_cache (fetched_at);

CREATE INDEX IF NOT EXISTS idx_ejerskab_cache_hits
  ON public.ejerskab_cache (hit_count DESC, last_hit_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_ejerskab_cache_bfe
  ON public.ejerskab_cache (bfe_nummer)
  WHERE bfe_nummer IS NOT NULL;

ALTER TABLE public.ejerskab_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ejerskab_cache: service_role full" ON public.ejerskab_cache;
CREATE POLICY "ejerskab_cache: service_role full"
  ON public.ejerskab_cache FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- Authenticated users må læse cache (ingen PII — kun aggregeret offentlig data
-- fra Tinglysning/CVR der allerede er public)
DROP POLICY IF EXISTS "ejerskab_cache: authenticated read" ON public.ejerskab_cache;
CREATE POLICY "ejerskab_cache: authenticated read"
  ON public.ejerskab_cache FOR SELECT
  TO authenticated USING (true);

COMMENT ON TABLE public.ejerskab_cache IS
  'BIZZ-1582: Cache for ejerskab-chain payloads. TTL 6t default. Invalideres af pull-tinglysning-aendringer cron ved nye hændelser på BFE.';

-- ─── Cleanup-funktion ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ejerskab_cache_purge_stale()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.ejerskab_cache
    WHERE fetched_at < now() - (ttl_minutes || ' minutes')::interval;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ejerskab_cache_purge_stale() TO service_role;

COMMENT ON FUNCTION public.ejerskab_cache_purge_stale() IS
  'BIZZ-1582: Sletter cache-entries der har overskredet deres TTL. Kaldes af purge-old-data cron.';
