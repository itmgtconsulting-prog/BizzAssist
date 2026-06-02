-- BIZZ-1963: Korrekt signal/dato ved ejerskifte i M&A-radaren.
--
-- Symptom: Ved et 100%-ejerskifte (fx HUPFELD EJENDOMSADMINISTRATION, CVR 30809289)
-- viste radaren BÅDE sælger (HUP ApS) OG køber (DEAS A/S) som ejende 100% med samme
-- ændringsdato (2025-09-01) — som om to ejere havde 100% samtidig.
--
-- Root cause (data var korrekte — fejl i MV-logikken):
--   1) mv_virksomhedshandel_kandidater (migration 163) modellerede én række pr.
--      ejerskabs-PERIODE og udledte kun 'exit' når prev_ejerandel_pct IS NULL
--      (deltagerens første periode). En sælgers reelle exit (sidste lukkede periode,
--      100%->0%) blev derfor aldrig en exit-række; den lukkede 100%-periode beholdt
--      sin 'increase'-label. Samtidig blev deltagerens FØRSTE lukkede periode
--      fejlagtigt labelet 'exit'.
--   2) route.ts bruger AENDRINGSDATO = COALESCE(gyldig_til, gyldig_fra). For en
--      LUKKET increase-periode valgte COALESCE slutdatoen (gyldig_til), så en gammel
--      stigning (fx HUP 66,67%->100% pr. 2022-12-31) blev mis-dateret til 2025-09-01
--      og slap gennem from_date-filteret.
--
-- Forudsætning som rettelsen udnytter: BIZZ-1938 har backfillet reelle gyldig_fra/
-- gyldig_til-perioder i cvr_deltagerrelation (migration 163's kommentar om gyldig_fra
-- = 1900-01-01 er ikke længere gældende). Window-ordering sker derfor nu på gyldig_fra
-- (reel kronologi) i stedet for sidst_opdateret (som efter backfill er ens for alle
-- rækker og dermed gav ikke-deterministisk LAG/LEAD-rækkefølge).
--
-- Ny model: én række pr. ejerskabs-TRANSITION med korrekt, date-typet ændringsdato:
--   * entry/increase/decrease ved periodens START (gyldig_fra; gyldig_til=NULL så
--     COALESCE(gyldig_til,gyldig_fra)=gyldig_fra).
--   * terminal 'exit' ved SIDSTE periodes SLUT, når deltageren ikke har en efterfølgende
--     ejerperiode i samme selskab (LEAD(ejerandel_pct) IS NULL). Exit-rækken bærer
--     current_ejerandel_pct = den forladte andel og prev_ejerandel_pct = 0, så klientens
--     eksisterende exit-visning (current -> 0) og delta-beregning er uændret.
--
-- Mellemliggende periode-skift (fx 66,67%->100%) fanges allerede af næste periodes
-- start-transition (increase/decrease), så der genereres bevidst IKKE en exit for hver
-- lukket periode — kun den terminale. Det undgår falske exits på 1-dags periodegrænser
-- (gyldig_til = dagen før næste gyldig_fra).
--
-- NB (apply på allerede-populeret MV i test/prod): CREATE rebuild'er ~1,75M rækker via
-- fuld scan af cvr_deltagerrelation (~60s) og bør køres via en direkte DB-forbindelse —
-- Supabase Management API-gatewayen timer ud ved ~120s. For nul-nedetid kan man bygge
-- under et midlertidigt navn, oprette indexene og swappe navnene i én transaktion.

DROP MATERIALIZED VIEW IF EXISTS mv_virksomhedshandel_kandidater CASCADE;

CREATE MATERIALIZED VIEW mv_virksomhedshandel_kandidater AS
WITH owner_periods AS (
  SELECT
    dr.deltager_enhedsnummer,
    cd.navn AS deltager_navn,
    dr.virksomhed_cvr,
    dr.type AS relation_type,
    dr.ejerandel_pct,
    dr.gyldig_fra,
    dr.gyldig_til,
    dr.sidst_opdateret,
    LAG(dr.ejerandel_pct)  OVER w AS prev_andel,
    LEAD(dr.ejerandel_pct) OVER w AS next_andel
  FROM public.cvr_deltagerrelation dr
  LEFT JOIN public.cvr_deltager cd
    ON cd.enhedsnummer = dr.deltager_enhedsnummer
  WHERE dr.type IN ('register', 'reel_ejer', 'interessenter')
    AND dr.ejerandel_pct IS NOT NULL
  WINDOW w AS (
    PARTITION BY dr.deltager_enhedsnummer, dr.virksomhed_cvr
    ORDER BY dr.gyldig_fra NULLS FIRST,
             dr.gyldig_til NULLS LAST,
             COALESCE(dr.sidst_opdateret, dr.gyldig_fra::timestamptz)
  )
),
-- Transition ved periodens START: tiltrædelse eller andels-ændring.
-- gyldig_til sættes NULL så COALESCE(gyldig_til, gyldig_fra) = gyldig_fra (start-datoen).
entry_events AS (
  SELECT
    deltager_enhedsnummer,
    deltager_navn,
    virksomhed_cvr,
    relation_type,
    ejerandel_pct           AS current_ejerandel_pct,
    COALESCE(prev_andel, 0) AS prev_ejerandel_pct,
    gyldig_fra,
    NULL::date              AS gyldig_til,
    sidst_opdateret,
    CASE
      WHEN prev_andel IS NULL              THEN 'entry'
      WHEN ejerandel_pct > prev_andel      THEN 'increase'
      WHEN ejerandel_pct < prev_andel      THEN 'decrease'
      ELSE 'unchanged'
    END AS signal_type
  FROM owner_periods
),
-- Terminal exit: deltagerens sidste periode er lukket og har ingen efterfølger.
-- Datoen er gyldig_til (også brugt som gyldig_fra, så React-key forbliver unik og
-- COALESCE(gyldig_til, gyldig_fra) = exit-datoen). current = forladt andel, prev = 0
-- matcher klientens eksisterende exit-visning (current -> 0).
exit_events AS (
  SELECT
    deltager_enhedsnummer,
    deltager_navn,
    virksomhed_cvr,
    relation_type,
    ejerandel_pct AS current_ejerandel_pct,
    0::numeric    AS prev_ejerandel_pct,
    gyldig_til    AS gyldig_fra,
    gyldig_til,
    sidst_opdateret,
    'exit'        AS signal_type
  FROM owner_periods
  WHERE gyldig_til IS NOT NULL
    AND next_andel IS NULL
)
SELECT * FROM entry_events
WHERE signal_type <> 'unchanged'
  AND NOT (signal_type = 'entry' AND current_ejerandel_pct <= 0)
UNION ALL
SELECT * FROM exit_events;

-- Indices for API-queries (uændrede navne fra migration 163 + 165)
CREATE INDEX IF NOT EXISTS idx_mvvhk_signal
  ON mv_virksomhedshandel_kandidater (signal_type);
CREATE INDEX IF NOT EXISTS idx_mvvhk_cvr
  ON mv_virksomhedshandel_kandidater (virksomhed_cvr);
CREATE INDEX IF NOT EXISTS idx_mvvhk_opdateret
  ON mv_virksomhedshandel_kandidater (sidst_opdateret DESC);
-- Matcher route'ens ORDER BY COALESCE(gyldig_til, gyldig_fra) DESC NULLS LAST.
CREATE INDEX IF NOT EXISTS idx_mvvhk_aendringsdato
  ON mv_virksomhedshandel_kandidater (COALESCE(gyldig_til, gyldig_fra) DESC NULLS LAST);
