-- ============================================================================
-- 119: mv_virksomhed_struktur — BIZZ-1471
-- Eliminerer N+1 i diagram/expand for virksomhedshierarki.
-- cvr_virksomhed_ejerskab + cvr_virksomhed begge sider.
-- ============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_virksomhed_struktur AS
SELECT
  ej.ejer_cvr,
  ejer.navn AS ejer_navn,
  ejer.virksomhedsform AS ejer_form,
  ejer.branche_tekst AS ejer_branche,
  ejer.status AS ejer_status,
  ej.ejet_cvr,
  ejet.navn AS ejet_navn,
  ejet.virksomhedsform AS ejet_form,
  ejet.branche_tekst AS ejet_branche,
  ejet.status AS ejet_status,
  ej.ejerandel_min,
  ej.ejerandel_max,
  ej.ejerandel_pct,
  ej.gyldig_fra,
  ej.gyldig_til
FROM public.cvr_virksomhed_ejerskab ej
LEFT JOIN public.cvr_virksomhed ejer ON ejer.cvr = ej.ejer_cvr
LEFT JOIN public.cvr_virksomhed ejet ON ejet.cvr = ej.ejet_cvr
WHERE ej.gyldig_til IS NULL
WITH NO DATA;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_mv_virk_struktur_ejer
  ON public.mv_virksomhed_struktur (ejer_cvr);
CREATE INDEX IF NOT EXISTS idx_mv_virk_struktur_ejet
  ON public.mv_virksomhed_struktur (ejet_cvr);

-- Grants
ALTER MATERIALIZED VIEW public.mv_virksomhed_struktur OWNER TO postgres;
GRANT SELECT ON public.mv_virksomhed_struktur TO authenticated;
GRANT SELECT ON public.mv_virksomhed_struktur TO ai_query_reader;

COMMENT ON MATERIALIZED VIEW public.mv_virksomhed_struktur IS 'BIZZ-1471: Virksomhedsstruktur — ejer/ejet CVR med navne. Refresh nightly.';
