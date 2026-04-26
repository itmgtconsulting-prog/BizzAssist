-- BIZZ-713: Extend domain_case + domain_case_doc for the case-detail UI.
--
-- 1) domain_case.notes — free-text notes editable inline on the case page
-- 2) domain_case_doc.deleted_at — soft-delete timestamp (30-day recovery window)
-- 3) domain_case_doc.size_bytes — tracked so we can enforce the 50 MB / 50
--    files per case caps at the API layer
-- 4) Index for soft-delete filtering (common query: active docs per case)

ALTER TABLE public.domain_case
  ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE public.domain_case_doc
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS size_bytes bigint;

CREATE INDEX IF NOT EXISTS ix_domain_case_doc_active
  ON public.domain_case_doc (case_id, created_at DESC)
  WHERE deleted_at IS NULL;
