-- Migration 070: Optional customer link on domain_case
--
-- BIZZ-802: Users can search an existing customer in the system (CVR
-- company or person) and link them to a case. All columns are nullable
-- so cases without a linked customer remain valid. The existing
-- `client_ref` free-text column is preserved for backwards compatibility
-- and as a user-supplied reference string.
--
-- `client_kind` is constrained to 'company' | 'person'. When set,
-- exactly one of `client_cvr` (company) or `client_person_id` (person
-- enhedsNummer) should be populated. `client_name` is denormalised so
-- the UI can render the customer name without a cross-table join.

ALTER TABLE domain_case
  ADD COLUMN IF NOT EXISTS client_kind TEXT
    CHECK (client_kind IS NULL OR client_kind IN ('company', 'person')),
  ADD COLUMN IF NOT EXISTS client_cvr TEXT,
  ADD COLUMN IF NOT EXISTS client_person_id TEXT,
  ADD COLUMN IF NOT EXISTS client_name TEXT;

-- Index for "find all cases linked to this company" lookups from the
-- CVR company detail page (future BIZZ-8xx).
CREATE INDEX IF NOT EXISTS idx_domain_case_client_cvr
  ON domain_case(client_cvr)
  WHERE client_cvr IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_domain_case_client_person_id
  ON domain_case(client_person_id)
  WHERE client_person_id IS NOT NULL;

COMMENT ON COLUMN domain_case.client_kind IS
  'Type of linked customer: company (CVR) or person (enhedsNummer). NULL = no link.';
COMMENT ON COLUMN domain_case.client_cvr IS
  'CVR number of linked company customer (8 digits as text). NULL unless client_kind=company.';
COMMENT ON COLUMN domain_case.client_person_id IS
  'enhedsNummer of linked person (CVR deltager). NULL unless client_kind=person.';
COMMENT ON COLUMN domain_case.client_name IS
  'Denormalised customer display name — avoids a join for list rendering.';
