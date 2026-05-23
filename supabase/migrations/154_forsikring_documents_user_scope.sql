-- ============================================================================
-- 154: Scope forsikring_documents til uploaded_by (BIZZ-1791)
-- ============================================================================
-- Ændrer RLS SELECT policy fra is_tenant_member (alle i tenant) til
-- uploaded_by = auth.uid() (kun brugerens egne docs).
-- Domain-brugere kan tilføjes som undtagelse i fremtidig migration.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.provision_forsikring_user_scope(
  p_schema_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Drop eksisterende SELECT policy (den der giver alle tenant-members adgang)
  EXECUTE format(
    'DROP POLICY IF EXISTS "forsikring_documents: members read" ON %I.forsikring_documents',
    p_schema_name
  );
  -- Ny SELECT policy: kun egne docs (uploaded_by = auth.uid())
  EXECUTE format(
    'CREATE POLICY "forsikring_documents: own docs read" ON %I.forsikring_documents'
    '  FOR SELECT USING (uploaded_by = auth.uid() OR public.is_tenant_admin(tenant_id))',
    p_schema_name
  );
  -- Index for hurtige opslag per uploaded_by + kunde_id
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS ix_forsikring_docs_user_kunde ON %I.forsikring_documents (uploaded_by, kunde_id) WHERE kunde_id IS NOT NULL',
    p_schema_name
  );
END;
$$;

-- Backfill alle tenant-schemaer
DO $$
DECLARE
  schema_rec record;
BEGIN
  FOR schema_rec IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant\_%' ESCAPE '\'
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = schema_rec.schema_name
        AND table_name = 'forsikring_documents'
    ) THEN
      PERFORM public.provision_forsikring_user_scope(schema_rec.schema_name);
    END IF;
  END LOOP;
END $$;

COMMENT ON FUNCTION public.provision_forsikring_user_scope IS
  'BIZZ-1791: Scope forsikring_documents SELECT til uploaded_by = auth.uid() + admin override';
