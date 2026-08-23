-- ============================================================
-- Migration 200: unique indexes på MV'er → aktivér CONCURRENTLY-refresh
-- BIZZ-2209 opfølgning.
--
-- REFRESH MATERIALIZED VIEW CONCURRENTLY kræver et unique index på MV'en.
-- Før denne migration havde kun 4/11 MV'er et — de øvrige faldt tilbage til
-- regular REFRESH (ACCESS EXCLUSIVE-lås under refresh). Denne migration
-- tilføjer verificerede naturlige unik-nøgler til 4 yderligere MV'er, så de
-- fremover refresher CONCURRENTLY (zero-downtime) via pg_cron (mig 198/199).
--
-- Nøglerne er verificeret unikke i prod + test (count(*) == count(distinct key)).
--
-- Bruger IKKE CONCURRENTLY på selve CREATE INDEX (deploy-migrations kører hele
-- filen som én transaktion — CREATE INDEX CONCURRENTLY er ikke tilladt der).
-- Regular CREATE UNIQUE INDEX tager en kortvarig engangs-lås under build
-- (MV'erne er ≤2.6M rækker → sekunder). IF NOT EXISTS gør den idempotent.
--
-- IKKE dækket (kræver MV-redefinition med syntetisk nøgle — ægte dubletter):
--   mv_ejerskab_beriget (6.9M, ~559k dup-rækker)
--   mv_boligpris_handler (4.7M, ~294k dup-rækker)
--   mv_kommune_statistik (kun tiny; 15900 rk/99 kommuner ser mistænkelig ud)
-- → separat follow-up-ticket.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_ejendom_master_bfe
  ON public.mv_ejendom_master (bfe_nummer);

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_virksomhedshandel_kandidater_key
  ON public.mv_virksomhedshandel_kandidater
     (deltager_enhedsnummer, virksomhed_cvr, gyldig_fra, signal_type);

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_deltager_beriget_key
  ON public.mv_deltager_beriget
     (virksomhed_cvr, deltager_enhedsnummer, relation_type, gyldig_fra);

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_virksomhed_struktur_key
  ON public.mv_virksomhed_struktur
     (ejer_cvr, ejet_cvr, gyldig_fra, gyldig_til);
