-- ============================================================
-- Migration 115: ai_query_reader role + grants (BIZZ-1422)
-- ============================================================
-- Read-only DB-rolle som Smart SQL eksekverer under. Defense-in-depth
-- sammen med AST-validator (BIZZ-1424) og statement_timeout.
--
-- Tilladelser: SELECT på whitelistede tabeller i public + analyse-views.
-- Ingen INSERT/UPDATE/DELETE/TRUNCATE/DDL/DCL.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_query_reader') THEN
    CREATE ROLE ai_query_reader NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO ai_query_reader;
GRANT USAGE ON SCHEMA dataintel TO ai_query_reader;

-- Whitelistede tabeller (samme som analyseQueryWhitelist.ts).
-- Bruger DO-block der skipper tabeller der ikke eksisterer i target env
-- (dev mangler fx mv_analyse_*).
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'public.bbr_ejendom_status',
    'public.cvr_virksomhed',
    'public.cvr_virksomhed_ejerskab',
    'public.ejf_ejerskab',
    'public.regnskab_cache',
    'public.mv_analyse_ejendom',
    'public.mv_analyse_virksomhed',
    'public.vurdering_cache',
    'public.cvr_historik',
    'public.kommune_ref',
    'dataintel.data_catalog',
    'dataintel.analytics_knowledge'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON %s TO ai_query_reader', t);
    END IF;
  END LOOP;
END
$$;

-- Tillad service_role at switche til ai_query_reader via SET ROLE.
GRANT ai_query_reader TO service_role;
GRANT ai_query_reader TO authenticator;
GRANT ai_query_reader TO postgres;

COMMENT ON ROLE ai_query_reader IS
  'BIZZ-1422: Read-only rolle som Smart SQL eksekverer under. Kun SELECT på whitelistede tabeller.';
