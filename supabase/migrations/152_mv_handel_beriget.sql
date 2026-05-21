-- ============================================================================
-- 152: Materialized view mv_handel_beriget — pre-joined EJF handler (BIZZ-1714)
-- ============================================================================
-- Joiner ejf_ejerskifte + ejf_handelsoplysninger + bbr_ejendom_status for
-- hurtige pris-aggregeringer i Data Intelligence. Refreshes via cron.
-- ============================================================================

-- Drop eksisterende view hvis schema ændres
DROP MATERIALIZED VIEW IF EXISTS public.mv_handel_beriget;

CREATE MATERIALIZED VIEW public.mv_handel_beriget AS
SELECT
  e.bfe_nummer,
  e.overdragelsesmaade,
  e.overtagelsesdato,
  e.status           AS ejerskifte_status,
  h.kontant_koebesum,
  h.samlet_koebesum,
  h.koebsaftale_dato,
  h.valutakode,
  bbr.kommune_kode,
  bbr.byg021_anvendelse,
  bbr.samlet_boligareal,
  bbr.samlet_erhvervsareal,
  bbr.opfoerelsesaar,
  bbr.energimaerke,
  -- Beregnet kvm-pris (kun når boligareal > 0)
  CASE
    WHEN bbr.samlet_boligareal > 0 AND h.kontant_koebesum > 0
    THEN ROUND(h.kontant_koebesum::numeric / bbr.samlet_boligareal, 0)
    ELSE NULL
  END AS kvm_pris
FROM public.ejf_ejerskifte e
LEFT JOIN public.ejf_handelsoplysninger h
  ON e.handelsoplysninger_lokal_id = h.id_lokal_id
LEFT JOIN public.bbr_ejendom_status bbr
  ON e.bfe_nummer = bbr.bfe_nummer
WHERE e.status = 'gældende';

-- Indekser for DI-queries
CREATE INDEX IF NOT EXISTS ix_mv_handel_bfe
  ON public.mv_handel_beriget (bfe_nummer);

CREATE INDEX IF NOT EXISTS ix_mv_handel_overdragelse
  ON public.mv_handel_beriget (overdragelsesmaade)
  WHERE overdragelsesmaade IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_mv_handel_kommune_dato
  ON public.mv_handel_beriget (kommune_kode, overtagelsesdato DESC)
  WHERE kontant_koebesum IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_mv_handel_kvm_pris
  ON public.mv_handel_beriget (kvm_pris)
  WHERE kvm_pris IS NOT NULL;

-- Initial refresh
REFRESH MATERIALIZED VIEW public.mv_handel_beriget;

COMMENT ON MATERIALIZED VIEW public.mv_handel_beriget IS
  'BIZZ-1714: Pre-joined ejf_ejerskifte + handelsoplysninger + bbr for DI pris-aggregeringer. Refresh dagligt via cron.';
