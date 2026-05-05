-- ============================================================
-- 084_domain_case_multi_entity.sql — BIZZ-983
-- ============================================================
-- Junction-tabel for multi-entity linking på domain_case.
-- En sag kan nu kobles til 0..n personer, virksomheder og ejendomme.
--
-- Erstatter single-entity model (client_kind/client_cvr/client_person_id).
-- Gamle kolonner bevares som deprecated — fjernes i næste major.
--
-- RLS: Arver domain-scoping via case_id → domain_case.domain_id.
-- ============================================================

CREATE TABLE IF NOT EXISTS domain_case_entity (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  case_id         uuid NOT NULL REFERENCES domain_case(id) ON DELETE CASCADE,
  entity_type     text NOT NULL CHECK (entity_type IN ('company', 'person', 'property')),
  -- entity_id: CVR-nummer (company), enhedsNummer (person), BFE-nummer (property)
  entity_id       text NOT NULL,
  -- Denormaliseret visningsnavn — undgår join for list-rendering
  entity_name     text,
  linked_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE(case_id, entity_type, entity_id)
);

COMMENT ON TABLE domain_case_entity IS
  'BIZZ-983: Junction-tabel for multi-entity linking på sager. '
  'En sag kan kobles til 0..n personer, virksomheder og ejendomme.';

-- Reverse-lookup indexes per entity_type
CREATE INDEX IF NOT EXISTS idx_dce_company
  ON domain_case_entity(entity_id) WHERE entity_type = 'company';
CREATE INDEX IF NOT EXISTS idx_dce_person
  ON domain_case_entity(entity_id) WHERE entity_type = 'person';
CREATE INDEX IF NOT EXISTS idx_dce_property
  ON domain_case_entity(entity_id) WHERE entity_type = 'property';

-- Case-lookup (find alle entities for en sag)
CREATE INDEX IF NOT EXISTS idx_dce_case_id
  ON domain_case_entity(case_id);

-- ── RLS ────────────────────────────────────────────────────────────────
-- Domain-scoped via case_id → domain_case.domain_id
ALTER TABLE domain_case_entity ENABLE ROW LEVEL SECURITY;

CREATE POLICY dce_select_member
  ON domain_case_entity FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM domain_case dc
      WHERE dc.id = case_id
      AND is_domain_member(dc.domain_id)
    )
  );

CREATE POLICY dce_insert_member
  ON domain_case_entity FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM domain_case dc
      WHERE dc.id = case_id
      AND is_domain_member(dc.domain_id)
    )
  );

CREATE POLICY dce_delete_member
  ON domain_case_entity FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM domain_case dc
      WHERE dc.id = case_id
      AND is_domain_member(dc.domain_id)
    )
  );

-- Service role (for server-side operations)
CREATE POLICY dce_service_all
  ON domain_case_entity FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── Data-migration: flyt eksisterende client_link til junction-rows ──
INSERT INTO domain_case_entity (case_id, entity_type, entity_id, entity_name)
SELECT
  id,
  client_kind,
  CASE
    WHEN client_kind = 'company' THEN client_cvr
    WHEN client_kind = 'person' THEN client_person_id
  END,
  client_name
FROM domain_case
WHERE client_kind IS NOT NULL
  AND (client_cvr IS NOT NULL OR client_person_id IS NOT NULL)
ON CONFLICT (case_id, entity_type, entity_id) DO NOTHING;
