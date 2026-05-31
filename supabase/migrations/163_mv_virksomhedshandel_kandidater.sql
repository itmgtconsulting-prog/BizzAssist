-- BIZZ-1926: Materialized view for virksomhedshandel-kandidater
-- Detekterer ejerskabsændringer (entry/exit/increase/decrease) via window-functions
-- på mv_deltager_beriget. Bruges af M&A-radar UI.

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_virksomhedshandel_kandidater AS
WITH events AS (
  SELECT
    deltager_enhedsnummer,
    deltager_navn,
    virksomhed_cvr,
    relation_type,
    ejerandel_pct,
    gyldig_fra,
    gyldig_til,
    LAG(ejerandel_pct) OVER (
      PARTITION BY deltager_enhedsnummer, virksomhed_cvr
      ORDER BY gyldig_fra
    ) AS prev_ejerandel_pct,
    LEAD(gyldig_fra) OVER (
      PARTITION BY deltager_enhedsnummer, virksomhed_cvr
      ORDER BY gyldig_fra
    ) AS next_start
  FROM mv_deltager_beriget
  WHERE relation_type IN ('register', 'reel_ejer', 'interessenter')
    AND ejerandel_pct IS NOT NULL
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
  CASE
    WHEN gyldig_til IS NOT NULL AND prev_ejerandel_pct IS NULL THEN 'exit'
    WHEN gyldig_til IS NULL AND prev_ejerandel_pct IS NULL AND gyldig_fra > '2020-01-01' THEN 'entry'
    WHEN ejerandel_pct > COALESCE(prev_ejerandel_pct, 0) THEN 'increase'
    WHEN ejerandel_pct < COALESCE(prev_ejerandel_pct, 100) THEN 'decrease'
    ELSE 'unchanged'
  END AS signal_type
FROM events
WHERE
  gyldig_til IS NOT NULL
  OR (gyldig_fra > '2020-01-01' AND prev_ejerandel_pct IS NULL)
  OR ejerandel_pct != COALESCE(prev_ejerandel_pct, -1);

-- Indices for API-queries
CREATE INDEX IF NOT EXISTS idx_mvvhk_signal ON mv_virksomhedshandel_kandidater (signal_type);
CREATE INDEX IF NOT EXISTS idx_mvvhk_cvr ON mv_virksomhedshandel_kandidater (virksomhed_cvr);
CREATE INDEX IF NOT EXISTS idx_mvvhk_gyldig ON mv_virksomhedshandel_kandidater (gyldig_fra DESC);
