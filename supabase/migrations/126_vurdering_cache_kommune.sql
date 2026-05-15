-- ============================================================================
-- 126: Tilføj kommune_kode til vurdering_cache — BIZZ-1469
-- Backfill fra bbr_ejendom_status via bfe_nummer join.
-- ============================================================================

ALTER TABLE public.vurdering_cache
  ADD COLUMN IF NOT EXISTS kommune_kode SMALLINT;

COMMENT ON COLUMN public.vurdering_cache.kommune_kode IS 'BIZZ-1469: Kommune fra BBR — backfilled via bfe_nummer join';

-- Backfill fra BBR
UPDATE public.vurdering_cache v
SET kommune_kode = b.kommune_kode
FROM public.bbr_ejendom_status b
WHERE b.bfe_nummer = v.bfe_nummer
  AND b.kommune_kode IS NOT NULL
  AND v.kommune_kode IS NULL;

-- Index for AI queries
CREATE INDEX IF NOT EXISTS idx_vurdering_cache_kommune
  ON public.vurdering_cache (kommune_kode)
  WHERE kommune_kode IS NOT NULL;
