-- BIZZ-2056: Boligpris-dashboard — handler-tabel skal matche KPI/MV antal handler.
--
-- Problem: boligpris_handler RPC læste fra ejerskifte_historik (kolonne
-- i_alt_koebesum), mens mv_boligpris_maaned (KPI/Top-kommuner/chart) læser fra
-- v_ejerskifte_handel (kolonne samlet_koebesum). De to kilder har vidt forskellig
-- BBR-join-dækning, så "Seneste handler" viste fx 17-19 rækker hvor KPI'en talte
-- 97-107 handler.
--
-- Fix: RPC læser nu fra SAMME kilde som MV (v_ejerskifte_handel JOIN
-- bbr_ejendom_status, samlet_koebesum > 0, kommune_kode NOT NULL), uden DISTINCT ON
-- (MV bruger count(*)). Returnerer desuden total_count via window-funktion, så
-- API'et kan vise et ægte total og understøtte "vælg alle + Excel-eksport".

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
  kommune text,
  total_count bigint
)
LANGUAGE sql
STABLE
AS $function$
  SELECT
    h.bfe_nummer::int,
    h.overtagelsesdato::date,
    h.samlet_koebesum::bigint,
    b.samlet_boligareal::int,
    b.byg021_anvendelse::int,
    b.opfoerelsesaar::int,
    a.adresse,
    a.postnr,
    a.postnrnavn,
    a.kommune,
    COUNT(*) OVER()::bigint AS total_count
  FROM v_ejerskifte_handel h
  JOIN bbr_ejendom_status b ON h.bfe_nummer = b.bfe_nummer
  LEFT JOIN bfe_adresse_cache a ON h.bfe_nummer = a.bfe_nummer
  WHERE h.samlet_koebesum > 0
    AND h.overtagelsesdato::date >= p_fra
    AND h.overtagelsesdato::date <= p_til
    AND b.kommune_kode IS NOT NULL
    AND (p_kommune_koder IS NULL OR b.kommune_kode = ANY(p_kommune_koder))
    AND (p_boligtype_koder IS NULL OR b.byg021_anvendelse = ANY(p_boligtype_koder))
    AND (p_areal_min = 0 OR COALESCE(b.samlet_boligareal, 0) >= p_areal_min)
    AND (p_areal_max = 0 OR COALESCE(b.samlet_boligareal, 0) <= p_areal_max)
    AND (p_byggear_min = 0 OR COALESCE(b.opfoerelsesaar, 0) >= p_byggear_min)
    AND (p_byggear_max = 0 OR COALESCE(b.opfoerelsesaar, 0) <= p_byggear_max)
  ORDER BY h.overtagelsesdato::date DESC NULLS LAST, h.bfe_nummer
  LIMIT p_limit OFFSET p_offset
$function$;
