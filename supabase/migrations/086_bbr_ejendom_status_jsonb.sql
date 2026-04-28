-- BIZZ-1093: Udvid bbr_ejendom_status med fuld BBR data i JSONB kolonner
-- Eliminerer live Datafordeler GraphQL-kald for cached ejendomme.

-- Nye JSONB kolonner for fuld BBR-data
ALTER TABLE public.bbr_ejendom_status
  ADD COLUMN IF NOT EXISTS bygninger JSONB,
  ADD COLUMN IF NOT EXISTS enheder JSONB,
  ADD COLUMN IF NOT EXISTS jordstykker JSONB,
  ADD COLUMN IF NOT EXISTS tekniske_anlaeg JSONB,
  ADD COLUMN IF NOT EXISTS bbr_fetched_at TIMESTAMPTZ;

-- Index for at finde ejendomme der mangler fuld BBR-data (backfill)
CREATE INDEX IF NOT EXISTS idx_bbr_ejendom_status_bbr_stale
  ON public.bbr_ejendom_status (bbr_fetched_at)
  WHERE bygninger IS NULL AND is_udfaset = false;

COMMENT ON COLUMN public.bbr_ejendom_status.bygninger IS 'Fuld BBR bygningsdata som JSONB array — cached fra Datafordeler GraphQL';
COMMENT ON COLUMN public.bbr_ejendom_status.enheder IS 'BBR enheder (boliger/erhverv) som JSONB array';
COMMENT ON COLUMN public.bbr_ejendom_status.jordstykker IS 'Jordstykker med matrikelnr/ejerlav som JSONB array';
COMMENT ON COLUMN public.bbr_ejendom_status.tekniske_anlaeg IS 'Tekniske anlæg (solceller, varmepumper) som JSONB array';
COMMENT ON COLUMN public.bbr_ejendom_status.bbr_fetched_at IS 'Hvornår fuld BBR-data sidst blev hentet fra Datafordeler';
