-- ============================================================
-- Migration 198: flyt tung MV-refresh til pg_cron (in-DB scheduler)
-- BIZZ-2209 opfølgning.
--
-- Problem: de 8 tunge materialized views (1.75M–6.9M rækker) kan ikke
-- refreshes inden for Vercel-funktionens 300s-loft. refresh-materialized-views
-- refresher de små hurtigt, rammer så en tung MV og bliver dræbt af Vercel før
-- den når igennem → tunge MV'er frøs (M&A-radaren 65 dage). Migration 197
-- fjernede 8s-statement-timeouten, men HTTP/300s-loftet er den reelle rest-årsag.
--
-- Fix: schedulér MV-refresh direkte i databasen via pg_cron. Ingen HTTP/300s-
-- loft; function-level statement_timeout=0 (mig. 197) gælder. Refresh sker
-- CONCURRENTLY så morgentrafik ikke blokeres. refresh_materialized_view()
-- opdaterer nu SELV data_sync_status (så både pg_cron og evt. andre kaldere
-- holder friskheds-sporingen korrekt). Vercel-ruten bliver en let verifier
-- (separat commit) der læser data_sync_status og kun rapporterer degraded hvis
-- pg_cron faktisk fejler — så watchdog-signalet bevares uden falske timeouts.
-- ============================================================

-- 1. pg_cron extension (Supabase-supporteret, default_version 1.6.4)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. refresh_materialized_view: opdatér data_sync_status som del af refresh.
--    Beholder whitelist + function-level timeouts fra mig. 197. Fejl re-raises
--    IKKE (så data_sync_status-rækken committer og verifieren kan læse fejlen);
--    en RAISE WARNING logges i stedet til Postgres-loggen.
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

-- 3. Ryd tidligere MV-cron-jobs (idempotent re-run) og schedulér på ny.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobname FROM cron.job
           WHERE jobname LIKE 'mv-refresh-%' OR jobname = 'mv-backfill-oneshot' LOOP
    PERFORM cron.unschedule(r.jobname);
  END LOOP;
END $$;

-- Daglige, staggerede refreshes (UTC). CONCURRENTLY → overlap-sikkert.
-- Spredt 05:00–08:10 UTC (efter det tunge 01:00–04:00 UTC data-sync-vindue).
SELECT cron.schedule('mv-refresh-analyse-ejendom',            '0 5 * * *',  $$SELECT public.refresh_materialized_view('mv_analyse_ejendom')$$);
SELECT cron.schedule('mv-refresh-ejendom-master',             '20 5 * * *', $$SELECT public.refresh_materialized_view('mv_ejendom_master')$$);
SELECT cron.schedule('mv-refresh-ejerskab-beriget',           '45 5 * * *', $$SELECT public.refresh_materialized_view('mv_ejerskab_beriget')$$);
SELECT cron.schedule('mv-refresh-boligpris-handler',          '20 6 * * *', $$SELECT public.refresh_materialized_view('mv_boligpris_handler')$$);
SELECT cron.schedule('mv-refresh-deltager-beriget',           '50 6 * * *', $$SELECT public.refresh_materialized_view('mv_deltager_beriget')$$);
SELECT cron.schedule('mv-refresh-virksomhedshandel-kandidater','20 7 * * *', $$SELECT public.refresh_materialized_view('mv_virksomhedshandel_kandidater')$$);
SELECT cron.schedule('mv-refresh-boligpris-maaned',           '40 7 * * *', $$SELECT public.refresh_materialized_view('mv_boligpris_maaned')$$);
SELECT cron.schedule('mv-refresh-virksomhed-struktur',        '50 7 * * *', $$SELECT public.refresh_materialized_view('mv_virksomhed_struktur')$$);
SELECT cron.schedule('mv-refresh-analyse-virksomhed',         '0 8 * * *',  $$SELECT public.refresh_materialized_view('mv_analyse_virksomhed')$$);
SELECT cron.schedule('mv-refresh-virksomhed-portefolje',      '5 8 * * *',  $$SELECT public.refresh_materialized_view('mv_virksomhed_portefolje')$$);
SELECT cron.schedule('mv-refresh-kommune-statistik',          '10 8 * * *', $$SELECT public.refresh_materialized_view('mv_kommune_statistik')$$);

-- 4. Engangs-backfill: refresh ALLE MV'er nu (in-DB, ingen tidsgrænse) og
--    afmeld derefter jobbet selv. Kører ved næste minut-boundary.
CREATE OR REPLACE FUNCTION public._backfill_all_mv_once()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v text;
  views text[] := ARRAY[
    'mv_analyse_virksomhed', 'mv_kommune_statistik', 'mv_virksomhed_portefolje',
    'mv_virksomhed_struktur', 'mv_boligpris_maaned', 'mv_virksomhedshandel_kandidater',
    'mv_ejendom_master', 'mv_analyse_ejendom', 'mv_deltager_beriget',
    'mv_boligpris_handler', 'mv_ejerskab_beriget'
  ];
BEGIN
  FOREACH v IN ARRAY views LOOP
    PERFORM public.refresh_materialized_view(v);
  END LOOP;
  PERFORM cron.unschedule('mv-backfill-oneshot');
END;
$function$;

SELECT cron.schedule('mv-backfill-oneshot', '* * * * *', $$SELECT public._backfill_all_mv_once()$$);
