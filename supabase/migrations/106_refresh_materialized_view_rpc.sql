-- ============================================================
-- Migration 106: RPC function for refreshing materialized views
-- BIZZ-1449: mv_analyse_ejendom (and others) never refreshed
-- because the RPC function called by
-- /api/cron/refresh-materialized-views did not exist.
--
-- Creates a SECURITY DEFINER function that only accepts
-- whitelisted view names to prevent injection.
-- ============================================================

CREATE OR REPLACE FUNCTION public.refresh_materialized_view(view_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  allowed_views TEXT[] := ARRAY[
    'mv_virksomhed_portefolje',
    'mv_kommune_statistik',
    'mv_analyse_ejendom',
    'mv_analyse_virksomhed'
  ];
BEGIN
  -- Whitelist check: only allow known view names (prevents SQL injection)
  IF NOT (view_name = ANY(allowed_views)) THEN
    RAISE EXCEPTION 'View "%" is not in the refresh whitelist', view_name;
  END IF;

  -- Allow up to 5 minutes for large MVs (mv_analyse_ejendom is 2.5M+ rows)
  EXECUTE 'SET LOCAL statement_timeout = ''300000''';  -- 5 min
  EXECUTE 'SET LOCAL lock_timeout = ''30000''';         -- 30s lock wait

  -- Try CONCURRENTLY first (allows reads during refresh, requires populated MV).
  -- If MV was created WITH NO DATA, CONCURRENTLY fails — fall back to regular refresh.
  BEGIN
    EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY public.%I', view_name);
  EXCEPTION WHEN OTHERS THEN
    -- Typically: "cannot refresh concurrently when the materialized view has not been populated"
    RAISE NOTICE 'CONCURRENTLY failed for %, falling back to regular refresh: %', view_name, SQLERRM;
    EXECUTE format('REFRESH MATERIALIZED VIEW public.%I', view_name);
  END;
END;
$$;

COMMENT ON FUNCTION public.refresh_materialized_view(TEXT) IS
  'BIZZ-1449: Safely refresh whitelisted materialized views. Called by /api/cron/refresh-materialized-views.';

-- Grant execute to service_role (used by admin client in cron route)
GRANT EXECUTE ON FUNCTION public.refresh_materialized_view(TEXT) TO service_role;
