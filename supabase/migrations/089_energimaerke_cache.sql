-- BIZZ-1096: Cache energimærke-data i bbr_ejendom_status
-- Undgår live EMO API-kald per ejendom.

ALTER TABLE public.bbr_ejendom_status
  ADD COLUMN IF NOT EXISTS energimaerke_data JSONB;

COMMENT ON COLUMN public.bbr_ejendom_status.energimaerke_data IS 'BIZZ-1096: Fuld EMO data (klasse, gyldigFra, gyldigTil, pdfId) — cached fra emoweb.dk';

-- Index for ejendomme der mangler energimærke-data (backfill)
CREATE INDEX IF NOT EXISTS idx_bbr_energimaerke_missing
  ON public.bbr_ejendom_status (bfe_nummer)
  WHERE energimaerke IS NOT NULL AND energimaerke_data IS NULL AND is_udfaset = false;
