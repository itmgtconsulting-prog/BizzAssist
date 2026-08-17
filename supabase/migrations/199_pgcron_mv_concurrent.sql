-- ============================================================
-- Migration 199: gendan CONCURRENTLY-refresh for pg_cron MV-jobs
-- BIZZ-2209 opfølgning (retter regression indført i mig 198).
--
-- Problem: mig 198 satte `statement_timeout=0` som et separat top-level
-- statement FØR refresh i cron-kommandoen (`SET ...; SELECT refresh(...)`).
-- Det slår 120s-timeren fra, MEN gør kommandoen til en multi-statement =
-- implicit transaktionsblok. `REFRESH MATERIALIZED VIEW CONCURRENTLY` er ikke
-- tilladt i en transaktionsblok → funktionen faldt tilbage til regular REFRESH,
-- som tager ACCESS EXCLUSIVE-lås og blokerer læsninger af MV'en under hele
-- refreshet (bekræftet i prod: mv_virksomhedshandel_kandidater ~118s lås).
--
-- Fix: sæt `statement_timeout=0` på pg_cron's eksekverings-rolle (`postgres`)
-- i stedet — så armes timeren ved 0 når det ENKELTE refresh-statement starter,
-- uden en forudgående SET. Cron-kommandoen bliver et rent single-statement
-- (egen implicit transaktion) → CONCURRENTLY er tilladt → zero-downtime refresh.
--
-- Bemærk om blast-radius: `postgres` er admin/superuser-rollen (Management API,
-- SQL-editor, pg_cron). App-trafik kører som authenticator→service_role/anon
-- (uændret, beholder egne timeouts). At fjerne 120s-loftet for admin-rollen er
-- en bevidst, defensibel konfiguration (admin/vedligehold + MV-refresh skal
-- kunne køre >120s). DB-default (120s) gælder fortsat alle andre roller.
-- ============================================================

-- 1. Fjern statement_timeout-loftet for pg_cron's eksekveringsrolle.
ALTER ROLE postgres SET statement_timeout = 0;

-- 2. Reschedulér de 11 MV-jobs som RENE single-statement kommandoer (ingen
--    SET-prefix) → CONCURRENTLY genaktiveres. Samme staggerede tider som 198.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobname FROM cron.job WHERE jobname LIKE 'mv-refresh-%' LOOP
    PERFORM cron.unschedule(r.jobname);
  END LOOP;
END $$;

SELECT cron.schedule('mv-refresh-analyse-ejendom',             '0 5 * * *',  $$SELECT public.refresh_materialized_view('mv_analyse_ejendom')$$);
SELECT cron.schedule('mv-refresh-ejendom-master',              '20 5 * * *', $$SELECT public.refresh_materialized_view('mv_ejendom_master')$$);
SELECT cron.schedule('mv-refresh-ejerskab-beriget',            '45 5 * * *', $$SELECT public.refresh_materialized_view('mv_ejerskab_beriget')$$);
SELECT cron.schedule('mv-refresh-boligpris-handler',           '20 6 * * *', $$SELECT public.refresh_materialized_view('mv_boligpris_handler')$$);
SELECT cron.schedule('mv-refresh-deltager-beriget',            '50 6 * * *', $$SELECT public.refresh_materialized_view('mv_deltager_beriget')$$);
SELECT cron.schedule('mv-refresh-virksomhedshandel-kandidater','20 7 * * *', $$SELECT public.refresh_materialized_view('mv_virksomhedshandel_kandidater')$$);
SELECT cron.schedule('mv-refresh-boligpris-maaned',            '40 7 * * *', $$SELECT public.refresh_materialized_view('mv_boligpris_maaned')$$);
SELECT cron.schedule('mv-refresh-virksomhed-struktur',         '50 7 * * *', $$SELECT public.refresh_materialized_view('mv_virksomhed_struktur')$$);
SELECT cron.schedule('mv-refresh-analyse-virksomhed',          '0 8 * * *',  $$SELECT public.refresh_materialized_view('mv_analyse_virksomhed')$$);
SELECT cron.schedule('mv-refresh-virksomhed-portefolje',       '5 8 * * *',  $$SELECT public.refresh_materialized_view('mv_virksomhed_portefolje')$$);
SELECT cron.schedule('mv-refresh-kommune-statistik',           '10 8 * * *', $$SELECT public.refresh_materialized_view('mv_kommune_statistik')$$);
