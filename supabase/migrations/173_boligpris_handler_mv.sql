-- BIZZ-2056: Boligpris-handler-tabel — performance + KPI-match via flat MV.
--
-- Problem (efter migration 171): boligpris_handler RPC læste direkte fra
-- v_ejerskifte_handel (en view over ejf_ejerskifte = 7,7 mio. rækker JOIN
-- ejf_handelsoplysninger). For landsdækkende/ufiltrerede forespørgsler (default
-- dashboard-load = alle boligtyper, alle kommuner) tvang COUNT(*) OVER() en fuld
-- materialisering af ~5,4 mio. join-rækker → 20-50s eksekvering, hvilket
-- overskrider PostgRESTs ~8s statement_timeout. Resultat: RPC'en timeoutede og
-- API'et returnerede ingen handler ved default-load (regression).
--
-- Fix: pre-aggregér de individuelle handler i en flad, indekseret materialized
-- view bygget fra PRÆCIS samme rækkepopulation som mv_boligpris_maaned (KPI'en):
--   v_ejerskifte_handel JOIN bbr_ejendom_status, WHERE samlet_koebesum > 0
--   AND overtagelsesdato IS NOT NULL AND kommune_kode IS NOT NULL.
-- Da KPI-MV'en bruger count(*) over nøjagtig samme join (ingen DISTINCT),
-- giver count af denne handler-MV pr. kommune/boligtype/måned GARANTERET samme
-- antal som mv_boligpris_maaned.antal_handler — på alle granulariteter, også
-- landsdækkende. RPC'en læser nu fra MV'en (flad tabel + indeks) i stedet for
-- 7,7M-rækkers view-join → millisekunder i stedet for sekunder.

-- 1) Flad handler-MV (lean — adresse joines på query-tid via PK-unik cache)
DROP MATERIALIZED VIEW IF EXISTS public.mv_boligpris_handler;
CREATE MATERIALIZED VIEW public.mv_boligpris_handler AS
SELECT
  h.bfe_nummer::int                        AS bfe_nummer,
  (h.overtagelsesdato)::date               AS overtagelsesdato,
  h.samlet_koebesum::bigint                AS samlet_koebesum,
  b.samlet_boligareal::int                 AS samlet_boligareal,
  b.byg021_anvendelse::int                 AS byg021_anvendelse,
  b.opfoerelsesaar::int                    AS opfoerelsesaar,
  b.kommune_kode::int                      AS kommune_kode
FROM v_ejerskifte_handel h
JOIN bbr_ejendom_status b ON h.bfe_nummer = b.bfe_nummer
WHERE h.samlet_koebesum > 0
  AND h.overtagelsesdato IS NOT NULL
  AND b.kommune_kode IS NOT NULL;

-- 2) Indeks til hurtige filter/sortering. Dækker de typiske query-stier:
--    (kommune + boligtype + dato), (boligtype + dato), (dato alene).
CREATE INDEX idx_mbh_kommune_type_dato
  ON public.mv_boligpris_handler (kommune_kode, byg021_anvendelse, overtagelsesdato DESC);
CREATE INDEX idx_mbh_type_dato
  ON public.mv_boligpris_handler (byg021_anvendelse, overtagelsesdato DESC);
CREATE INDEX idx_mbh_dato
  ON public.mv_boligpris_handler (overtagelsesdato DESC);
-- Unik-indeks muliggør REFRESH ... CONCURRENTLY (læsninger uafbrudt under refresh).
-- (bfe, dato, koebesum) er ikke garanteret unik (samme ejendom kan handles flere
-- gange på samme dato til samme sum i teorien); tilføj ctid-lignende surrogate via
-- row_number er ikke muligt i MV. Vi springer CONCURRENTLY over og bruger almindelig
-- REFRESH (kort læselås i dagligt job — acceptabelt, jf. mv_virksomhedshandel_kandidater).

-- 3) RPC læser nu fra den flade MV. Returnerer KUN sidens rækker (ingen
--    vindues-COUNT). Det samlede antal ("i alt"/badge) tager API'et fra KPI'en
--    (mv_boligpris_maaned, noegletal.antal_handler) — samme tal brugeren ser i
--    KPI-kortet, og hurtigt på alle granulariteter. En vindues-COUNT over hele
--    den landsdækkende delmængde (~138k rækker) var ustabil (1-13s) og kunne
--    overskride PostgRESTs ~8s timeout; den er derfor fjernet.
--
--    VIGTIGT: ORDER BY overtagelsesdato DESC UDEN "NULLS LAST". Index'et
--    idx_mbh_dato er DESC (= NULLS FIRST); "NULLS LAST" ville bryde index-brug
--    og tvinge en fuld sortering af ~138k rækker (13s). overtagelsesdato er
--    aldrig NULL i MV'en (filtreret væk), så NULLS-rækkefølgen er ligegyldig.
DROP FUNCTION IF EXISTS public.boligpris_handler(
  integer[], integer[], date, date, integer, integer, integer, integer, integer, integer
);

