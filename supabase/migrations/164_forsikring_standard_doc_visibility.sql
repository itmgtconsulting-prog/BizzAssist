-- Migration 164: Tilføj visibility-scoping til forsikring_standard_doc (BIZZ-1907/1919)
-- Lukker privacy-lækage: standard betingelser var synlige for ALLE authenticated users.
-- Nu: private (kun uploader), domain (delt med domain-medlemmer), curated (BizzAssist).

ALTER TABLE forsikring_standard_doc
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'
  CHECK (visibility IN ('private', 'domain', 'curated'));

-- Backfill: eksisterende rows bliver private
UPDATE forsikring_standard_doc SET visibility = 'private' WHERE visibility IS NULL;

-- Drop gammel "read all" policy og erstat med scoped
DROP POLICY IF EXISTS "forsikring_standard_doc: read authenticated" ON forsikring_standard_doc;
CREATE POLICY "forsikring_standard_doc: read scoped"
  ON forsikring_standard_doc FOR SELECT TO authenticated
  USING (
    visibility = 'curated'
    OR added_by_user = auth.uid()
    OR (visibility = 'domain' AND added_by_domain IN (
      SELECT domain_id FROM domain_member WHERE user_id = auth.uid()
    ))
  );
