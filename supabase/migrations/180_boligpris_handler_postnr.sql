-- BIZZ-2112: Postnr-filter for "Seneste handler" virkede ikke — postnumre blev
-- kun oversat til kommune_koder (BIZZ-2046), så filter "2500 Valby" viste hele
-- Københavns Kommune (2100/2720/2700) — og én korrupt bfe_adresse_cache-række
-- (postnr 2500 / kommune 0461) trak endda hele Odense Kommune ind.
--
-- Fix i denne migration:
--   1) boligpris_handler får p_postnumre text[] (default NULL). Når sat joines
--      bfe_adresse_cache IND I page-CTE'en med a.postnr = ANY(...) som eksakt
--      efterfiltrering. Den afledte kommune-prefiltrering (postnr→kommune i
--      API-routen) beholdes, så idx_mbh_kommune_type_dato stadig afgrænser
--      scanningen — postnr-filtret er kun en eksakt post-filtrering på join'en.
--      Uden p_postnumre er adfærden 100% uændret (LEFT JOIN efter pagination).
--   2) Ny boligpris_handler_count: capped antal af de FAKTISK filtrerede rækker,
--      så "i alt"-badgen kan matche listen når postnr-filter er aktivt (KPI'en
--      fra mv_boligpris_maaned er kommune-bucketed og kender ikke postnr).
--
-- Sikkerhed: alle interpolerede værdier kvoteres med format(%L) og er stærkt
-- typede arrays/datoer/integers fra funktionssignaturen — ingen injection-flade.

