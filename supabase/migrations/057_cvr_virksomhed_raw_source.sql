-- ============================================================
-- Migration 057: tilføj raw_source til cvr_virksomhed
-- BIZZ-652: For at cache-first runtime kan levere 100% samme response
-- som live-ES (bruger eksisterende mapESHit), gemmer vi hele ES _source
-- i et JSONB-felt. UI-kontrakter berøres ikke — samme mapESHit parser
-- begge paths.
-- ============================================================

ALTER TABLE public.cvr_virksomhed
  ADD COLUMN IF NOT EXISTS raw_source JSONB;

-- Backfill-protection: eksisterende rows (fra migration 054) har ikke
-- raw_source; de rammer cache-miss og fetches live → upsert inkl raw_source.
