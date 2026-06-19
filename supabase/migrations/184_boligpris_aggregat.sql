-- BIZZ-2171: Boligpris-dashboard — KPI/graf/kommune-breakdown ignorerede BBR-
-- filtrene (areal/byggeår/etager/værelser) og det eksakte postnr-filter.
--
-- Baggrund: KPI-kortene ("Antal handler", gns. pris, m²-pris, YoY), prisudviklings-
-- grafen og kommune-breakdownet beregnes i API-routen fra mv_boligpris_maaned, som
-- KUN er aggregeret på (maaned, kommune_kode, byg021_anvendelse). BBR-filtrene og det
-- eksakte postnr-filter sendes derimod kun til boligpris_handler-RPC'en (listen).
-- Resultat: man kunne sætte "værelser = 2" eller "postnr 2500" og se listen ændre sig
-- (eller blive tom), mens "Antal handler 347" og priserne ikke rørte sig — KPI og liste
-- divergerede.
--
-- Denne migration tilføjer boligpris_aggregat: samme filtrerede population som
-- boligpris_handler (identisk WHERE-opbygning + postnr-join), men aggregeret pr.
-- (kommune_kode, måned). Rækkerne har præcis samme form som mv_boligpris_maaned-
-- rækkerne API-routen allerede aggregerer over (kommune_kode, maaned, antal_handler,
-- avg_pris, avg_m2_pris), så routen kan substituere kilden uden ny aggregerings-logik.
--
-- Sikkerhed: alle interpolerede værdier kvoteres med format(%L/%s) og er stærkt
-- typede arrays/datoer/integers fra funktionssignaturen — ingen injection-flade
-- (samme mønster som migration 174/175/180).

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
  -- Datointerval er altid med (overtagelsesdato er aldrig NULL i MV'en).
  v_where := format(
    'm.overtagelsesdato >= %L AND m.overtagelsesdato <= %L',
    p_fra, p_til
  );

  -- Identisk filter-opbygning som boligpris_handler (migration 180), så KPI/graf
  -- dækker PRÆCIS samme population som listen. Kun aktive filtre tilføjes →
  -- sargbare prædikater → index-brug.
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

  -- Eksakt postnr-filter (samme join som boligpris_handler). Kommune-prefiltret
  -- (sat af API-routen) afgrænser fortsat index-scanningen.
  IF p_postnumre IS NOT NULL THEN
    v_join := format(
      ' JOIN bfe_adresse_cache a ON m.bfe_nummer = a.bfe_nummer AND a.postnr = ANY(%L::text[])',
      p_postnumre
    );
  END IF;

  -- Aggregér pr. (kommune, måned). avg_m2_pris beregnes kun over rækker med areal > 0,
  -- og urealistiske m²-priser (> 200000, korrupt kilde-data) ekskluderes — samme cap
  -- som API-routen anvender på mv_boligpris_maaned-rækkerne.
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
