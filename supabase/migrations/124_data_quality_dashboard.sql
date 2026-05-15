-- ============================================================================
-- 124: data_quality_dashboard view — BIZZ-1481
-- Samlet dækningsstatistik for alle datakilder.
-- ============================================================================

CREATE OR REPLACE VIEW public.data_quality_dashboard AS
SELECT
  'cvr_virksomhed' AS tabel,
  (SELECT count(*) FROM public.cvr_virksomhed)::bigint AS total,
  (SELECT count(*) FROM public.cvr_virksomhed WHERE ophoert IS NULL)::bigint AS aktive,
  (SELECT count(*) FROM public.cvr_virksomhed WHERE branche_kode IS NOT NULL)::bigint AS med_branche,
  NULL::bigint AS med_kommune,
  NULL::bigint AS med_pris
UNION ALL
SELECT
  'bbr_ejendom_status',
  (SELECT count(*) FROM public.bbr_ejendom_status WHERE is_udfaset = false),
  (SELECT count(*) FROM public.bbr_ejendom_status WHERE is_udfaset = false AND kommune_kode IS NOT NULL),
  (SELECT count(*) FROM public.bbr_ejendom_status WHERE is_udfaset = false AND byg021_anvendelse IS NOT NULL),
  (SELECT count(*) FROM public.bbr_ejendom_status WHERE is_udfaset = false AND kommune_kode IS NOT NULL),
  NULL
UNION ALL
SELECT
  'ejf_ejerskab',
  (SELECT count(*) FROM public.ejf_ejerskab),
  (SELECT count(*) FROM public.ejf_ejerskab WHERE status = 'gældende'),
  NULL,
  NULL,
  NULL
UNION ALL
SELECT
  'vurdering_cache',
  (SELECT count(*) FROM public.vurdering_cache),
  (SELECT count(*) FROM public.vurdering_cache WHERE ejendomsvaerdi IS NOT NULL),
  NULL,
  NULL,
  NULL
UNION ALL
SELECT
  'regnskab_cache',
  (SELECT count(*) FROM public.regnskab_cache),
  (SELECT count(*) FROM public.regnskab_cache WHERE omsaetning IS NOT NULL),
  NULL,
  NULL,
  NULL
UNION ALL
SELECT
  'ejerskifte_historik',
  (SELECT count(*) FROM public.ejerskifte_historik),
  NULL,
  NULL,
  NULL,
  (SELECT count(*) FROM public.ejerskifte_historik WHERE kontant_koebesum IS NOT NULL)
UNION ALL
SELECT
  'tinglysning_adkomst',
  (SELECT count(*) FROM public.tinglysning_adkomst),
  NULL,
  NULL,
  NULL,
  (SELECT count(*) FROM public.tinglysning_adkomst WHERE kontant_koebesum IS NOT NULL);

GRANT SELECT ON public.data_quality_dashboard TO authenticated;
GRANT SELECT ON public.data_quality_dashboard TO ai_query_reader;

COMMENT ON VIEW public.data_quality_dashboard IS 'BIZZ-1481: Dækningsstatistik for alle datakilder — brug til kvalitetsmonitorering.';
