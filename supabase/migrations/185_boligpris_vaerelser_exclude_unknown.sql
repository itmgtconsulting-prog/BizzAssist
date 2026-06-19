-- 185_boligpris_vaerelser_exclude_unknown.sql
--
-- BIZZ-2181 / BIZZ-2171: Værelses-filter inkluderede handler uden reel
-- værelses-data. Tidligere brugte alle tre boligpris-RPC'er
-- `COALESCE(m.antal_vaerelser, 0) <= p_vaerelser_max`, hvilket lod rækker med
-- antal_vaerelser = NULL (ukendt) eller = 0 (sentinel, ingen BBR-værelsesdata)
-- passere et "max 2 værelser"-filter. På postnr 2500 (etagebolig, 12 mdr) var
-- 235 af 472 viste rækker (~50%) sådanne ukendt-værelser-rækker — brugeren
-- oplevede dem som "forkerte" handler (fx 3-4-værelses lejligheder iflg. BBR,
-- men uden værdi i mv_boligpris_handler).
--
-- Fix: når et værelses-filter er aktivt kræver vi en REEL værdi:
--   * min: `m.antal_vaerelser >= p_min` (NULL ekskluderes af NULL-sammenligning;
--     0 ekskluderes da p_min altid er ≥ 1).
--   * max: `m.antal_vaerelser > 0 AND m.antal_vaerelser <= p_max` (drop 0-sentinel
--     og NULL). COALESCE fjernes helt for værelser.
--
-- "Ukendt værelsesantal" matcher altså ikke længere et værelses-filter — det er
-- den korrekte semantik for et bounded filter. Arealet/byggeår/etager bevarer
-- deres eksisterende COALESCE-adfærd (uændret scope).
--
-- Alle tre funktioner (handler, aggregat, count) ændres identisk, så
-- KPI/graf/kommune-breakdown, "i alt"-badge og handler-listen dækker præcis
-- samme population.

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
  -- BIZZ-2181: reel værelses-værdi krævet når filter aktivt (ingen COALESCE).
  IF p_vaerelser_min <> 0 THEN
    v_where := v_where || format(' AND m.antal_vaerelser >= %s', p_vaerelser_min);
  END IF;
  IF p_vaerelser_max <> 0 THEN
    v_where := v_where || format(' AND m.antal_vaerelser > 0 AND m.antal_vaerelser <= %s', p_vaerelser_max);
  END IF;

  IF p_postnumre IS NOT NULL THEN
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

CREATE OR REPLACE FUNCTION public.boligpris_aggregat(
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
  p_postnumre text[] DEFAULT NULL::text[]
)
RETURNS TABLE(
  kommune_kode integer,
  maaned date,
  antal_handler integer,
  avg_pris numeric,
  avg_m2_pris numeric
)
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_where text;
  v_join  text := '';
  v_sql   text;
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
  -- BIZZ-2181: reel værelses-værdi krævet når filter aktivt (ingen COALESCE).
  IF p_vaerelser_min <> 0 THEN
    v_where := v_where || format(' AND m.antal_vaerelser >= %s', p_vaerelser_min);
  END IF;
  IF p_vaerelser_max <> 0 THEN
    v_where := v_where || format(' AND m.antal_vaerelser > 0 AND m.antal_vaerelser <= %s', p_vaerelser_max);
  END IF;

  IF p_postnumre IS NOT NULL THEN
    v_join := format(
      ' JOIN bfe_adresse_cache a ON m.bfe_nummer = a.bfe_nummer AND a.postnr = ANY(%L::text[])',
      p_postnumre
    );
  END IF;

  v_sql := format($q$
    SELECT
      m.kommune_kode::int                                   AS kommune_kode,
      date_trunc('month', m.overtagelsesdato)::date         AS maaned,
      count(*)::int                                         AS antal_handler,
      round(avg(m.samlet_koebesum))::numeric                AS avg_pris,
      COALESCE(round(avg(
        m.samlet_koebesum::numeric / NULLIF(m.samlet_boligareal, 0)
      ) FILTER (
        WHERE m.samlet_boligareal > 0
          AND m.samlet_koebesum::numeric / NULLIF(m.samlet_boligareal, 0) <= 200000
      )), 0)::numeric                                       AS avg_m2_pris
    FROM mv_boligpris_handler m%s
    WHERE %s
    GROUP BY 1, 2
  $q$, v_join, v_where);

  RETURN QUERY EXECUTE v_sql;
END;
$function$;

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
  -- BIZZ-2181: reel værelses-værdi krævet når filter aktivt (ingen COALESCE).
  IF p_vaerelser_min <> 0 THEN
    v_where := v_where || format(' AND m.antal_vaerelser >= %s', p_vaerelser_min);
  END IF;
  IF p_vaerelser_max <> 0 THEN
    v_where := v_where || format(' AND m.antal_vaerelser > 0 AND m.antal_vaerelser <= %s', p_vaerelser_max);
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
