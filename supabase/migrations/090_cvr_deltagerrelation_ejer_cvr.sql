-- ============================================================
-- Migration 090: Tilføj ejer_cvr til cvr_deltagerrelation
-- BIZZ-1108: Virksomheds-deltagere (holdingselskaber der ejer andre
-- virksomheder) har et CVR-nummer udover enhedsNummer. Ved at gemme
-- det kan vi slå op "hvad ejer CVR X?" direkte uden enhedsNummer→CVR
-- mapping. Muliggør cache-first datterselskab-opslag i diagram v2.
-- ============================================================

ALTER TABLE public.cvr_deltagerrelation
  ADD COLUMN IF NOT EXISTS ejer_cvr TEXT;

-- Index for datterselskab-opslag: "hvad ejer CVR X?"
CREATE INDEX IF NOT EXISTS ix_cvr_deltagerrel_ejer_cvr
  ON public.cvr_deltagerrelation (ejer_cvr)
  WHERE ejer_cvr IS NOT NULL AND gyldig_til IS NULL;

COMMENT ON COLUMN public.cvr_deltagerrelation.ejer_cvr IS
  'CVR-nummer for virksomheds-deltagere (holdingselskaber). NULL for person-deltagere. '
  'Bruges til datterselskab-opslag: SELECT virksomhed_cvr FROM cvr_deltagerrelation WHERE ejer_cvr = X.';
