-- Migration 137: Fix mv_virksomhed_portefolje to use normalized tables
-- Old version used cache_cvr (raw JSONB) + placeholder JOIN ON true = 0 rows
-- New version uses cvr_virksomhed + ejf_ejerskab + vurdering_cache

DROP MATERIALIZED VIEW IF EXISTS public.mv_virksomhed_portefolje;

CREATE MATERIALIZED VIEW public.mv_virksomhed_portefolje AS
SELECT
  v.cvr,
  v.navn AS virksomhedsnavn,
  v.branche_tekst AS branche,
  CASE WHEN v.ophoert IS NULL THEN 'aktiv' ELSE 'ophørt' END AS status,
  COUNT(DISTINCT e.bfe_nummer) AS antal_ejendomme,
  SUM(COALESCE(vc.ejendomsvaerdi, 0)) AS samlet_ejendomsvaerdi,
  SUM(COALESCE(vc.grundvaerdi, 0)) AS samlet_grundvaerdi,
  v.sidst_opdateret AS cvr_synced_at
FROM public.cvr_virksomhed v
JOIN public.ejf_ejerskab e ON e.ejer_cvr = v.cvr AND e.status = 'gældende'
LEFT JOIN public.vurdering_cache vc ON vc.bfe_nummer = e.bfe_nummer
GROUP BY v.cvr, v.navn, v.branche_tekst, v.ophoert, v.sidst_opdateret
HAVING COUNT(DISTINCT e.bfe_nummer) > 0
WITH NO DATA;

CREATE UNIQUE INDEX idx_mv_virksomhed_portefolje_cvr
  ON public.mv_virksomhed_portefolje (cvr);

COMMENT ON MATERIALIZED VIEW public.mv_virksomhed_portefolje IS
  'Virksomhed med antal ejede ejendomme og samlet vurdering. Refresh efter sync.';

GRANT SELECT ON public.mv_virksomhed_portefolje TO ai_query_reader;
