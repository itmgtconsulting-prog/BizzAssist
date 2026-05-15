-- ============================================================================
-- 128: M²-pris beregning — BIZZ-1463
-- Tilføj m2_pris til ejerskifte_historik (kontant_koebesum / boligareal).
-- Tilføj m2_pris til tinglysning_adkomst.
-- ============================================================================

-- Ejerskifte historik
ALTER TABLE public.ejerskifte_historik
  ADD COLUMN IF NOT EXISTS boligareal_m2 INTEGER,
  ADD COLUMN IF NOT EXISTS m2_pris INTEGER;

COMMENT ON COLUMN public.ejerskifte_historik.m2_pris IS 'BIZZ-1463: Beregnet m²-pris (kontant_koebesum / boligareal_m2 i DKK/m²)';

-- Backfill boligareal fra BBR
UPDATE public.ejerskifte_historik eh
SET boligareal_m2 = b.samlet_boligareal
FROM public.bbr_ejendom_status b
WHERE b.bfe_nummer = eh.bfe_nummer
  AND b.samlet_boligareal IS NOT NULL
  AND b.samlet_boligareal > 0
  AND eh.boligareal_m2 IS NULL;

-- Beregn m²-pris
UPDATE public.ejerskifte_historik
SET m2_pris = (kontant_koebesum / boligareal_m2)::integer
WHERE kontant_koebesum IS NOT NULL
  AND boligareal_m2 IS NOT NULL
  AND boligareal_m2 > 0
  AND m2_pris IS NULL;

-- Tinglysning adkomst
ALTER TABLE public.tinglysning_adkomst
  ADD COLUMN IF NOT EXISTS boligareal_m2 INTEGER,
  ADD COLUMN IF NOT EXISTS m2_pris INTEGER;

-- Index for m²-pris queries
CREATE INDEX IF NOT EXISTS idx_ejerskifte_m2pris
  ON public.ejerskifte_historik (m2_pris)
  WHERE m2_pris IS NOT NULL;
