-- ============================================================================
-- 131: Intel Scorecard cache table + refresh function — BIZZ-1565 (L3)
-- ============================================================================
-- Static scorecards for Data Intelligence top-questions.
--
-- Bruges af cacheRouter til at servere ~30 mest stillede skalare svar
-- ("antal aktive virksomheder", "antal handler i 2025" etc) uden at brænde
-- semantik-lag-tid eller Claude-tokens.
--
-- Refreshes nightly via /api/cron/refresh-intel-scorecards.
-- ============================================================================

-- ─── Tabel ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.intel_scorecard (
  key            TEXT        PRIMARY KEY,
  value_numeric  NUMERIC,
  value_text     TEXT,
  unit           TEXT,
  display_name   TEXT        NOT NULL,
  format         TEXT        NOT NULL DEFAULT 'integer'
                            CHECK (format IN ('integer', 'decimal', 'currency_dkk', 'percent', 'm2', 'years')),
  refreshed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  refresh_ms     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_intel_scorecard_refreshed
  ON public.intel_scorecard (refreshed_at DESC);

-- Public scorecards er ikke tenant-data — alle authenticated brugere må læse.
ALTER TABLE public.intel_scorecard ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "intel_scorecard: service_role full" ON public.intel_scorecard;
CREATE POLICY "intel_scorecard: service_role full"
  ON public.intel_scorecard FOR ALL
  TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "intel_scorecard: authenticated read" ON public.intel_scorecard;
CREATE POLICY "intel_scorecard: authenticated read"
  ON public.intel_scorecard FOR SELECT
  TO authenticated USING (true);

COMMENT ON TABLE public.intel_scorecard IS
  'BIZZ-1565: Pre-computed skalare svar for Data Intelligence top-questions. Refresh nightly via cron. Read by all authenticated users (no PII).';

-- ─── Refresh-funktion ───────────────────────────────────────────────────────
-- SECURITY DEFINER så cron-routen (med authenticated context) kan invokere
-- den uden direkte service-role adgang til alle underliggende tabeller.
CREATE OR REPLACE FUNCTION public.refresh_intel_scorecards()
RETURNS TABLE(keys_updated INTEGER, duration_ms INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t0   TIMESTAMPTZ := clock_timestamp();
  n    INTEGER := 0;
  step INTEGER := 0;
BEGIN
  -- COUNT(*) på 2.1M+ rækker overskrider default statement_timeout (2min).
  -- Disable lokalt så refresh kan køre uafbrudt — kun gyldig inden for
  -- denne funktions transaktion.
  SET LOCAL statement_timeout = '0';

  -- Hvert blok wraps i BEGIN/EXCEPTION så manglende kolonner i én tabel
  -- (fx m2_pris i nyere migration) ikke aborterer hele refresh-jobbet.
  -- Vi logger fejlen som RAISE NOTICE og fortsætter med næste blok.

  -- Virksomheder
  BEGIN
    INSERT INTO public.intel_scorecard(key, value_numeric, unit, display_name, format) VALUES
      ('count_virksomheder',
       (SELECT COUNT(*) FROM public.cvr_virksomhed),
       'antal', 'Antal virksomheder', 'integer'),
      ('count_virksomheder_aktive',
       (SELECT COUNT(*) FROM public.cvr_virksomhed WHERE ophoert IS NULL),
       'antal', 'Antal aktive virksomheder', 'integer'),
      ('count_virksomheder_ophoert',
       (SELECT COUNT(*) FROM public.cvr_virksomhed WHERE ophoert IS NOT NULL),
       'antal', 'Antal ophørte virksomheder', 'integer')
    ON CONFLICT (key) DO UPDATE
      SET value_numeric = EXCLUDED.value_numeric,
          unit = EXCLUDED.unit,
          display_name = EXCLUDED.display_name,
          format = EXCLUDED.format,
          refreshed_at = now();
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[scorecard] virksomheder-blok fejlede: %', SQLERRM;
  END;

  -- Ejendomme
  BEGIN
    INSERT INTO public.intel_scorecard(key, value_numeric, unit, display_name, format) VALUES
      ('count_ejendomme',
       (SELECT COUNT(*) FROM public.bbr_ejendom_status WHERE is_udfaset = false),
       'antal', 'Antal ejendomme', 'integer'),
      ('count_ejendomme_med_handel',
       (SELECT COUNT(DISTINCT bfe_nummer) FROM public.ejerskifte_historik),
       'antal', 'Antal ejendomme med handel', 'integer'),
      ('count_bygninger_foer_1980',
       (SELECT COUNT(*) FROM public.bbr_ejendom_status WHERE is_udfaset = false AND opfoerelsesaar < 1980),
       'antal', 'Bygninger opført før 1980', 'integer'),
      ('count_bygninger_efter_2000',
       (SELECT COUNT(*) FROM public.bbr_ejendom_status WHERE is_udfaset = false AND opfoerelsesaar >= 2000),
       'antal', 'Bygninger opført efter 2000', 'integer'),
      ('count_ejendomme_uden_energimaerke',
       (SELECT COUNT(*) FROM public.bbr_ejendom_status WHERE is_udfaset = false AND energimaerke IS NULL),
       'antal', 'Ejendomme uden energimærke', 'integer')
    ON CONFLICT (key) DO UPDATE
      SET value_numeric = EXCLUDED.value_numeric,
          unit = EXCLUDED.unit,
          display_name = EXCLUDED.display_name,
          format = EXCLUDED.format,
          refreshed_at = now();
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[scorecard] ejendomme-blok fejlede: %', SQLERRM;
  END;

  -- Handler basis (uden m2_pris — det kommer i separat blok)
  BEGIN
    INSERT INTO public.intel_scorecard(key, value_numeric, unit, display_name, format) VALUES
      ('count_handler',
       (SELECT COUNT(*) FROM public.ejerskifte_historik),
       'antal', 'Antal handler', 'integer'),
      ('count_handler_med_pris',
       (SELECT COUNT(*) FROM public.ejerskifte_historik WHERE kontant_koebesum IS NOT NULL),
       'antal', 'Antal handler med pris', 'integer'),
      ('sum_koebesum_alle',
       (SELECT COALESCE(SUM(kontant_koebesum),0) FROM public.ejerskifte_historik WHERE kontant_koebesum IS NOT NULL),
       'DKK', 'Samlet købesum (alle)', 'currency_dkk'),
      ('avg_koebesum_alle',
       (SELECT AVG(kontant_koebesum) FROM public.ejerskifte_historik WHERE kontant_koebesum IS NOT NULL),
       'DKK', 'Gennemsnitlig købesum (alle)', 'currency_dkk'),
      ('median_koebesum_alle',
       (SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY kontant_koebesum) FROM public.ejerskifte_historik WHERE kontant_koebesum IS NOT NULL),
       'DKK', 'Median købesum (alle)', 'currency_dkk'),
      ('max_koebesum_alle',
       (SELECT MAX(kontant_koebesum) FROM public.ejerskifte_historik WHERE kontant_koebesum IS NOT NULL),
       'DKK', 'Højeste købesum', 'currency_dkk')
    ON CONFLICT (key) DO UPDATE
      SET value_numeric = EXCLUDED.value_numeric,
          unit = EXCLUDED.unit,
          display_name = EXCLUDED.display_name,
          format = EXCLUDED.format,
          refreshed_at = now();
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[scorecard] handler-blok fejlede: %', SQLERRM;
  END;

  -- m²-pris (kun hvis kolonnen findes — migration 128 evt. ikke kørt i alle env)
  BEGIN
    INSERT INTO public.intel_scorecard(key, value_numeric, unit, display_name, format) VALUES
      ('avg_m2_pris_alle',
       (SELECT AVG(m2_pris) FROM public.ejerskifte_historik WHERE m2_pris IS NOT NULL AND m2_pris > 0),
       'DKK/m²', 'Gennemsnitlig m²-pris (alle)', 'currency_dkk'),
      ('median_m2_pris_alle',
       (SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY m2_pris) FROM public.ejerskifte_historik WHERE m2_pris IS NOT NULL AND m2_pris > 0),
       'DKK/m²', 'Median m²-pris (alle)', 'currency_dkk')
    ON CONFLICT (key) DO UPDATE
      SET value_numeric = EXCLUDED.value_numeric,
          unit = EXCLUDED.unit,
          display_name = EXCLUDED.display_name,
          format = EXCLUDED.format,
          refreshed_at = now();
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[scorecard] m2_pris-blok fejlede (måske kolonne mangler): %', SQLERRM;
  END;

  -- Vurdering
  BEGIN
    INSERT INTO public.intel_scorecard(key, value_numeric, unit, display_name, format) VALUES
      ('sum_ejendomsvaerdi',
       (SELECT COALESCE(SUM(ejendomsvaerdi),0) FROM public.vurdering_cache WHERE ejendomsvaerdi IS NOT NULL),
       'DKK', 'Samlet ejendomsværdi', 'currency_dkk'),
      ('avg_ejendomsvaerdi',
       (SELECT AVG(ejendomsvaerdi) FROM public.vurdering_cache WHERE ejendomsvaerdi IS NOT NULL),
       'DKK', 'Gennemsnitlig ejendomsværdi', 'currency_dkk'),
      ('sum_grundvaerdi',
       (SELECT COALESCE(SUM(grundvaerdi),0) FROM public.vurdering_cache WHERE grundvaerdi IS NOT NULL),
       'DKK', 'Samlet grundværdi', 'currency_dkk')
    ON CONFLICT (key) DO UPDATE
      SET value_numeric = EXCLUDED.value_numeric,
          unit = EXCLUDED.unit,
          display_name = EXCLUDED.display_name,
          format = EXCLUDED.format,
          refreshed_at = now();
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[scorecard] vurdering-blok fejlede: %', SQLERRM;
  END;

  -- Ejer-koncentration
  BEGIN
    INSERT INTO public.intel_scorecard(key, value_numeric, unit, display_name, format) VALUES
      ('count_unique_ejere',
       (SELECT COUNT(DISTINCT COALESCE(ejer_cvr::text, ejer_navn)) FROM public.ejf_ejerskab WHERE status = 'gældende'),
       'antal', 'Antal unikke ejere', 'integer'),
      ('count_unique_ejere_virksomheder',
       (SELECT COUNT(DISTINCT ejer_cvr) FROM public.ejf_ejerskab WHERE status = 'gældende' AND ejer_type = 'virksomhed' AND ejer_cvr IS NOT NULL),
       'antal', 'Antal unikke virksomheds-ejere', 'integer'),
      ('count_unique_ejere_personer',
       (SELECT COUNT(DISTINCT ejer_navn) FROM public.ejf_ejerskab WHERE status = 'gældende' AND ejer_type = 'person'),
       'antal', 'Antal unikke person-ejere', 'integer'),
      ('max_antal_ejendomme_per_ejer',
       (SELECT MAX(antal_ejendomme) FROM public.ejf_ejerskab WHERE status = 'gældende' AND ejer_cvr IS NOT NULL),
       'ejendomme', 'Største ejer-portefølje', 'integer')
    ON CONFLICT (key) DO UPDATE
      SET value_numeric = EXCLUDED.value_numeric,
          unit = EXCLUDED.unit,
          display_name = EXCLUDED.display_name,
          format = EXCLUDED.format,
          refreshed_at = now();
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[scorecard] ejer-blok fejlede: %', SQLERRM;
  END;

  -- BBR arealer
  BEGIN
    INSERT INTO public.intel_scorecard(key, value_numeric, unit, display_name, format) VALUES
      ('sum_areal_bolig',
       (SELECT COALESCE(SUM(samlet_boligareal),0) FROM public.bbr_ejendom_status WHERE is_udfaset = false AND samlet_boligareal IS NOT NULL),
       'm²', 'Samlet boligareal', 'm2'),
      ('sum_areal_erhverv',
       (SELECT COALESCE(SUM(samlet_erhvervsareal),0) FROM public.bbr_ejendom_status WHERE is_udfaset = false AND samlet_erhvervsareal IS NOT NULL),
       'm²', 'Samlet erhvervsareal', 'm2'),
      ('avg_opfoerelsesaar',
       (SELECT AVG(opfoerelsesaar) FROM public.bbr_ejendom_status WHERE is_udfaset = false AND opfoerelsesaar IS NOT NULL),
       'år', 'Gennemsnitligt opførelsesår', 'integer')
    ON CONFLICT (key) DO UPDATE
      SET value_numeric = EXCLUDED.value_numeric,
          unit = EXCLUDED.unit,
          display_name = EXCLUDED.display_name,
          format = EXCLUDED.format,
          refreshed_at = now();
    GET DIAGNOSTICS step = ROW_COUNT; n := n + step;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[scorecard] bbr-arealer-blok fejlede: %', SQLERRM;
  END;

  -- Skriv duration på alle netop-opdaterede keys
  UPDATE public.intel_scorecard
    SET refresh_ms = EXTRACT(MILLISECONDS FROM (clock_timestamp() - t0))::INTEGER
    WHERE refreshed_at >= t0;

  keys_updated := n;
  duration_ms  := EXTRACT(MILLISECONDS FROM (clock_timestamp() - t0))::INTEGER;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_intel_scorecards() TO service_role;

COMMENT ON FUNCTION public.refresh_intel_scorecards() IS
  'BIZZ-1565: Opdaterer alle ~25 intel_scorecard keys i én transaktion. SECURITY DEFINER. Kaldes af /api/cron/refresh-intel-scorecards nightly 03:30 UTC.';