DROP FUNCTION IF EXISTS public.boligpris_handler(
  integer[], integer[], date, date, integer, integer, integer, integer,
  integer, integer, integer, integer, integer, integer
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
  p_etager_min integer DEFAULT 0,
  p_etager_max integer DEFAULT 0,
  p_vaerelser_min integer DEFAULT 0,
  p_vaerelser_max integer DEFAULT 0,
  p_postnumre text[] DEFAULT NULL::text[],
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
  antal_etager integer,
  antal_vaerelser integer,
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

  -- Kun de faktisk valgte filtre tilføjes → sargbare prædikater → index-brug
  -- (jf. migration 174: generisk plan med OR-NULL-guards dræbte index-brugen).
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
  IF p_etager_min <> 0 THEN
    v_where := v_where || format(' AND COALESCE(m.antal_etager, 0) >= %s', p_etager_min);
  END IF;
  IF p_etager_max <> 0 THEN
    v_where := v_where || format(' AND COALESCE(m.antal_etager, 0) <= %s', p_etager_max);
  END IF;
  IF p_vaerelser_min <> 0 THEN
    v_where := v_where || format(' AND COALESCE(m.antal_vaerelser, 0) >= %s', p_vaerelser_min);
  END IF;
  IF p_vaerelser_max <> 0 THEN
    v_where := v_where || format(' AND COALESCE(m.antal_vaerelser, 0) <= %s', p_vaerelser_max);
  END IF;

  IF p_postnumre IS NOT NULL THEN
    -- BIZZ-2112: eksakt postnr-filter — join'en SKAL ind i page-CTE'en, da
    -- filtret ellers ville ramme efter LIMIT og give for få/ingen rækker.
    -- Kommune-prefiltret (sat af API-routen) afgrænser fortsat index-scanningen.
    v_sql := format($q$
      SELECT
        m.bfe_nummer,
        m.overtagelsesdato,
        m.samlet_koebesum,
        m.samlet_boligareal,
        m.byg021_anvendelse,
        m.opfoerelsesaar,
        m.antal_etager,
        m.antal_vaerelser,
        a.adresse,
        a.postnr,
        a.postnrnavn,
        a.kommune
      FROM mv_boligpris_handler m
      JOIN bfe_adresse_cache a
        ON m.bfe_nummer = a.bfe_nummer
       AND a.postnr = ANY(%L::text[])
      WHERE %s
      ORDER BY m.overtagelsesdato DESC, m.bfe_nummer DESC
      LIMIT %s OFFSET %s
    $q$, p_postnumre, v_where, GREATEST(p_limit, 1), GREATEST(p_offset, 0));
  ELSE
    -- Uændret sti (migration 174/175): paginér på den flade MV, join adresse
    -- KUN på den returnerede side bagefter (PK-unik bfe_adresse_cache).
    v_sql := format($q$
      WITH page AS (
        SELECT
          m.bfe_nummer,
          m.overtagelsesdato,
          m.samlet_koebesum,
          m.samlet_boligareal,
          m.byg021_anvendelse,
          m.opfoerelsesaar,
          m.antal_etager,
          m.antal_vaerelser
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
        p.antal_etager,
        p.antal_vaerelser,
        a.adresse,
        a.postnr,
        a.postnrnavn,
        a.kommune
      FROM page p
      LEFT JOIN bfe_adresse_cache a ON p.bfe_nummer = a.bfe_nummer
      ORDER BY p.overtagelsesdato DESC, p.bfe_nummer DESC
    $q$, v_where, GREATEST(p_limit, 1), GREATEST(p_offset, 0));
  END IF;

  RETURN QUERY EXECUTE v_sql;
END;
$function$;

-- 2) Capped count af de faktisk filtrerede rækker — bruges til "i alt"-badgen
--    når postnr-filter er aktivt (kommune-KPI'en kan ikke postnr-filtreres).
--    Cappet (default 20000) så nationale forespørgsler aldrig kan timeoute.
CREATE OR REPLACE FUNCTION public.boligpris_handler_count(
  p_kommune_koder integer[] DEFAULT NULL::integer[],
  p_boligtype_koder integer[] DEFAULT NULL::integer[],
  p_fra date DEFAULT '2024-01-01'::date,
  p_til date DEFAULT CURRENT_DATE,
  p_areal_min integer DEFAULT 0,
  p_areal_max integer DEFAULT 0,
  p_byggear_min integer DEFAULT 0,
  p_byggear_max integer DEFAULT 0,
  p_etager_min integer DEFAULT 0,
  p_etager_max integer DEFAULT 0,
  p_vaerelser_min integer DEFAULT 0,
  p_vaerelser_max integer DEFAULT 0,
  p_postnumre text[] DEFAULT NULL::text[],
  p_cap integer DEFAULT 20000
)
RETURNS integer
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_where text;
  v_join  text := '';
  v_sql   text;
  v_count integer;
BEGIN
  v_where := format(
    'm.overtagelsesdato >= %L AND m.overtagelsesdato <= %L',
    p_fra, p_til
  );
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
  IF p_etager_min <> 0 THEN
    v_where := v_where || format(' AND COALESCE(m.antal_etager, 0) >= %s', p_etager_min);
  END IF;
  IF p_etager_max <> 0 THEN
    v_where := v_where || format(' AND COALESCE(m.antal_etager, 0) <= %s', p_etager_max);
  END IF;
  IF p_vaerelser_min <> 0 THEN
    v_where := v_where || format(' AND COALESCE(m.antal_vaerelser, 0) >= %s', p_vaerelser_min);
  END IF;
  IF p_vaerelser_max <> 0 THEN
    v_where := v_where || format(' AND COALESCE(m.antal_vaerelser, 0) <= %s', p_vaerelser_max);
  END IF;

  IF p_postnumre IS NOT NULL THEN
    v_join := format(
      ' JOIN bfe_adresse_cache a ON m.bfe_nummer = a.bfe_nummer AND a.postnr = ANY(%L::text[])',
      p_postnumre
    );
  END IF;

  v_sql := format(
    'SELECT count(*) FROM (SELECT 1 FROM mv_boligpris_handler m%s WHERE %s LIMIT %s) s',
    v_join, v_where, GREATEST(p_cap, 1)
  );

  EXECUTE v_sql INTO v_count;
  RETURN v_count;
END;
$function$;
