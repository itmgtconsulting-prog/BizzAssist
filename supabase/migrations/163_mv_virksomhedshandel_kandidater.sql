-- BIZZ-1926: Materialized view for virksomhedshandel-kandidater
-- Detekterer ejerskabsændringer (entry/exit/increase/decrease) via window-functions
-- på cvr_deltagerrelation (direkte, ikke mv_deltager_beriget som filtrerer gyldig_til).
-- Bruges af M&A-radar UI.
--
-- VIGTIGT: gyldig_fra er 1900-01-01 for alle rows i cvr_deltagerrelation.
-- sidst_opdateret er den reelle indrapporteringsdato (2015-2026).

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_virksomhedshandel_kandidater AS
WITH events AS (
  SELECT
    dr.deltager_enhedsnummer,
    cd.navn AS deltager_navn,
    dr.virksomhed_cvr,
    dr.type AS relation_type,
    dr.ejerandel_pct,
    dr.gyldig_fra,
    dr.gyldig_til,
    dr.sidst_opdateret,
    LAG(dr.ejerandel_pct) OVER (
      PARTITION BY dr.deltager_enhedsnummer, dr.virksomhed_cvr
      ORDER BY COALESCE(dr.sidst_opdateret, dr.gyldig_fra::timestamptz)
    ) AS prev_ejerandel_pct
  FROM public.cvr_deltagerrelation dr
  LEFT JOIN public.cvr_deltager cd
    ON cd.enhedsnummer = dr.deltager_enhedsnummer
  WHERE dr.type IN ('register', 'reel_ejer', 'interessenter')
    AND dr.ejerandel_pct IS NOT NULL
)
SELECT
  deltager_enhedsnummer,
  deltager_navn,
  virksomhed_cvr,
  relation_type,
  ejerandel_pct AS current_ejerandel_pct,
  COALESCE(prev_ejerandel_pct, 0) AS prev_ejerandel_pct,
  gyldig_fra,
  gyldig_til,
  sidst_opdateret,
  CASE
    WHEN gyldig_til IS NOT NULL AND prev_ejerandel_pct IS NULL THEN 'exit'
    WHEN gyldig_til IS NULL AND prev_ejerandel_pct IS NULL AND sidst_opdateret > '2020-01-01' THEN 'entry'
    WHEN ejerandel_pct > COALESCE(prev_ejerandel_pct, 0) THEN 'increase'
    WHEN ejerandel_pct < COALESCE(prev_ejerandel_pct, 100) THEN 'decrease'
    ELSE 'unchanged'
  END AS signal_type
FROM events
WHERE
  gyldig_til IS NOT NULL
  OR (sidst_opdateret > '2020-01-01' AND prev_ejerandel_pct IS NULL)
  OR ejerandel_pct != COALESCE(prev_ejerandel_pct, -1);

-- Indices for API-queries
CREATE INDEX IF NOT EXISTS idx_mvvhk_signal ON mv_virksomhedshandel_kandidater (signal_type);
CREATE INDEX IF NOT EXISTS idx_mvvhk_cvr ON mv_virksomhedshandel_kandidater (virksomhed_cvr);
CREATE INDEX IF NOT EXISTS idx_mvvhk_opdateret ON mv_virksomhedshandel_kandidater (sidst_opdateret DESC);
