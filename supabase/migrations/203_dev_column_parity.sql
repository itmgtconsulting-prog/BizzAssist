-- ============================================================
-- Migration 203: dev-kolonne-paritet (dev ⇄ test/prod)
-- BIZZ-2197.
--
-- DEV manglede 24 kolonner på 7 tabeller som test+prod har (migrationer ikke
-- kørt fuldt i dev). Tilføjer dem med prod-matchende typer (IF NOT EXISTS →
-- no-op hvor de findes, additiv/nullable → ingen data-migrering).
--
-- Bemærk: dev mangler også 13 TABELLER ift. prod (bl.a. person_cache,
-- tinglysning_*, user_session_preferences — samt junk-tabeller tmp_ejerforening_cvr
-- og tinglysning_backfill_probed der ikke bør replikeres). Tabel-paritet
-- håndteres separat (kræver DDL-replikering + junk-oprydning).
-- ============================================================

ALTER TABLE public.regnskab_cache
  ADD COLUMN IF NOT EXISTS seneste_aar         integer,
  ADD COLUMN IF NOT EXISTS omsaetning          bigint,
  ADD COLUMN IF NOT EXISTS bruttofortjeneste   bigint,
  ADD COLUMN IF NOT EXISTS resultat_foer_skat  bigint,
  ADD COLUMN IF NOT EXISTS aarsresultat        bigint,
  ADD COLUMN IF NOT EXISTS egenkapital         bigint,
  ADD COLUMN IF NOT EXISTS aktiver_i_alt       bigint,
  ADD COLUMN IF NOT EXISTS gaeld_i_alt         bigint,
  ADD COLUMN IF NOT EXISTS selskabskapital     bigint,
  ADD COLUMN IF NOT EXISTS antal_ansatte       integer;

ALTER TABLE public.bfe_adresse_cache
  ADD COLUMN IF NOT EXISTS next_retry_after    timestamptz;

ALTER TABLE public.forsikring_standard_doc
  ADD COLUMN IF NOT EXISTS version_group_id    uuid;

ALTER TABLE public.bbr_ejendom_status
  ADD COLUMN IF NOT EXISTS bygninger           jsonb,
  ADD COLUMN IF NOT EXISTS enheder             jsonb,
  ADD COLUMN IF NOT EXISTS jordstykker         jsonb,
  ADD COLUMN IF NOT EXISTS tekniske_anlaeg     jsonb,
  ADD COLUMN IF NOT EXISTS bbr_fetched_at      timestamptz,
  ADD COLUMN IF NOT EXISTS energimaerke_data   jsonb;

ALTER TABLE public.cvr_deltager
  ADD COLUMN IF NOT EXISTS antal_historiske_virksomheder integer,
  ADD COLUMN IF NOT EXISTS totalt_antal_roller integer;

ALTER TABLE public.service_manager_fixes
  ADD COLUMN IF NOT EXISTS applied_at          timestamptz,
  ADD COLUMN IF NOT EXISTS commit_sha          text;

ALTER TABLE public.ejerskifte_historik
  ADD COLUMN IF NOT EXISTS boligareal_m2       integer,
  ADD COLUMN IF NOT EXISTS m2_pris             integer;
