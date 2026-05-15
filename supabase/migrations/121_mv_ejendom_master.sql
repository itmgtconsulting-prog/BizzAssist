-- ============================================================================
-- 121: mv_ejendom_master — BIZZ-1473
-- Ultimativ ejendoms-view: BBR + kommune + anvendelse + vurdering.
-- Ejerskab inkluderes IKKE her (timeout ved 7.6M LATERAL join) —
-- brug mv_ejerskab_beriget separat og join via bfe_nummer.
-- ============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_ejendom_master AS
SELECT
  bbr.bfe_nummer,
  bbr.kommune_kode,
  kr.kommunenavn,
  kr.region,
  bbr.samlet_boligareal AS boligareal_m2,
  bbr.samlet_erhvervsareal AS erhvervsareal_m2,
  bbr.grundareal,
  bbr.bebygget_areal,
  bbr.opfoerelsesaar,
  bbr.ombygningsaar,
  bbr.byg021_anvendelse AS anvendelse_kode,
  anv.anvendelse_tekst,
  anv.kategori AS anvendelse_kategori,
  bbr.energimaerke,
  bbr.energimaerke_dato,
  bbr.antal_etager,
  bbr.antal_boligenheder,
  bbr.tagmateriale,
  bbr.ydervaeg_materiale,
  bbr.varmeinstallation,
  bbr.opvarmningsform,
  bbr.ejerforholdskode,
  bbr.bbr_status_code,
  -- Vurdering
  vc.ejendomsvaerdi,
  vc.grundvaerdi,
  vc.vurderingsaar,
  vc.benyttelseskode
FROM public.bbr_ejendom_status bbr
LEFT JOIN public.kommune_ref kr
  ON kr.kommune_kode = bbr.kommune_kode
LEFT JOIN public.bbr_anvendelse_ref anv
  ON anv.anvendelse_kode = bbr.byg021_anvendelse
LEFT JOIN public.vurdering_cache vc
  ON vc.bfe_nummer = bbr.bfe_nummer
WHERE bbr.is_udfaset = false
WITH NO DATA;

-- Indexes for AI queries og frontend lookups
CREATE INDEX IF NOT EXISTS idx_mv_ejendom_master_kommune
  ON public.mv_ejendom_master (kommune_kode);
CREATE INDEX IF NOT EXISTS idx_mv_ejendom_master_anv
  ON public.mv_ejendom_master (anvendelse_kode);
CREATE INDEX IF NOT EXISTS idx_mv_ejendom_master_vurdering
  ON public.mv_ejendom_master (ejendomsvaerdi)
  WHERE ejendomsvaerdi IS NOT NULL;

-- Grants
ALTER MATERIALIZED VIEW public.mv_ejendom_master OWNER TO postgres;
GRANT SELECT ON public.mv_ejendom_master TO authenticated;
GRANT SELECT ON public.mv_ejendom_master TO ai_query_reader;

COMMENT ON MATERIALIZED VIEW public.mv_ejendom_master IS 'BIZZ-1473: Ejendom master — BBR + kommune + vurdering. Refresh nightly. Join ejerskab via mv_ejerskab_beriget.';
