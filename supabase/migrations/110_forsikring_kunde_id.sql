-- ============================================================
-- Migration 110: Tilføj kunde_id til forsikring-tabeller (BIZZ-1384)
-- ============================================================
-- Tilknytter policer og dokumenter til en specifik kunde (CVR/person).
-- Gør det muligt at filtrere policer per kunde og gemme analysehistorik.
-- ============================================================

-- Udvid provision-helper med kunde_id kolonne
CREATE OR REPLACE FUNCTION public.provision_tenant_forsikring_kunde_id(
  p_schema_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- forsikring_policies: tilføj kunde_id (nullable — backward compat)
  EXECUTE format(
    'ALTER TABLE %I.forsikring_policies ADD COLUMN IF NOT EXISTS kunde_id text',
    p_schema_name
  );
  -- forsikring_documents: tilføj kunde_id
  EXECUTE format(
    'ALTER TABLE %I.forsikring_documents ADD COLUMN IF NOT EXISTS kunde_id text',
    p_schema_name
  );
  -- Index for filtrering per kunde
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS ix_forsikring_policies_kunde ON %I.forsikring_policies (kunde_id) WHERE kunde_id IS NOT NULL',
    p_schema_name
  );
END;
$$;

-- Backfill alle eksisterende tenant-schemaer
DO $$
DECLARE
  schema_rec record;
BEGIN
  FOR schema_rec IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant\_%' ESCAPE '\'
  LOOP
    -- Tjek at forsikring_policies eksisterer (migration 107 kørte)
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = schema_rec.schema_name
        AND table_name = 'forsikring_policies'
    ) THEN
      PERFORM public.provision_tenant_forsikring_kunde_id(schema_rec.schema_name);
      RAISE NOTICE 'Added kunde_id to %', schema_rec.schema_name;
    END IF;
  END LOOP;
END $$;
