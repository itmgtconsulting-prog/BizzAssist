-- 187_boligpris_pris_filter.sql
--
-- BIZZ-2186: Tilføj købspris-filter (min/max) til Boligpris-dashboardet.
-- Brugeren kunne ikke afgrænse handler til et prissegment (fx 2-5 mio kr), så
-- KPI/graf blev forurenet af outliers (0kr-familieoverdragelser, 50+ mio luksus).
--
-- De tre boligpris-RPC'er (handler, aggregat, count) får to nye parametre,
-- p_pris_min og p_pris_max (kroner, bigint), som filtrerer på m.samlet_koebesum.
-- Når ENTEN min eller max er sat, ekskluderes 0kr-handler eksplicit (de er
-- fejlregistreringer/familieoverdragelser, ikke reelle markedshandler) — så et
-- rent max-filter ikke utilsigtet trækker 0kr-rækker ind.
--
-- VIGTIGT: at tilføje parametre skaber en NY funktions-overload i Postgres
-- (CREATE OR REPLACE matcher kun samme argument-signatur). To overloads ville
-- gøre PostgREST's funktionsvalg tvetydigt ("could not choose best candidate"),
-- så de gamle 13/14/15-argument-signaturer DROPPES eksplicit først.
--
-- Værelses-semantikken fra migration 185 (reel værdi krævet, ingen COALESCE)
-- bevares uændret i alle tre funktioner.

DROP FUNCTION IF EXISTS public.boligpris_handler(
  integer[], integer[], date, date, integer, integer, integer, integer,
  integer, integer, integer, integer, text[], integer, integer
);
DROP FUNCTION IF EXISTS public.boligpris_aggregat(
  integer[], integer[], date, date, integer, integer, integer, integer,
  integer, integer, integer, integer, text[]
);
DROP FUNCTION IF EXISTS public.boligpris_handler_count(
  integer[], integer[], date, date, integer, integer, integer, integer,
  integer, integer, integer, integer, text[], integer
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
  p_pris_min bigint DEFAULT 0,
  p_pris_max bigint DEFAULT 0,
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
  -- BIZZ-2186: pris-filter (kroner). 0kr-handler ekskluderes når et prisfilter
  -- er aktivt — de er fejlregistreringer/familieoverdragelser, ikke markedshandler.
  IF p_pris_min <> 0 THEN
    v_where := v_where || format(' AND m.samlet_koebesum >= %s', p_pris_min);
  END IF;
  IF p_pris_max <> 0 THEN
    v_where := v_where || format(' AND m.samlet_koebesum <= %s', p_pris_max);
  END IF;
  IF p_pris_min <> 0 OR p_pris_max <> 0 THEN
    v_where := v_where || ' AND m.samlet_koebesum > 0';
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
  p_pris_min bigint DEFAULT 0,
  p_pris_max bigint DEFAULT 0,
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
  -- BIZZ-2186: pris-filter (kroner) + ekskludér 0kr når prisfilter aktivt.
  IF p_pris_min <> 0 THEN
    v_where := v_where || format(' AND m.samlet_koebesum >= %s', p_pris_min);
  END IF;
  IF p_pris_max <> 0 THEN
    v_where := v_where || format(' AND m.samlet_koebesum <= %s', p_pris_max);
  END IF;
  IF p_pris_min <> 0 OR p_pris_max <> 0 THEN
    v_where := v_where || ' AND m.samlet_koebesum > 0';
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
  p_pris_min bigint DEFAULT 0,
  p_pris_max bigint DEFAULT 0,
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
  -- BIZZ-2186: pris-filter (kroner) + ekskludér 0kr når prisfilter aktivt.
  IF p_pris_min <> 0 THEN
    v_where := v_where || format(' AND m.samlet_koebesum >= %s', p_pris_min);
  END IF;
  IF p_pris_max <> 0 THEN
    v_where := v_where || format(' AND m.samlet_koebesum <= %s', p_pris_max);
  END IF;
  IF p_pris_min <> 0 OR p_pris_max <> 0 THEN
    v_where := v_where || ' AND m.samlet_koebesum > 0';
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
