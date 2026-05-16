-- Migration 138: AI-ekstraktion cache for indskannede tinglysningsakter
-- Gemmer struktureret data udtrukket fra scannede PDF'er via Claude Vision.
-- Kører kun én gang per ejendom/akt — cache-first pattern.

CREATE TABLE IF NOT EXISTS public.tinglysning_akt_extraction (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bfe_nummer      BIGINT      NOT NULL,
  akt_navn        TEXT        NOT NULL,
  extraction      JSONB       NOT NULL,   -- AktExtraction JSON med handler[]
  extracted_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(bfe_nummer, akt_navn)
);

CREATE INDEX IF NOT EXISTS idx_akt_extraction_bfe ON public.tinglysning_akt_extraction (bfe_nummer);

ALTER TABLE public.tinglysning_akt_extraction ENABLE ROW LEVEL SECURITY;
CREATE POLICY "akt_extraction: service_role full" ON public.tinglysning_akt_extraction FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "akt_extraction: authenticated read" ON public.tinglysning_akt_extraction FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.tinglysning_akt_extraction IS 'Cache for AI-ekstraherede data fra indskannede tinglysningsakter. Kører kun én gang per BFE/akt.';