CREATE OR REPLACE FUNCTION public.boligpris_handler(
  p_kommune_koder integer[] DEFAULT NULL::integer[],
  p_boligtype_koder integer[] DEFAULT NULL::integer[],
  p_fra date DEFAULT '2024-01-01'::date,
  p_til date DEFAULT CURRENT_DATE,
  p_areal_min integer DEFAULT 0,
  p_areal_max integer DEFAULT 0,
  p_byggear_min integer DEFAULT 0,
  p_byggear_max integer DEFAULT 0,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  bfe_nummer integer,
  overtagelsesdato date,
  samlet_koebesum bigint,
  samlet_boligareal integer,
  byg021_anvendelse integer,
  opfoerelsesaar integer,
  adresse text,
  postnr text,
  postnrnavn text,
  kommune text
)
LANGUAGE sql
STABLE
AS $function$
  -- Paginering på den flade MV (kun indekserede kolonner, ingen joins) → hurtig
  -- index-scan + early-stop. Adresse joines KUN på den returnerede side bagefter
  -- (PK-unik bfe_adresse_cache).
  WITH page AS (
    SELECT
      m.bfe_nummer,
      m.overtagelsesdato,
      m.samlet_koebesum,
      m.samlet_boligareal,
      m.byg021_anvendelse,
      m.opfoerelsesaar
    FROM mv_boligpris_handler m
    WHERE m.overtagelsesdato >= p_fra
      AND m.overtagelsesdato <= p_til
      AND (p_kommune_koder IS NULL OR m.kommune_kode = ANY(p_kommune_koder))
      AND (p_boligtype_koder IS NULL OR m.byg021_anvendelse = ANY(p_boligtype_koder))
      AND (p_areal_min = 0 OR COALESCE(m.samlet_boligareal, 0) >= p_areal_min)
      AND (p_areal_max = 0 OR COALESCE(m.samlet_boligareal, 0) <= p_areal_max)
      AND (p_byggear_min = 0 OR COALESCE(m.opfoerelsesaar, 0) >= p_byggear_min)
      AND (p_byggear_max = 0 OR COALESCE(m.opfoerelsesaar, 0) <= p_byggear_max)
    ORDER BY m.overtagelsesdato DESC, m.bfe_nummer DESC
    LIMIT p_limit OFFSET p_offset
  )
  SELECT
    p.bfe_nummer,
    p.overtagelsesdato,
    p.samlet_koebesum,
    p.samlet_boligareal,
    p.byg021_anvendelse,
    p.opfoerelsesaar,
    a.adresse,
    a.postnr,
    a.postnrnavn,
    a.kommune
  FROM page p
  LEFT JOIN bfe_adresse_cache a ON p.bfe_nummer = a.bfe_nummer
  ORDER BY p.overtagelsesdato DESC, p.bfe_nummer DESC
$function$;

-- 4) Tilføj begge boligpris-MV'er til refresh-whitelisten. mv_boligpris_maaned lå
--    i cron-VIEWS-arrayet men IKKE i whitelisten → den fejlede ved hvert refresh
--    ("not in whitelist") og KPI-tallene frøs. Rettes her sammen med den nye MV.
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
    'mv_analyse_virksomhed',
    'mv_virksomhedshandel_kandidater',
    'mv_boligpris_maaned',
    'mv_boligpris_handler'
  ];
BEGIN
  IF NOT (view_name = ANY(allowed_views)) THEN
    RAISE EXCEPTION 'View "%" is not in the refresh whitelist', view_name;
  END IF;

  EXECUTE 'SET LOCAL statement_timeout = ''300000''';  -- 5 min
  EXECUTE 'SET LOCAL lock_timeout = ''30000''';         -- 30s lock wait

  BEGIN
    EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY public.%I', view_name);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'CONCURRENTLY failed for %, falling back to regular refresh: %', view_name, SQLERRM;
    EXECUTE format('REFRESH MATERIALIZED VIEW public.%I', view_name);
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_materialized_view(TEXT) TO service_role;
