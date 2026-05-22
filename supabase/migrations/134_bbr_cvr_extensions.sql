-- ============================================================================
-- 134: bbr_ejendom_status + cvr_deltager udvidelser — BIZZ-1566 Backfill 5+6
--
-- Tilføjer denormaliserede kolonner til DI v2 metric-katalog.
-- ============================================================================

-- Backfill 5: bbr_ejendom_status udvidelse
ALTER TABLE public.bbr_ejendom_status
  ADD COLUMN IF NOT EXISTS ejendomstype_norm TEXT
    CHECK (ejendomstype_norm IS NULL OR ejendomstype_norm IN (
      'parcelhus','raekkehus','ejerlejlighed','sommerhus',
      'erhverv','landbrug','kolonihave','andet'
    ));

ALTER TABLE public.bbr_ejendom_status
  ADD COLUMN IF NOT EXISTS zone TEXT
    CHECK (zone IS NULL OR zone IN ('byzone','landzone','sommerhuszone'));

CREATE INDEX IF NOT EXISTS ix_bbr_ejendomstype ON public.bbr_ejendom_status(ejendomstype_norm)
  WHERE ejendomstype_norm IS NOT NULL;

COMMENT ON COLUMN public.bbr_ejendom_status.ejendomstype_norm IS 'Denormaliseret ejendomstype fra BBR-kategori. BIZZ-1566.';
COMMENT ON COLUMN public.bbr_ejendom_status.zone IS 'Planzone: byzone/landzone/sommerhuszone. BIZZ-1566.';

-- Backfill 6: cvr_deltager udvidelse
ALTER TABLE public.cvr_deltager
  ADD COLUMN IF NOT EXISTS bopaelsland TEXT;

ALTER TABLE public.cvr_deltager
  ADD COLUMN IF NOT EXISTS er_levende BOOLEAN;

ALTER TABLE public.cvr_deltager
  ADD COLUMN IF NOT EXISTS foedselsaar INTEGER;

CREATE INDEX IF NOT EXISTS ix_deltager_bopaelsland ON public.cvr_deltager(bopaelsland)
  WHERE bopaelsland IS NOT NULL;

COMMENT ON COLUMN public.cvr_deltager.bopaelsland IS 'ISO-landekode fra CVR ES. Bruges af DI v2 dim ejer_land. BIZZ-1566.';
COMMENT ON COLUMN public.cvr_deltager.er_levende IS 'false hvis afdød. Fra CVR ES. BIZZ-1566.';
COMMENT ON COLUMN public.cvr_deltager.foedselsaar IS 'Kun år, ikke fuld dato — PII-minimering. BIZZ-1566.';
