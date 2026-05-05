-- ============================================================
-- Migration 083: Materialized views for krydsanalyser
-- BIZZ-920: Prædefinerede views der joiner cache-tabeller for
-- hurtige kryds-entity analyser.
--
-- Kræver: Migration 082 (cache_bbr, cache_cvr, cache_vur)
-- Refresh: Via cron efter sync-completion
-- ============================================================

-- ── Virksomhed → portefølje (ejede ejendomme + samlet vurdering) ────

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_virksomhed_portefolje AS
SELECT
  cvr.cvr_nummer,
  cvr.raw_data->>'name' AS virksomhedsnavn,
  cvr.raw_data->>'branche' AS branche,
  cvr.raw_data->>'status' AS status,
  COUNT(DISTINCT vur.bfe_nummer) AS antal_ejendomme,
  SUM(
    COALESCE(
      (vur.raw_data->'vurderinger'->0->>'ejendomvaerdiBeloeb')::bigint,
      0
    )
  ) AS samlet_ejendomsvaerdi,
  SUM(
    COALESCE(
      (vur.raw_data->'vurderinger'->0->>'grundvaerdiBeloeb')::bigint,
      0
    )
  ) AS samlet_grundvaerdi,
  cvr.synced_at AS cvr_synced_at
FROM public.cache_cvr cvr
LEFT JOIN public.cache_vur vur ON true  -- Placeholder join — kræver ejerskabsdata for korrekt kobling
GROUP BY cvr.cvr_nummer, cvr.raw_data, cvr.synced_at
WITH NO DATA;

COMMENT ON MATERIALIZED VIEW public.mv_virksomhed_portefolje IS
  'BIZZ-920: Virksomhed med antal ejede ejendomme og samlet vurdering. Refresh efter sync.';

-- ── Kommune-statistik (aggregeret per kommune) ──────────────────────

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_kommune_statistik AS
SELECT
  (dar.raw_data->>'kommunekode')::text AS kommunekode,
  dar.raw_data->>'kommunenavn' AS kommunenavn,
  COUNT(*) AS antal_adresser,
  dar.synced_at AS dar_synced_at
FROM public.cache_dar dar
WHERE dar.raw_data->>'kommunekode' IS NOT NULL
GROUP BY dar.raw_data->>'kommunekode', dar.raw_data->>'kommunenavn', dar.synced_at
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_kommune_statistik_kode
  ON public.mv_kommune_statistik (kommunekode);

COMMENT ON MATERIALIZED VIEW public.mv_kommune_statistik IS
  'BIZZ-920: Aggregerede nøgletal per kommune. Refresh efter DAR sync.';

-- ── Sync status: registrer views for refresh-scheduling ─────────────

INSERT INTO public.data_sync_status (source_name)
VALUES ('mv_virksomhed_portefolje'), ('mv_kommune_statistik')
ON CONFLICT (source_name) DO NOTHING;
