-- ============================================================================
-- 131: dim_kommune lookup-tabel — BIZZ-1566 Backfill 1
-- Autoritativ mapping mellem kommunekode og navn/region/landsdel.
-- 98 danske kommuner — populeres via scripts/backfill-dim-kommune.mjs.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.dim_kommune (
  kode        TEXT        PRIMARY KEY,              -- 4-cifret zero-padded, fx '0167'
  navn        TEXT        NOT NULL,                 -- 'Hvidovre'
  region_kode TEXT,                                 -- '1084' osv.
  region_navn TEXT,                                 -- 'Hovedstaden'
  landsdel_navn TEXT,                               -- 'Københavns omegn'
  indbyggertal_seneste INTEGER,                     -- For befolknings-baserede metrics
  areal_km2   NUMERIC(8,2),
  refreshed_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_dim_kommune_navn ON public.dim_kommune(LOWER(navn));

COMMENT ON TABLE public.dim_kommune IS 'Autoritativ kommune-lookup (98 danske kommuner). Bruges af DI v2 metric-katalog.';
