-- ============================================================
-- Migration 081: cvr_deltager phase-2 enrichment columns
-- BIZZ-823 (790b) — tilfoej antal_historiske_virksomheder og
-- totalt_antal_roller for filter phase 2.
--
-- Beregnes fra cvr_deltagerrelation:
--   antal_historiske_virksomheder = COUNT(DISTINCT cvr) WHERE gyldig_til IS NOT NULL
--   totalt_antal_roller           = COUNT(*) alle relationer pr. deltager
--
-- Populeres af:
--   - scripts/backfill-cvr-deltager-berigelse.mjs (engangs)
--   - app/api/cron/refresh-deltager-berigelse (daglig)
-- ============================================================

ALTER TABLE public.cvr_deltager
  ADD COLUMN IF NOT EXISTS antal_historiske_virksomheder INTEGER,
  ADD COLUMN IF NOT EXISTS totalt_antal_roller           INTEGER;

-- Btree index for range-filter (0-50 typisk)
CREATE INDEX IF NOT EXISTS idx_cvr_deltager_historiske
  ON public.cvr_deltager (antal_historiske_virksomheder)
  WHERE antal_historiske_virksomheder IS NOT NULL;

-- Btree index for range-filter (0-100 typisk)
CREATE INDEX IF NOT EXISTS idx_cvr_deltager_total_roller
  ON public.cvr_deltager (totalt_antal_roller)
  WHERE totalt_antal_roller IS NOT NULL;

COMMENT ON COLUMN public.cvr_deltager.antal_historiske_virksomheder IS
  'BIZZ-823: Count distinct virksomhed_cvr hvor deltager har ophoert role (gyldig_til IS NOT NULL)';
COMMENT ON COLUMN public.cvr_deltager.totalt_antal_roller IS
  'BIZZ-823: Total count af alle roller (aktive + ophoerte) pr. deltager';
