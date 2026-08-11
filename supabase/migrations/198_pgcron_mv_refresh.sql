-- ============================================================
-- Migration 198: flyt tung MV-refresh til pg_cron (in-DB scheduler)
-- BIZZ-2209 opfølgning.
--
-- Problem: de tunge materialized views (1.75M–6.9M rækker) kan ikke refreshes
-- inden for Vercel-funktionens 300s-loft. Desuden har databasen en default
-- statement_timeout på 120s. Migration 197 forsøgte at hæve loftet via en
-- function-level `SET statement_timeout=0` på refresh_materialized_view — men
-- det virker IKKE for lange refreshes: statement_timeout-timeren armes når
-- TOP-LEVEL-statementet (`SELECT refresh_materialized_view(...)`) starter, og en
-- funktions SET-clause kan ikke forlænge en allerede-armeret timer (samme
-- gotcha som SET LOCAL i mig. 195). Derfor cappede alle refreshes >120s stadig.
--
-- Fix: schedulér refresh via pg_cron INDE i databasen (intet HTTP/300s-loft), og
-- sæt `statement_timeout=0` som et SEPARAT top-level statement FØR refresh-kaldet
-- i selve cron-kommandoen. Så armes refreshens timer ved 0 → ingen 120s-cap.
-- Refresh sker CONCURRENTLY (morgentrafik blokeres ikke). refresh_materialized_view
-- opdaterer selv data_sync_status. Vercel-ruten er nu en let verifier (separat
-- commit) der læser data_sync_status og kun rapporterer degraded hvis pg_cron
-- faktisk fejler — watchdog-signalet bevares uden falske timeouts.
--
-- Bevist i dev: `SET statement_timeout TO '0'; SELECT pg_sleep(125)` fuldfører
-- (>120s default) — timeren armes ved 0 når SET er et separat top-level
-- statement.
--
-- Backfill af de aktuelt-forældede MV'er sker automatisk ved de daglige jobs'
-- første kørsel (05:00–08:10 UTC); ingen batch-one-shot her (den ville ramme
-- 120s-timeren pr. samlet transaktion og gen-fyre hvert minut).
-- ============================================================

-- 1. pg_cron extension (Supabase-supporteret, default_version 1.6.4)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. refresh_materialized_view: refresh CONCURRENTLY + opdatér data_sync_status.
--    Function-level statement_timeout=0 beholdes som defense-in-depth (dækker
--    kaldere der allerede kører uden 120s-cap), men den REELLE beskyttelse mod
--    120s-timeren er SET-prefixet i cron-kommandoen (punkt 3). Fejl re-raises
--    IKKE (så data_sync_status-rækken committer og verifieren kan læse fejlen).
CREATE OR REPLACE FUNCTION public.refresh_materialized_view(view_name text)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  SET statement_timeout TO '0'
  SET lock_timeout TO '30000'
AS $function$
DECLARE
  allowed_views TEXT[] := ARRAY[
    'mv_analyse_ejendom',
    'mv_analyse_virksomhed',
    'mv_ejendom_master',
    'mv_ejerskab_beriget',
    'mv_virksomhed_struktur',
    'mv_deltager_beriget',
    'mv_virksomhed_portefolje',
    'mv_kommune_statistik',
    'mv_boligpris_maaned',
    'mv_boligpris_handler',
    'mv_virksomhedshandel_kandidater'
  ];
  t0 timestamptz := clock_timestamp();
  dur_ms integer;
