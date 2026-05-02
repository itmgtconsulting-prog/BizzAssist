-- ============================================================
-- Migration 092: Tilføj ejerandel_pct til cvr_deltagerrelation
-- Ejerandel-procent for registrerede ejere og reelle ejere.
-- Kilde: CVR ES EJERANDEL_PROCENT (medlemsData.attributter).
-- Bruges til at filtrere indirekte ejerskab (0%) fra diagrammer.
-- ============================================================

ALTER TABLE public.cvr_deltagerrelation
  ADD COLUMN IF NOT EXISTS ejerandel_pct NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS ejerandel_fra DATE,
  ADD COLUMN IF NOT EXISTS ejerandel_til DATE;

COMMENT ON COLUMN public.cvr_deltagerrelation.ejerandel_pct IS
  'Ejerandel i procent fra CVR ES (EJERANDEL_PROCENT). NULL = ukendt/ikke-ejer-type. '
  '0 = registreret men ingen direkte ejerandel. >0 = aktiv ejerandel.';

COMMENT ON COLUMN public.cvr_deltagerrelation.ejerandel_fra IS
  'Startdato for ejerandels-perioden (EJERANDEL_PROCENT.gyldigFra). '
  'NULL = ukendt eller samme som relations gyldig_fra.';

COMMENT ON COLUMN public.cvr_deltagerrelation.ejerandel_til IS
  'Slutdato for ejerandels-perioden (EJERANDEL_PROCENT.gyldigTil). '
  'NULL = stadig gældende.';
