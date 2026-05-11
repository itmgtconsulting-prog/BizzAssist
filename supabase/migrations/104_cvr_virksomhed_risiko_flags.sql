-- ============================================================================
-- 104_cvr_virksomhed_risiko_flags.sql — BIZZ-1272
-- ============================================================================
-- Tilføj risiko-flags og sekundære brancher til cvr_virksomhed.
-- Kritisk for AML/KYC og Due Diligence moduler.
-- ============================================================================

-- Risiko-flags
ALTER TABLE public.cvr_virksomhed
  ADD COLUMN IF NOT EXISTS hvidvask_omfattet boolean,
  ADD COLUMN IF NOT EXISTS revision_fravalgt boolean,
  ADD COLUMN IF NOT EXISTS reklame_beskyttet boolean;

-- Sekundære brancher
ALTER TABLE public.cvr_virksomhed
  ADD COLUMN IF NOT EXISTS bibranche1_kode text,
  ADD COLUMN IF NOT EXISTS bibranche1_tekst text,
  ADD COLUMN IF NOT EXISTS bibranche2_kode text,
  ADD COLUMN IF NOT EXISTS bibranche2_tekst text,
  ADD COLUMN IF NOT EXISTS bibranche3_kode text,
  ADD COLUMN IF NOT EXISTS bibranche3_tekst text;

-- Virksomhedsoplysninger
ALTER TABLE public.cvr_virksomhed
  ADD COLUMN IF NOT EXISTS formaal text,
  ADD COLUMN IF NOT EXISTS regnskabsaar_start smallint,
  ADD COLUMN IF NOT EXISTS regnskabsaar_slut smallint;

COMMENT ON COLUMN public.cvr_virksomhed.hvidvask_omfattet IS 'BIZZ-1272: Virksomhed er omfattet af hvidvaskloven';
COMMENT ON COLUMN public.cvr_virksomhed.revision_fravalgt IS 'BIZZ-1272: Virksomhed har fravalgt revision';
COMMENT ON COLUMN public.cvr_virksomhed.reklame_beskyttet IS 'BIZZ-1272: Virksomhed er reklame-beskyttet';
COMMENT ON COLUMN public.cvr_virksomhed.bibranche1_kode IS 'BIZZ-1272: Bibranche 1 DB07-kode';
COMMENT ON COLUMN public.cvr_virksomhed.formaal IS 'BIZZ-1272: Virksomhedens formålsbeskrivelse';
COMMENT ON COLUMN public.cvr_virksomhed.regnskabsaar_start IS 'BIZZ-1272: Regnskabsår startmåned (1-12)';
COMMENT ON COLUMN public.cvr_virksomhed.regnskabsaar_slut IS 'BIZZ-1272: Regnskabsår slutmåned (1-12)';

-- Backfill fra eksisterende raw_source JSONB (CVR ES response)
UPDATE public.cvr_virksomhed
SET
  hvidvask_omfattet = CASE
    WHEN raw_source->'virksomhedMetadata'->>'hvidvaskOmfattet' = 'true' THEN true
    WHEN raw_source->'virksomhedMetadata'->>'hvidvaskOmfattet' = 'false' THEN false
    ELSE NULL
  END,
  revision_fravalgt = CASE
    WHEN raw_source->'virksomhedMetadata'->>'revisionFravalgt' = 'true' THEN true
    WHEN raw_source->'virksomhedMetadata'->>'revisionFravalgt' = 'false' THEN false
    ELSE NULL
  END,
  reklame_beskyttet = CASE
    WHEN raw_source->'virksomhedMetadata'->>'reklamebeskyttet' = 'true' THEN true
    WHEN raw_source->'virksomhedMetadata'->>'reklamebeskyttet' = 'false' THEN false
    ELSE NULL
  END,
  formaal = raw_source->'virksomhedMetadata'->'nyesteVirksomhedsform'->>'langBeskrivelse'
WHERE raw_source IS NOT NULL
  AND hvidvask_omfattet IS NULL;

-- Indekser for AML/KYC filtrering
CREATE INDEX IF NOT EXISTS idx_cvr_hvidvask
  ON public.cvr_virksomhed (hvidvask_omfattet)
  WHERE hvidvask_omfattet = true;

CREATE INDEX IF NOT EXISTS idx_cvr_revision_fravalgt
  ON public.cvr_virksomhed (revision_fravalgt)
  WHERE revision_fravalgt = true;

CREATE INDEX IF NOT EXISTS idx_cvr_bibranche1
  ON public.cvr_virksomhed (bibranche1_kode)
  WHERE bibranche1_kode IS NOT NULL;
