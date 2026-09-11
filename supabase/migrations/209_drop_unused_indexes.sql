-- Migration 209: drop unused/duplicate indexes (BIZZ-2227)
--
-- DB perf-review 2026-09-05 (prod, PG 17.6): 3 store indexes med 0 scans spildte
-- ~1,16 GB og bremsede writes under den kørende TL-backfill. Prod blev droppet
-- MANUELT med DROP INDEX CONCURRENTLY (ingen lock). Denne migration er den
-- version-styrede record + bringer dev/test i sync (idempotent).
--
-- Droppet:
--   ix_ejf_ejerskifte_handelsoplys (580 MB) — EKSAKT DUPLIKAT af
--       ix_ejf_ejerskifte_handelsoplysninger (beholdt); begge 0 scans.
--   idx_cache_dar_gin (488 MB) — GIN på cache_dar.raw_data, 0 scans.
--   bbr_ejendom_status_adresse_idx (109 MB) — partial btree, 0 scans.
--
-- BEVIDST BEHOLDT (må IKKE droppes trods 0 idx_scan):
--   tinglysning_haeftelse_bfe_nummer_prioritet_status_key — UNIQUE CONSTRAINT
--       der backer ON CONFLICT (bfe_nummer, prioritet, status) i den aktive
--       TL-ingestion (tl-fast.mjs, backfill-tinglysning-full.mjs m.fl.). 0 scans
--       er misvisende: ON CONFLICT-håndhævelse tæller ikke som idx_scan.
--   idx_mv_analyse_ejendom_bfe, ux_mv_deltager_beriget_key — unique-indexes
--       krævet af REFRESH MATERIALIZED VIEW CONCURRENTLY.
--
-- Rollback (hvis en fremtidig query viser sig at bruge dem):
--   CREATE INDEX ix_ejf_ejerskifte_handelsoplys ON public.ejf_ejerskifte USING btree (handelsoplysninger_lokal_id) WHERE (handelsoplysninger_lokal_id IS NOT NULL);
--   CREATE INDEX idx_cache_dar_gin ON public.cache_dar USING gin (raw_data jsonb_path_ops);
--   CREATE INDEX bbr_ejendom_status_adresse_idx ON public.bbr_ejendom_status USING btree (adgangsadresse_id) WHERE (adgangsadresse_id IS NOT NULL);

DROP INDEX IF EXISTS public.ix_ejf_ejerskifte_handelsoplys;
DROP INDEX IF EXISTS public.idx_cache_dar_gin;
DROP INDEX IF EXISTS public.bbr_ejendom_status_adresse_idx;
