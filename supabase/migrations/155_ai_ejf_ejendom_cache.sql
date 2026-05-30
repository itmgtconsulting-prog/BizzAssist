-- BIZZ-1828: Cache-tabel for AI ejerforenings-ejendoms-resolve
-- Cacher Claude-vurderinger af kandidat-ejendomme pr. CVR (24t TTL)

CREATE TABLE IF NOT EXISTS public.ai_ejf_ejendom_cache (
  cvr          text        PRIMARY KEY,
  candidates   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ai_ejf_ejendom_cache IS 'BIZZ-1828: Cache for AI-vurderede ejerforenings-ejendomme. TTL 24t, nøgle = CVR.';
