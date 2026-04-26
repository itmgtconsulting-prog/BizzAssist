-- Migration 071: Link case-docs back to the generation they originated from.
--
-- BIZZ-803: When a user approves an AI-generated document from the preview
-- panel, we copy it into domain_case_doc so it follows the same lifecycle
-- as other case documents. Storing the originating generation_id enables:
--   * Idempotency — the attach-to-case endpoint can detect that a
--     generation has already been attached and skip the copy.
--   * Traceability — users can see which docs were AI-generated vs. uploaded.
--
-- Nullable because 99%+ of case docs are plain uploads.

ALTER TABLE domain_case_doc
  ADD COLUMN IF NOT EXISTS generation_id UUID
    REFERENCES domain_generation(id) ON DELETE SET NULL;

-- Partial index — only rows that ARE linked to a generation are worth
-- indexing; full-table scans for NULLs are not a target workload.
CREATE INDEX IF NOT EXISTS idx_domain_case_doc_generation_id
  ON domain_case_doc(generation_id)
  WHERE generation_id IS NOT NULL;

COMMENT ON COLUMN domain_case_doc.generation_id IS
  'When non-null, this case-doc was copied from the referenced AI generation output. NULL for manually-uploaded docs.';
