-- BIZZ-1094: Vurdering cache — bulk ejendomsvurderinger med API fallback
-- Eliminerer live VUR GraphQL + Vurderingsportalen ES-kald for cached ejendomme.

CREATE TABLE IF NOT EXISTS public.vurdering_cache (
  bfe_nummer BIGINT PRIMARY KEY,
  -- Officielle vurderinger fra Datafordeler VUR GraphQL
  vurderinger JSONB,
  -- Grundværdispecifikation
  grundvaerdispec JSONB,
  -- Fordeling (ejerlejligheder)
  fordeling JSONB,
  -- Skatteloft (ESL §45)
  loft JSONB,
  -- Fritagelser
  fritagelser JSONB,
  -- Fradrag for forbedringer
  fradrag JSONB,
  -- Foreløbige vurderinger fra Vurderingsportalen ES
  foreloebig JSONB,
  -- Skatteberegning (grundskyld, ejendomsværdiskat, total)
  skatteberegning JSONB,
  -- Metadata
  fetched_at TIMESTAMPTZ DEFAULT now(),
  stale_after TIMESTAMPTZ DEFAULT (now() + interval '30 days')
);

-- RLS
ALTER TABLE public.vurdering_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "vurdering_cache: service_role full"
  ON public.vurdering_cache FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "vurdering_cache: authenticated read"
  ON public.vurdering_cache FOR SELECT
  TO authenticated USING (true);

-- Index for stale-detection (cron refresh — plain B-tree, now() comparison at query time)
CREATE INDEX IF NOT EXISTS idx_vurdering_cache_stale
  ON public.vurdering_cache (stale_after);

COMMENT ON TABLE public.vurdering_cache IS 'BIZZ-1094: Cached ejendomsvurderinger — 30d TTL, nattelig refresh';
