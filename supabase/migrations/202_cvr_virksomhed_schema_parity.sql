-- ============================================================
-- Migration 202: cvr_virksomhed skema-paritet (test/dev ⇄ prod)
-- BIZZ-2200.
--
-- PROD cvr_virksomhed har CVR-berigelses-kolonner som TEST (mangler 12) og DEV
-- (mangler 14) ikke har — ingestion/migration-drift. Kode der læser felterne
-- virker i prod men ikke i test/dev. Denne migration tilføjer kolonnerne med
-- prod-matchende typer (IF NOT EXISTS → no-op i prod, additiv/nullable → ingen
-- data-migrering nødvendig).
-- ============================================================

ALTER TABLE public.cvr_virksomhed
  ADD COLUMN IF NOT EXISTS bibranche1_kode      text,
  ADD COLUMN IF NOT EXISTS bibranche1_tekst     text,
  ADD COLUMN IF NOT EXISTS bibranche2_kode      text,
  ADD COLUMN IF NOT EXISTS bibranche2_tekst     text,
  ADD COLUMN IF NOT EXISTS bibranche3_kode      text,
  ADD COLUMN IF NOT EXISTS bibranche3_tekst     text,
  ADD COLUMN IF NOT EXISTS formaal              text,
  ADD COLUMN IF NOT EXISTS hvidvask_omfattet    boolean,
  ADD COLUMN IF NOT EXISTS regnskabsaar_start   smallint,
  ADD COLUMN IF NOT EXISTS regnskabsaar_slut    smallint,
  ADD COLUMN IF NOT EXISTS reklame_beskyttet    boolean,
  ADD COLUMN IF NOT EXISTS revision_fravalgt    boolean,
  ADD COLUMN IF NOT EXISTS penheder             jsonb,
  ADD COLUMN IF NOT EXISTS penheder_fetched_at  timestamptz;
