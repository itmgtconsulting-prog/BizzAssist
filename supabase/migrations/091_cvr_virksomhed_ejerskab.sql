-- ============================================================
-- Migration 091: cvr_virksomhed_ejerskab — virksomhed-til-virksomhed ejerskab
-- BIZZ-1125: Cache ejerskabsrelationer mellem virksomheder lokalt.
-- Data populeres fra CVR ES deltagerRelation (virksomheds-deltagere med ejerandel).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.cvr_virksomhed_ejerskab (
  ejer_cvr       TEXT NOT NULL,            -- CVR for den ejende virksomhed
  ejet_cvr       TEXT NOT NULL,            -- CVR for den ejede virksomhed
  ejerandel_pct  NUMERIC,                  -- Ejerandel i procent (fx 33.33)
  ejerandel_min  NUMERIC,                  -- Interval min (fx 25)
  ejerandel_max  NUMERIC,                  -- Interval max (fx 33.33)
  gyldig_fra     DATE,                     -- Ejerskabets startdato
  gyldig_til     DATE,                     -- NULL = gældende
  sidst_opdateret TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (ejer_cvr, ejet_cvr)
);

-- Index: find hvem der ejer en given virksomhed (opad)
CREATE INDEX IF NOT EXISTS ix_cvr_virk_ejerskab_ejet
  ON public.cvr_virksomhed_ejerskab (ejet_cvr)
  WHERE gyldig_til IS NULL;

-- Index: find hvad en virksomhed ejer (nedad)
CREATE INDEX IF NOT EXISTS ix_cvr_virk_ejerskab_ejer
  ON public.cvr_virksomhed_ejerskab (ejer_cvr)
  WHERE gyldig_til IS NULL;

-- RLS
ALTER TABLE public.cvr_virksomhed_ejerskab ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cvr_virksomhed_ejerskab_read"
  ON public.cvr_virksomhed_ejerskab
  FOR SELECT
  USING (true);

COMMENT ON TABLE public.cvr_virksomhed_ejerskab IS
  'BIZZ-1125: Cache af virksomhed-til-virksomhed ejerskab fra CVR ES. '
  'Bruges af diagram v2 expand-route for cache-first ejer-opslag.';
