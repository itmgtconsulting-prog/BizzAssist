-- ============================================================================
-- 103_bbr_ejendom_detaljer.sql — BIZZ-1271
-- ============================================================================
-- Tilføj 15+ normaliserede bygningsdetalje-kolonner til bbr_ejendom_status.
-- Ekstraherer fra eksisterende JSONB bygninger-kolonne (migration 086).
--
-- Mange felter eksisterer allerede (migration 076): samlet_boligareal,
-- samlet_erhvervsareal, grundareal, bebygget_areal, opfoerelsesaar,
-- ombygningsaar, byg021_anvendelse, energimaerke.
-- Denne migration tilføjer de resterende felter.
-- ============================================================================

-- Nye normaliserede kolonner (bygningsdetaljer)
ALTER TABLE public.bbr_ejendom_status
  ADD COLUMN IF NOT EXISTS antal_etager smallint,
  ADD COLUMN IF NOT EXISTS antal_boligenheder smallint,
  ADD COLUMN IF NOT EXISTS tagmateriale text,
  ADD COLUMN IF NOT EXISTS ydervaeg_materiale text,
  ADD COLUMN IF NOT EXISTS varmeinstallation text,
  ADD COLUMN IF NOT EXISTS opvarmningsform text,
  ADD COLUMN IF NOT EXISTS supplerende_varme text,
  ADD COLUMN IF NOT EXISTS vandforsyning text,
  ADD COLUMN IF NOT EXISTS afloebsforhold text,
  ADD COLUMN IF NOT EXISTS fredning text,
  ADD COLUMN IF NOT EXISTS bevaringsvaerdighed smallint,
  ADD COLUMN IF NOT EXISTS ejerforholdskode text;

COMMENT ON COLUMN public.bbr_ejendom_status.antal_etager IS 'BIZZ-1271: Antal etager (primær bygning)';
COMMENT ON COLUMN public.bbr_ejendom_status.antal_boligenheder IS 'BIZZ-1271: Antal boligenheder i ejendommen';
COMMENT ON COLUMN public.bbr_ejendom_status.tagmateriale IS 'BIZZ-1271: Tagmateriale-kode (BBR byg032)';
COMMENT ON COLUMN public.bbr_ejendom_status.ydervaeg_materiale IS 'BIZZ-1271: Ydervæg-materiale-kode (BBR byg033)';
COMMENT ON COLUMN public.bbr_ejendom_status.varmeinstallation IS 'BIZZ-1271: Varmeinstallation-kode (BBR byg056)';
COMMENT ON COLUMN public.bbr_ejendom_status.opvarmningsform IS 'BIZZ-1271: Opvarmningsform-kode (BBR byg058)';
COMMENT ON COLUMN public.bbr_ejendom_status.supplerende_varme IS 'BIZZ-1271: Supplerende varme-kode (BBR byg057)';
COMMENT ON COLUMN public.bbr_ejendom_status.vandforsyning IS 'BIZZ-1271: Vandforsyning-kode (BBR byg060)';
COMMENT ON COLUMN public.bbr_ejendom_status.afloebsforhold IS 'BIZZ-1271: Afløbsforhold-kode (BBR byg061)';
COMMENT ON COLUMN public.bbr_ejendom_status.fredning IS 'BIZZ-1271: Fredningsstatus';
COMMENT ON COLUMN public.bbr_ejendom_status.bevaringsvaerdighed IS 'BIZZ-1271: Bevaringsværdighed (1-9 skala, 1 = højest)';
COMMENT ON COLUMN public.bbr_ejendom_status.ejerforholdskode IS 'BIZZ-1271: Ejerforholdskode (BBR)';

-- Backfill fra eksisterende JSONB bygninger-kolonne (primær bygning = index 0)
UPDATE public.bbr_ejendom_status
SET
  antal_etager = (bygninger->0->>'byg054AntalEtager')::smallint,
  antal_boligenheder = (bygninger->0->>'byg036AntalBoligenheder')::smallint,
  tagmateriale = bygninger->0->>'byg032Tagdaekningsmateriale',
  ydervaeg_materiale = bygninger->0->>'byg033Ydervaeggensmateriale',
  varmeinstallation = bygninger->0->>'byg056Varmeinstallation',
  opvarmningsform = bygninger->0->>'byg058Opvarmningsmiddel',
  supplerende_varme = bygninger->0->>'byg057SupplerendeVarme',
  vandforsyning = bygninger->0->>'byg060Vandforsyning',
  afloebsforhold = bygninger->0->>'byg061Afloebsforhold',
  fredning = bygninger->0->>'byg036Fredning',
  bevaringsvaerdighed = (bygninger->0->>'byg038SAVE')::smallint,
  ejerforholdskode = bygninger->0->>'byg070Ejerforholdskode'
WHERE bygninger IS NOT NULL
  AND jsonb_array_length(bygninger) > 0
  AND antal_etager IS NULL;

-- Indekser for analyse og pivot
CREATE INDEX IF NOT EXISTS idx_bbr_tagmateriale
  ON public.bbr_ejendom_status (tagmateriale)
  WHERE tagmateriale IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bbr_varmeinstallation
  ON public.bbr_ejendom_status (varmeinstallation)
  WHERE varmeinstallation IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bbr_bevaringsvaerdi
  ON public.bbr_ejendom_status (bevaringsvaerdighed)
  WHERE bevaringsvaerdighed IS NOT NULL;
