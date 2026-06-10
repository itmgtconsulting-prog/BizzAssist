-- BIZZ-2056 (opfølgning): boligpris_handler timeoutede stadig for FILTREREDE
-- forespørgsler (fx Hvidovre + Etagebolig) trods den flade MV i migration 173.
--
-- Rod-årsag: funktionen var LANGUAGE sql med "kombi-guards" i WHERE:
--     (p_kommune_koder IS NULL OR m.kommune_kode = ANY(p_kommune_koder))
--     (p_boligtype_koder IS NULL OR m.byg021_anvendelse = ANY(p_boligtype_koder))
--     (p_areal_min = 0 OR ...)  osv.
-- Via PostgREST bindes parametrene, og efter få kald skifter Postgres til en
-- GENERISK plan. Den generiske plan kan ikke vide at fx p_kommune_koder ikke er
-- NULL, så OR-NULL-grenen gør prædikatet ikke-sargbart → composite-index'et
-- idx_mbh_kommune_type_dato kan ikke bruges. Planneren falder tilbage til en
-- dato-scan der filtrerer hver række → 6-8s for sparsomme kombinationer →
-- overskrider PostgRESTs ~8s statement_timeout → 57014 "statement timeout".
-- API'et fangede fejlen og udelod handler-tabellen (ingen "Seneste handler"-
-- linjer), og BIZZ-2056-retry'en gjorde det LANGSOMMERE (op til 3 × 8s).
--
-- Bevist: med faktiske værdier (custom plan) vælger planneren
-- idx_mbh_kommune_type_dato og kører på ~19 ms inkl. adresse-JOIN. Problemet er
-- udelukkende den generiske plan.
--
-- Fix: omskriv funktionen til LANGUAGE plpgsql med DYNAMISK SQL. Vi bygger kun de
-- WHERE-led der faktisk filtreres (ingen OR-NULL-guards) og kører via
-- RETURN QUERY EXECUTE. Dynamisk EXECUTE planlægges som en ENGANGS-plan ved hvert
-- kald med de faktiske værdier → altid custom plan → composite-index bruges →
-- millisekunder, uanset boligtype/kommune-kombination.
--
-- Sikkerhed: alle interpolerede værdier er stærkt typede af funktionens signatur
-- (integer[], date, integer) — de kan IKKE indeholde vilkårlig tekst, så der er
-- ingen SQL-injection-flade. Vi bruger format(%L) for korrekt litteral-kvotering.

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
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_where text;
  v_sql   text;
BEGIN
  -- Datointerval er altid med (overtagelsesdato er aldrig NULL i MV'en).
  v_where := format(
    'm.overtagelsesdato >= %L AND m.overtagelsesdato <= %L',
    p_fra, p_til
  );

  -- Kun de faktisk valgte filtre tilføjes → sargbare prædikater → index-brug.
  IF p_kommune_koder IS NOT NULL THEN
    v_where := v_where || format(' AND m.kommune_kode = ANY(%L::int[])', p_kommune_koder);
  END IF;
  IF p_boligtype_koder IS NOT NULL THEN
    v_where := v_where || format(' AND m.byg021_anvendelse = ANY(%L::int[])', p_boligtype_koder);
  END IF;
  IF p_areal_min <> 0 THEN
    v_where := v_where || format(' AND COALESCE(m.samlet_boligareal, 0) >= %s', p_areal_min);
  END IF;
  IF p_areal_max <> 0 THEN
    v_where := v_where || format(' AND COALESCE(m.samlet_boligareal, 0) <= %s', p_areal_max);
  END IF;
  IF p_byggear_min <> 0 THEN
    v_where := v_where || format(' AND COALESCE(m.opfoerelsesaar, 0) >= %s', p_byggear_min);
  END IF;
  IF p_byggear_max <> 0 THEN
    v_where := v_where || format(' AND COALESCE(m.opfoerelsesaar, 0) <= %s', p_byggear_max);
  END IF;

  -- Paginering på den flade MV (kun indekserede kolonner) → hurtig index-scan +
  -- early-stop. Adresse joines KUN på den returnerede side bagefter (PK-unik
  -- bfe_adresse_cache). ORDER BY DESC UDEN "NULLS LAST" — matcher index-retning.
  v_sql := format($q$
    WITH page AS (
      SELECT
        m.bfe_nummer,
        m.overtagelsesdato,
        m.samlet_koebesum,
        m.samlet_boligareal,
        m.byg021_anvendelse,
        m.opfoerelsesaar
      FROM mv_boligpris_handler m
      WHERE %s
      ORDER BY m.overtagelsesdato DESC, m.bfe_nummer DESC
      LIMIT %s OFFSET %s
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
  $q$, v_where, GREATEST(p_limit, 1), GREATEST(p_offset, 0));

  RETURN QUERY EXECUTE v_sql;
END;
$function$;
