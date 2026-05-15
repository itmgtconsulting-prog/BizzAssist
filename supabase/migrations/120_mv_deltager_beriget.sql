-- ============================================================================
-- 120: mv_deltager_beriget — BIZZ-1472
-- Eliminerer person-name-lookup i diagram/expand.
-- cvr_deltagerrelation + cvr_deltager.
-- ============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_deltager_beriget AS
SELECT
  dr.virksomhed_cvr,
  dr.deltager_enhedsnummer,
  cd.navn AS deltager_navn,
  dr.type AS relation_type,
  dr.ejer_cvr,
  dr.ejerandel_pct,
  dr.ejerandel_fra,
  dr.ejerandel_til,
  dr.gyldig_fra,
  dr.gyldig_til,
  cd.antal_aktive_selskaber,
  cd.role_typer
FROM public.cvr_deltagerrelation dr
LEFT JOIN public.cvr_deltager cd
  ON cd.enhedsnummer = dr.deltager_enhedsnummer
WHERE dr.gyldig_til IS NULL
WITH NO DATA;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_mv_deltager_beriget_cvr
  ON public.mv_deltager_beriget (virksomhed_cvr);
CREATE INDEX IF NOT EXISTS idx_mv_deltager_beriget_enheds
  ON public.mv_deltager_beriget (deltager_enhedsnummer);

-- Grants
ALTER MATERIALIZED VIEW public.mv_deltager_beriget OWNER TO postgres;
GRANT SELECT ON public.mv_deltager_beriget TO authenticated;
GRANT SELECT ON public.mv_deltager_beriget TO ai_query_reader;

COMMENT ON MATERIALIZED VIEW public.mv_deltager_beriget IS 'BIZZ-1472: Beriget deltager — cvr_deltagerrelation + cvr_deltager. Refresh nightly.';
