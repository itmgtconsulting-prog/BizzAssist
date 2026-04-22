-- BIZZ-714: track text-extraction status on case + training docs so the UI can
-- surface "could not parse" badges without re-parsing. parse_error holds the
-- human-readable reason when parse_status = 'failed' (truncated as
-- necessary — no secrets because extractor only sees file bytes).

ALTER TABLE public.domain_case_doc
  ADD COLUMN IF NOT EXISTS parse_status text NOT NULL DEFAULT 'pending'
    CHECK (parse_status IN ('pending', 'ok', 'failed', 'truncated')),
  ADD COLUMN IF NOT EXISTS parse_error text;

ALTER TABLE public.domain_training_doc
  ADD COLUMN IF NOT EXISTS parse_status text NOT NULL DEFAULT 'pending'
    CHECK (parse_status IN ('pending', 'ok', 'failed', 'truncated')),
  ADD COLUMN IF NOT EXISTS parse_error text;
