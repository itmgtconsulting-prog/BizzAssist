-- ============================================================
-- Migration 197: refresh_materialized_view — function-level statement_timeout=0
-- BIZZ-2209. Retter regression fra migration 195.
--
-- Problem: 195 satte statement_timeout via `SET LOCAL` INDE i funktions-body'en.
-- SET LOCAL påvirker IKKE det allerede-kørende (kaldende) statement — det er en
-- kendt Postgres-gotcha — så REFRESH kørte fortsat under authenticator-rollens
-- 8s-timeout og ALLE 11 MV-refreshes fejlede med "canceling statement due to
-- statement timeout" (også de små MV'er). 195 slettede desuden migration 194's
-- virkende function-level SET (CREATE OR REPLACE nulstiller SET-clauses).
--
-- Fix: sæt statement_timeout på FUNKTIONS-niveau (SET-clause i headeren). Det
-- anvendes når funktionen entres og re-armer timeouten for funktionens varighed
-- (inkl. REFRESH) — modsat SET LOCAL i body. Behold whitelist (11 views) +
-- CONCURRENTLY-med-fallback.
--
-- Bemærk: hvis den STORE MV (mv_virksomhedshandel_kandidater, 1,75M) fortsat
-- fejler, er rest-årsagen PostgREST/gateway HTTP-timeout (RPC-kaldet venter for
-- længe) → kræver refresh via direkte pg-forbindelse/pg_cron (opfølgning). De
-- små MV'er (langt de fleste) optøjer under alle omstændigheder med denne fix.
-- ============================================================

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
BEGIN
  IF NOT (view_name = ANY(allowed_views)) THEN
    RAISE EXCEPTION 'View "%" is not in the refresh whitelist', view_name;
  END IF;

  BEGIN
    EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY public.%I', view_name);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'CONCURRENTLY failed for %, falling back to regular refresh: %', view_name, SQLERRM;
    EXECUTE format('REFRESH MATERIALIZED VIEW public.%I', view_name);
  END;
END;
$function$;
