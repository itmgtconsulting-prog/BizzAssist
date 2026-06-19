-- BIZZ-2070: Boligpris-filtre "antal etager" og "antal værelser".
--
-- Baggrund (split fra BIZZ-2051): filtrene kunne ikke implementeres med
-- eksisterende data — bbr_ejendom_status.antal_etager er 100% NULL og der
-- fandtes ingen kildekolonne for værelser overhovedet.
--
-- Denne migration:
--   1) Tilføjer bbr_ejendom_status.antal_vaerelser (antal_etager findes
--      allerede men er upopuleret). Begge backfilles af
--      scripts/backfill-bbr-etager-vaerelser.mjs via BBR v2 4-step pipeline:
--      BBR_Ejendomsrelation → BBR_Grund → BBR_Bygning(byg054AntalEtager)
--      → BBR_Enhed(enh031AntalVaerelser).
--      Konsolidering: etager = MAX(byg054AntalEtager) over aktive bygninger,
--      værelser = SUM(enh031AntalVaerelser) over aktive enheder.
--   2) Genbygger mv_boligpris_handler med de to nye kolonner.
--   3) Udvider boligpris_handler-RPC'en (dynamisk plan fra migration 174)
--      med p_etager_min/max + p_vaerelser_min/max — samme mønster som
--      areal/byggeår fra BIZZ-2051: filtrér FØR pagination, og kun de
--      faktisk aktive filtre kommer med i WHERE (sargbart → index-brug).

-- 1) Ny kolonne (NULL = endnu ikke backfillet / ukendt i BBR)
ALTER TABLE public.bbr_ejendom_status
  ADD COLUMN IF NOT EXISTS antal_vaerelser integer;

COMMENT ON COLUMN public.bbr_ejendom_status.antal_vaerelser IS
  'BIZZ-2070: Sum af enh031AntalVaerelser over aktive BBR-enheder. Backfillet via scripts/backfill-bbr-etager-vaerelser.mjs.';

-- 2) Genbyg den flade handler-MV med etager + værelser.
--    Samme rækkepopulation som migration 173 (= KPI-MV'ens join) — kun to
--    ekstra kolonner, så KPI-antal matcher fortsat handler-listen.
DROP MATERIALIZED VIEW IF EXISTS public.mv_boligpris_handler;
CREATE MATERIALIZED VIEW public.mv_boligpris_handler AS
SELECT
  h.bfe_nummer::int                        AS bfe_nummer,
  (h.overtagelsesdato)::date               AS overtagelsesdato,
  h.samlet_koebesum::bigint                AS samlet_koebesum,
  b.samlet_boligareal::int                 AS samlet_boligareal,
  b.byg021_anvendelse::int                 AS byg021_anvendelse,
  b.opfoerelsesaar::int                    AS opfoerelsesaar,
  b.antal_etager::int                      AS antal_etager,
  b.antal_vaerelser::int                   AS antal_vaerelser,
  b.kommune_kode::int                      AS kommune_kode
FROM v_ejerskifte_handel h
JOIN bbr_ejendom_status b ON h.bfe_nummer = b.bfe_nummer
WHERE h.samlet_koebesum > 0
  AND h.overtagelsesdato IS NOT NULL
  AND b.kommune_kode IS NOT NULL;

-- Indeks som i migration 173 (dækker de typiske query-stier)
CREATE INDEX idx_mbh_kommune_type_dato
  ON public.mv_boligpris_handler (kommune_kode, byg021_anvendelse, overtagelsesdato DESC);
CREATE INDEX idx_mbh_type_dato
  ON public.mv_boligpris_handler (byg021_anvendelse, overtagelsesdato DESC);
CREATE INDEX idx_mbh_dato
  ON public.mv_boligpris_handler (overtagelsesdato DESC);

-- 3) RPC med de to nye filtre. Signaturen ændres → DROP gamle først.
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
  p_etager_min integer DEFAULT 0,
  p_etager_max integer DEFAULT 0,
  p_vaerelser_min integer DEFAULT 0,
  p_vaerelser_max integer DEFAULT 0,
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
  -- BIZZ-2070: etager/værelser. COALESCE(…, 0) → rækker uden backfillet BBR-
  -- data falder UD når filtret er aktivt (0 matcher aldrig min >= 1) — samme
  -- semantik som areal/byggeår.
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

  RETURN QUERY EXECUTE v_sql;
END;
$function$;