BEGIN
  IF NOT (view_name = ANY(allowed_views)) THEN
    RAISE EXCEPTION 'View "%" is not in the refresh whitelist', view_name;
  END IF;

  BEGIN
    BEGIN
      EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY public.%I', view_name);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'CONCURRENTLY failed for %, falling back to regular refresh: %', view_name, SQLERRM;
      EXECUTE format('REFRESH MATERIALIZED VIEW public.%I', view_name);
    END;

    dur_ms := (extract(epoch FROM clock_timestamp() - t0) * 1000)::int;
    INSERT INTO public.data_sync_status
      (source_name, last_sync_at, last_success, sync_duration_ms, last_error, updated_at)
    VALUES (view_name, now(), now(), dur_ms, NULL, now())
    ON CONFLICT (source_name) DO UPDATE SET
      last_sync_at     = excluded.last_sync_at,
      last_success     = excluded.last_success,
      sync_duration_ms = excluded.sync_duration_ms,
      last_error       = NULL,
      updated_at       = now();
  EXCEPTION WHEN OTHERS THEN
    -- Refresh fejlede: persistér fejlen (committer, da vi ikke re-raiser) så
    -- Vercel-verifieren + dashboardet fanger det.
    dur_ms := (extract(epoch FROM clock_timestamp() - t0) * 1000)::int;
    INSERT INTO public.data_sync_status
      (source_name, last_sync_at, sync_duration_ms, last_error, updated_at)
    VALUES (view_name, now(), dur_ms, SQLERRM, now())
    ON CONFLICT (source_name) DO UPDATE SET
      last_sync_at     = excluded.last_sync_at,
      sync_duration_ms = excluded.sync_duration_ms,
      last_error       = excluded.last_error,
      updated_at       = now();
    RAISE WARNING 'refresh_materialized_view(%) fejlede: %', view_name, SQLERRM;
  END;
END;
$function$;

-- Ryd et evt. tidligere (farligt) batch-one-shot fra en tidligere iteration.
DROP FUNCTION IF EXISTS public._backfill_all_mv_once();

-- 3. Ryd tidligere MV-cron-jobs (idempotent re-run) og schedulér på ny.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobname FROM cron.job
           WHERE jobname LIKE 'mv-refresh-%' OR jobname = 'mv-backfill-oneshot' LOOP
    PERFORM cron.unschedule(r.jobname);
  END LOOP;
END $$;

-- Daglige, staggerede refreshes (UTC). Hvert job sætter statement_timeout=0 som
-- SEPARAT top-level statement FØR refresh — så 120s-timeren aldrig armes for
-- selve refreshet. CONCURRENTLY → overlap-sikkert på tværs af forskellige MV'er.
-- Spredt 05:00–08:10 UTC (efter det tunge 01:00–04:00 UTC data-sync-vindue).
SELECT cron.schedule('mv-refresh-analyse-ejendom',             '0 5 * * *',  $$SET statement_timeout TO '0'; SELECT public.refresh_materialized_view('mv_analyse_ejendom')$$);
SELECT cron.schedule('mv-refresh-ejendom-master',              '20 5 * * *', $$SET statement_timeout TO '0'; SELECT public.refresh_materialized_view('mv_ejendom_master')$$);
SELECT cron.schedule('mv-refresh-ejerskab-beriget',            '45 5 * * *', $$SET statement_timeout TO '0'; SELECT public.refresh_materialized_view('mv_ejerskab_beriget')$$);
SELECT cron.schedule('mv-refresh-boligpris-handler',           '20 6 * * *', $$SET statement_timeout TO '0'; SELECT public.refresh_materialized_view('mv_boligpris_handler')$$);
SELECT cron.schedule('mv-refresh-deltager-beriget',            '50 6 * * *', $$SET statement_timeout TO '0'; SELECT public.refresh_materialized_view('mv_deltager_beriget')$$);
SELECT cron.schedule('mv-refresh-virksomhedshandel-kandidater','20 7 * * *', $$SET statement_timeout TO '0'; SELECT public.refresh_materialized_view('mv_virksomhedshandel_kandidater')$$);
SELECT cron.schedule('mv-refresh-boligpris-maaned',            '40 7 * * *', $$SET statement_timeout TO '0'; SELECT public.refresh_materialized_view('mv_boligpris_maaned')$$);
SELECT cron.schedule('mv-refresh-virksomhed-struktur',         '50 7 * * *', $$SET statement_timeout TO '0'; SELECT public.refresh_materialized_view('mv_virksomhed_struktur')$$);
SELECT cron.schedule('mv-refresh-analyse-virksomhed',          '0 8 * * *',  $$SET statement_timeout TO '0'; SELECT public.refresh_materialized_view('mv_analyse_virksomhed')$$);
SELECT cron.schedule('mv-refresh-virksomhed-portefolje',       '5 8 * * *',  $$SET statement_timeout TO '0'; SELECT public.refresh_materialized_view('mv_virksomhed_portefolje')$$);
SELECT cron.schedule('mv-refresh-kommune-statistik',           '10 8 * * *', $$SET statement_timeout TO '0'; SELECT public.refresh_materialized_view('mv_kommune_statistik')$$);
