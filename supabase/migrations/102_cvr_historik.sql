-- ============================================================================
-- 102_cvr_historik.sql — BIZZ-1277
-- ============================================================================
-- Ændringshistorik for CVR-virksomheder.
-- CVR ES leverer komplet historik (navn, adresse, status, branche, form,
-- fusion, spaltning med fra/til-datoer). I dag gemmes kun seneste værdi
-- i cvr_virksomhed — hele historikken tabes.
--
-- Estimat: ~10M rækker (2,1M virksomheder × ~5 historik-rækker gns.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.cvr_historik (
  id              bigserial     PRIMARY KEY,
  cvr             text          NOT NULL,
  -- Felt der ændres: navn, adresse, status, branche, form, fusion, spaltning
  felt            text          NOT NULL,
  -- Værdi-par: fra/til
  vaerdi_fra      text,
  vaerdi_til      text,
  -- Bitemporale felter
  gyldig_fra      date,
  gyldig_til      date,
  -- Metadata
  sidst_opdateret timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cvr_historik IS
  'BIZZ-1277: CVR ændringshistorik — navn, adresse, status, branche, '
  'form, fusion, spaltning med fra/til-datoer. Populeres fra CVR ES.';

-- Primær lookup: alle ændringer for en virksomhed
CREATE INDEX IF NOT EXISTS idx_cvr_historik_cvr
  ON public.cvr_historik (cvr);

-- Filtrering per felt-type
CREATE INDEX IF NOT EXISTS idx_cvr_historik_cvr_felt
  ON public.cvr_historik (cvr, felt);

-- Tidsbaseret søgning (fx "virksomheder der skiftede status i Q1 2025")
CREATE INDEX IF NOT EXISTS idx_cvr_historik_gyldig
  ON public.cvr_historik (gyldig_fra)
  WHERE gyldig_fra IS NOT NULL;

-- RLS: offentlige CVR-data, kan læses af alle authenticated
ALTER TABLE public.cvr_historik ENABLE ROW LEVEL SECURITY;

CREATE POLICY cvr_historik_read_authenticated
  ON public.cvr_historik
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY cvr_historik_write_service_only
  ON public.cvr_historik
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
