-- ============================================================================
-- 118: mv_ejerskab_beriget — BIZZ-1470
-- Eliminerer N+1 pattern i diagram/expand og ejendomme-by-owner.
-- ejf_ejerskab LEFT JOIN cvr_virksomhed + cvr_deltager.
-- ============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_ejerskab_beriget AS
SELECT
  e.bfe_nummer,
  e.ejer_navn,
  e.ejer_cvr,
  e.ejer_type,
  e.ejerandel_taeller,
  e.ejerandel_naevner,
  CASE WHEN e.ejerandel_naevner > 0
    THEN round(e.ejerandel_taeller::numeric / e.ejerandel_naevner::numeric * 100, 1)
    ELSE NULL
  END AS ejerandel_pct,
  e.virkning_fra,
  e.virkning_til,
  e.status,
  -- Virksomheds-berigelse (kun for ejer_type='virksomhed')
  cv.navn AS virksomhed_navn,
  cv.virksomhedsform,
  cv.branche_tekst,
  cv.branche_kode,
  cv.status AS virksomhed_status,
  -- Person-berigelse (match på navn)
  cd.enhedsnummer AS person_enhedsnummer
FROM public.ejf_ejerskab e
LEFT JOIN public.cvr_virksomhed cv
  ON cv.cvr = e.ejer_cvr
LEFT JOIN public.cvr_deltager cd
  ON e.ejer_type = 'person'
  AND cd.navn = e.ejer_navn
  AND cd.is_aktiv = true
WHERE e.status = 'gældende'
WITH NO DATA;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_mv_ejerskab_beriget_bfe
  ON public.mv_ejerskab_beriget (bfe_nummer);
CREATE INDEX IF NOT EXISTS idx_mv_ejerskab_beriget_cvr
  ON public.mv_ejerskab_beriget (ejer_cvr)
  WHERE ejer_cvr IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mv_ejerskab_beriget_person
  ON public.mv_ejerskab_beriget (person_enhedsnummer)
  WHERE person_enhedsnummer IS NOT NULL;

-- RLS + grants
ALTER MATERIALIZED VIEW public.mv_ejerskab_beriget OWNER TO postgres;
GRANT SELECT ON public.mv_ejerskab_beriget TO authenticated;
GRANT SELECT ON public.mv_ejerskab_beriget TO ai_query_reader;

COMMENT ON MATERIALIZED VIEW public.mv_ejerskab_beriget IS 'BIZZ-1470: Beriget ejerskab — ejf + cvr_virksomhed + cvr_deltager. Refresh nightly.';
