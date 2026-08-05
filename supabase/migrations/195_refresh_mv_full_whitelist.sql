-- ============================================================
-- Migration 195: refresh_materialized_view — fuld whitelist + ingen timeout-cap
-- BIZZ-2209. Superseder migration 194 (som var ineffektiv: funktionens body
-- satte SET LOCAL statement_timeout='300000' der overstyrede function-level SET).
--
-- To fix:
--   1. Whitelist manglede 4 af de 11 MV'er cronen forsøger at refreshe
--      (mv_ejendom_master, mv_ejerskab_beriget, mv_virksomhed_struktur,
--      mv_deltager_beriget) → de fejlede altid med "not in whitelist".
--   2. SET LOCAL statement_timeout = '300000' (5 min) cappede store refreshes.
--      Sat til 0 (ubegrænset) så et langt REFRESH ikke dræbes DB-side.
--
-- Bemærk: Hvis M&A-radar-MV'et fortsat fryser, er rest-årsagen PostgREST/gateway
-- HTTP-timeout på selve RPC-kaldet (cronen venter på et fler-minutters refresh)
-- — dét kræver refresh via direkte pg-forbindelse eller pg_cron (opfølgning).
-- ============================================================

CREATE OR REPLACE FUNCTION public.refresh_materialized_view(view_name text)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
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
BEGIN
  IF NOT (view_name = ANY(allowed_views)) THEN
    RAISE EXCEPTION 'View "%" is not in the refresh whitelist', view_name;
  END IF;

  EXECUTE 'SET LOCAL statement_timeout = ''0''';   -- ubegrænset (var 5 min → cappede store MV'er)
  EXECUTE 'SET LOCAL lock_timeout = ''30000''';    -- 30s lock-wait

  BEGIN
    EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY public.%I', view_name);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'CONCURRENTLY failed for %, falling back to regular refresh: %', view_name, SQLERRM;
    EXECUTE format('REFRESH MATERIALIZED VIEW public.%I', view_name);
  END;
END;
$function$;
