-- ============================================================
-- Migration 193: Index for CVR-virksomhed friskhedstjek
-- BIZZ-2210: Friskheds-overvågningen (checkAllDataFreshness) kører
--   SELECT sidst_opdateret ... ORDER BY sidst_opdateret DESC LIMIT 1
-- på cvr_virksomhed (2,2M rækker). Det eksisterende composite-index
-- (status, sidst_opdateret) kan ikke betjene en ren sort → query'en
-- timeoutede → watchdoggen fik falsk "critical/error" for CVR.
--
-- Et enkeltkolonne-DESC-index gør friskhedstjekket instant.
-- Idempotent (IF NOT EXISTS).
-- ============================================================

CREATE INDEX IF NOT EXISTS cvr_virksomhed_sidst_opdateret_idx
  ON public.cvr_virksomhed (sidst_opdateret DESC);

-- ejf_ejerskab (7,6M rækker): samme friskhedstjek tog ~10s uden dedikeret
-- DESC-index — tæt på timeout. Enkeltkolonne-index gør det instant.
CREATE INDEX IF NOT EXISTS ejf_ejerskab_sidst_opdateret_idx
  ON public.ejf_ejerskab (sidst_opdateret DESC);
