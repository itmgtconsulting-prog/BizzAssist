-- BIZZ-2105: Kodificér AI-klassificeringskolonner på forsikring_standard_doc.
-- Kolonnerne blev oprindeligt tilføjet ad-hoc i test/prod (uden migrationsfil),
-- så dev manglede dem helt. Idempotent — no-op hvor de allerede findes.
ALTER TABLE forsikring_standard_doc
  ADD COLUMN IF NOT EXISTS selskab_normaliseret text,
  ADD COLUMN IF NOT EXISTS omraade text,
  ADD COLUMN IF NOT EXISTS gyldig_fra date,
  ADD COLUMN IF NOT EXISTS is_valid_standard boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS ai_metadata jsonb DEFAULT '{}'::jsonb;
