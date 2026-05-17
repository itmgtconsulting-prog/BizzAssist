-- ============================================================================
-- 098_ejf_ejerskab_ejer_enheds_nummer.sql — BIZZ-1273
-- ============================================================================
-- Tilføj ejer_enheds_nummer kolonne til ejf_ejerskab for person-ejer linking.
--
-- Formål: Direkte kobling fra ejendoms-ejerskab til person (cvr_deltager).
-- Uden dette link er Ejendom og Person isolerede — man kan ikke gå fra en
-- ejendom til personens virksomheder via enhedsNummer.
--
-- Kolonnen populeres via backfill-script der matcher ejer_navn mod
-- cvr_deltager.navn for person-ejere (ejer_type = 'person').
-- ============================================================================

-- Tilføj kolonne (nullable — backfill populerer gradvist)
ALTER TABLE public.ejf_ejerskab
  ADD COLUMN IF NOT EXISTS ejer_enheds_nummer bigint;

COMMENT ON COLUMN public.ejf_ejerskab.ejer_enheds_nummer IS
  'BIZZ-1273: Person-ejerens enhedsNummer fra cvr_deltager. '
  'NULL for virksomheds-ejere og endnu ikke matchede person-ejere.';

-- Partial index: lookup fra enhedsNummer → ejendomme (kun person-ejere)
CREATE INDEX IF NOT EXISTS ix_ejf_ejer_enheds_nummer
  ON public.ejf_ejerskab (ejer_enheds_nummer)
  WHERE ejer_enheds_nummer IS NOT NULL AND status = 'gældende';
