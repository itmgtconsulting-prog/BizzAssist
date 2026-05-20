-- ============================================================================
-- 135: holding_path — pre-computed ejergraf-dybde — BIZZ-1566 Backfill 7
--
-- Recursive CTE er for dyr til ad-hoc queries. Denne tabel pre-beregner
-- holding-dybde mellem ultimate ejer og ejendom via nightly cron.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.holding_path (
  ultimate_ejer_enhedsnummer  INTEGER     NOT NULL,
  bfe_nummer                  INTEGER     NOT NULL,
  depth                       INTEGER     NOT NULL,       -- 0 = direkte personlig, 1+ = via N holding-lag
  total_ejerandel_pct         NUMERIC(5,2),               -- Effektiv andel efter multiplikation
  intermediate_cvrs           TEXT[],                      -- Holding-CVR-kæde fra person til ejendom
  computed_at                 TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (ultimate_ejer_enhedsnummer, bfe_nummer)
);

CREATE INDEX IF NOT EXISTS ix_holding_path_bfe ON public.holding_path(bfe_nummer);
CREATE INDEX IF NOT EXISTS ix_holding_path_depth ON public.holding_path(depth);

COMMENT ON TABLE public.holding_path IS 'Pre-computed holding-dybde mellem person og ejendom. Nightly refresh via cron. BIZZ-1566.';
