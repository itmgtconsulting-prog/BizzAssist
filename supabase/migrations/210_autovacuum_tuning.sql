-- Migration 210: autovacuum-tuning + ANALYZE på høj-churn tabeller (BIZZ-2230)
--
-- DB perf-review 2026-09-05 (prod): cache_dar's planner-statistik sagde
-- n_live_tup=0 mens tabellen har 1,9M rækker (autoanalyze var aldrig kørt) →
-- risiko for elendige query-planer. Desuden høje dead tuples på de store
-- delta-synkede tabeller (cvr_deltagerrelation 1,57M/17%, autoanalyze 12 dage
-- gammel) fordi default autovacuum_*_scale_factor (0.1/0.05) først trigger ved
-- ~10%/5% af mange-millioner-rækker.
--
-- Fix: sænk scale-factors på høj-churn tabellerne så autovacuum/autoanalyze
-- kører oftere → færre dead tuples + friskere planner-statistik. + engangs
-- ANALYZE nu. Alt er sikkert (non-locking) og reversibelt (RESET).

-- Tættere autovacuum/autoanalyze på store, konstant-skrevne tabeller.
ALTER TABLE public.cvr_deltagerrelation
  SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
ALTER TABLE public.cvr_deltager
  SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
ALTER TABLE public.ejf_ejerskifte
  SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
ALTER TABLE public.cvr_virksomhed
  SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
-- cache_dar auto-analyseredes aldrig (bulk-loadet, lav churn indtil DAR-delta-
-- fixet i BIZZ-2233 begynder at skrive) → sørg for friske stats fremover.
ALTER TABLE public.cache_dar
  SET (autovacuum_analyze_scale_factor = 0.05);

-- Engangs friske stats (autovacuum tager resten løbende).
ANALYZE public.cache_dar;
ANALYZE public.cvr_deltagerrelation;
ANALYZE public.ejf_ejerskifte;
