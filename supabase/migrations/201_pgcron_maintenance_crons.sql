-- ============================================================
-- Migration 201: flyt purge-cron-history + backfill-ejerskifte-handel til pg_cron
-- BIZZ-2221.
--
-- Vercel eksekverer ikke alle 42 cron-definitioner (opfører sig som effektivt
-- cappet ~40 trods docs' 100) → de sidste crons i vercel.json (bl.a.
-- process-job-queue, purge-cron-history) fyrede aldrig, og
-- backfill-ejerskifte-handel fyrede ikke i 19 dage.
--
-- Fix: flyt de 2 pure-SQL-crons til pg_cron in-DB (ingen Vercel-limit). Det
-- frigør 2 Vercel-slots så process-job-queue igen kommer inden for cap'en og
-- eksekveres af Vercel. Funktionerne skriver selv cron_heartbeats (success/
-- error via EXCEPTION-handler i egen subtransaktion) så watchdoggen fortsat
-- overvåger dem via registry-posten (scheduler:'pgcron').
--
-- Kører som postgres (pg_cron) med statement_timeout=0 (mig 199) → intet
-- 75s SQL-runner-loft som HTTP-ruterne havde.
-- ============================================================

-- 1. purge-cron-history: slet cron_run_history > 90 dage + heartbeat.
CREATE OR REPLACE FUNCTION public.cron_purge_history()
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE n int; t0 timestamptz := clock_timestamp();
BEGIN
  DELETE FROM public.cron_run_history WHERE run_at < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO public.cron_heartbeats
    (job_name, last_run_at, last_status, expected_interval_minutes,
     last_duration_ms, last_items_processed, last_items_written, last_error, updated_at)
  VALUES ('purge-cron-history', now(), 'success', 1440,
          (extract(epoch FROM clock_timestamp() - t0) * 1000)::int, n, n, NULL, now())
  ON CONFLICT (job_name) DO UPDATE SET
    last_run_at = now(), last_status = 'success',
    last_duration_ms = excluded.last_duration_ms,
    last_items_processed = excluded.last_items_processed,
    last_items_written = excluded.last_items_written,
    last_error = NULL, updated_at = now();
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.cron_heartbeats
    (job_name, last_run_at, last_status, expected_interval_minutes, last_error, updated_at)
  VALUES ('purge-cron-history', now(), 'error', 1440, SQLERRM, now())
  ON CONFLICT (job_name) DO UPDATE SET
    last_run_at = now(), last_status = 'error', last_error = SQLERRM, updated_at = now();
END;
$function$;

-- 2. backfill-ejerskifte-handel: indsæt manglende EJF-handler (180-dages vindue)
--    + heartbeat. Samme SQL som app/api/cron/backfill-ejerskifte-handel/route.ts.
CREATE OR REPLACE FUNCTION public.cron_backfill_ejerskifte_handel()
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE n int; t0 timestamptz := clock_timestamp();
BEGIN
  WITH inserted AS (
    INSERT INTO public.ejerskifte_historik
      (bfe_nummer, overtagelsesdato, kontant_koebesum, i_alt_koebesum,
       koebsaftale_dato, kommune_kode, byg021_anvendelse, kilde, historisk_kilde)
    SELECT DISTINCT ON (e.bfe_nummer, e.overtagelsesdato::date)
      e.bfe_nummer, e.overtagelsesdato::date, h.kontant_koebesum,
      COALESCE(h.samlet_koebesum, h.kontant_koebesum), h.koebsaftale_dato,
      b.kommune_kode, b.byg021_anvendelse, 'ejf_handel', 'ejf_handel'
    FROM public.ejf_ejerskifte e
    JOIN public.ejf_handelsoplysninger h ON h.id_lokal_id = e.handelsoplysninger_lokal_id
    JOIN public.bbr_ejendom_status b ON b.bfe_nummer = e.bfe_nummer
    WHERE COALESCE(h.samlet_koebesum, h.kontant_koebesum) > 0
      AND e.overtagelsesdato IS NOT NULL
      AND e.overtagelsesdato >= (CURRENT_DATE - INTERVAL '180 days')
      AND NOT EXISTS (
        SELECT 1 FROM public.ejerskifte_historik eh
        WHERE eh.bfe_nummer = e.bfe_nummer
          AND eh.overtagelsesdato = e.overtagelsesdato::date)
    ORDER BY e.bfe_nummer, e.overtagelsesdato::date,
             COALESCE(h.samlet_koebesum, h.kontant_koebesum) DESC
    RETURNING 1)
  SELECT count(*)::int INTO n FROM inserted;

  INSERT INTO public.cron_heartbeats
    (job_name, last_run_at, last_status, expected_interval_minutes,
     last_duration_ms, last_items_processed, last_items_written, last_error, updated_at)
  VALUES ('backfill-ejerskifte-handel', now(), 'success', 1440,
          (extract(epoch FROM clock_timestamp() - t0) * 1000)::int, n, n, NULL, now())
  ON CONFLICT (job_name) DO UPDATE SET
    last_run_at = now(), last_status = 'success',
    last_duration_ms = excluded.last_duration_ms,
    last_items_processed = excluded.last_items_processed,
    last_items_written = excluded.last_items_written,
    last_error = NULL, updated_at = now();
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.cron_heartbeats
    (job_name, last_run_at, last_status, expected_interval_minutes, last_error, updated_at)
  VALUES ('backfill-ejerskifte-handel', now(), 'error', 1440, SQLERRM, now())
  ON CONFLICT (job_name) DO UPDATE SET
    last_run_at = now(), last_status = 'error', last_error = SQLERRM, updated_at = now();
END;
$function$;

-- 3. Schedulér i pg_cron (idempotent re-schedule).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobname FROM cron.job
           WHERE jobname IN ('cron-purge-history', 'cron-backfill-ejerskifte-handel') LOOP
    PERFORM cron.unschedule(r.jobname);
  END LOOP;
END $$;

SELECT cron.schedule('cron-purge-history',              '20 2 * * *', $$SELECT public.cron_purge_history()$$);
SELECT cron.schedule('cron-backfill-ejerskifte-handel', '20 6 * * *', $$SELECT public.cron_backfill_ejerskifte_handel()$$);
