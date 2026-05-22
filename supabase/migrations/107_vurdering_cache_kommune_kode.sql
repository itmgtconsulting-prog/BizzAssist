-- ============================================================================
-- 107_vurdering_cache_kommune_kode.sql — BIZZ-1450
-- ============================================================================
-- Tilføj kommune_kode til vurdering_cache så AI kan lave
-- "vurdering per kommune" queries uden JOINs.
-- Backfill fra bbr_ejendom_status via bfe_nummer.
-- ============================================================================

ALTER TABLE public.vurdering_cache
  ADD COLUMN IF NOT EXISTS kommune_kode SMALLINT;

COMMENT ON COLUMN public.vurdering_cache.kommune_kode IS
  'BIZZ-1450: Kommunekode fra BBR (backfilled via bbr_ejendom_status.kommune_kode)';

-- Backfill kommune_kode fra bbr_ejendom_status
UPDATE public.vurdering_cache v
SET kommune_kode = b.kommune_kode
FROM public.bbr_ejendom_status b
WHERE v.bfe_nummer = b.bfe_nummer
  AND v.kommune_kode IS NULL
  AND b.kommune_kode IS NOT NULL;

-- Index for kommune-baseret vurderings-analyse
CREATE INDEX IF NOT EXISTS idx_vurdering_cache_kommune
  ON public.vurdering_cache (kommune_kode)
  WHERE kommune_kode IS NOT NULL;
