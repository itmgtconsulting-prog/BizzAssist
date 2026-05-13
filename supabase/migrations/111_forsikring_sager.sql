-- ============================================================
-- Migration 111: forsikring_sager — kundesag-model (BIZZ-1384)
-- ============================================================
-- En sag samler policer, dokumenter, analyser og noter for én kunde.
-- ============================================================

CREATE OR REPLACE FUNCTION public.provision_tenant_forsikring_sager(
  p_schema_name text,
  p_tenant_id   uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.forsikring_sager ('
    '  id              uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id       uuid        NOT NULL DEFAULT %L::uuid,'
    '  kunde_type      text        NOT NULL CHECK (kunde_type IN (''virksomhed'',''person'')),'
    '  kunde_id        text        NOT NULL,'
    '  kunde_navn      text,'
    '  status          text        NOT NULL DEFAULT ''aaben'''
    '                  CHECK (status IN (''aaben'',''under_behandling'',''afsluttet'')),'
    '  ansvarlig       uuid        REFERENCES auth.users(id) ON DELETE SET NULL,'
    '  noter           jsonb       NOT NULL DEFAULT ''[]''::jsonb,'
    '  created_at      timestamptz NOT NULL DEFAULT now(),'
    '  updated_at      timestamptz NOT NULL DEFAULT now(),'
    '  UNIQUE (tenant_id, kunde_type, kunde_id)'
    ')',
    p_schema_name, p_tenant_id
  );

  EXECUTE format(
    'ALTER TABLE %I.forsikring_sager ENABLE ROW LEVEL SECURITY',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_sager: members read" ON %I.forsikring_sager'
    '  FOR SELECT USING (public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_sager: members write" ON %I.forsikring_sager'
    '  FOR INSERT WITH CHECK (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_sager: members update" ON %I.forsikring_sager'
    '  FOR UPDATE USING (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_sager: admin delete" ON %I.forsikring_sager'
    '  FOR DELETE USING (public.is_tenant_admin(tenant_id))',
    p_schema_name
  );

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS ix_forsikring_sager_kunde ON %I.forsikring_sager (tenant_id, kunde_type, kunde_id)',
    p_schema_name
  );

  -- Tilføj sag_id FK til forsikring_policies og forsikring_documents
  EXECUTE format(
    'ALTER TABLE %I.forsikring_policies ADD COLUMN IF NOT EXISTS sag_id uuid',
    p_schema_name
  );
  EXECUTE format(
    'ALTER TABLE %I.forsikring_documents ADD COLUMN IF NOT EXISTS sag_id uuid',
    p_schema_name
  );
END;
$$;

-- Backfill
DO $$
DECLARE
  schema_rec record;
  tenant_uuid uuid;
BEGIN
  FOR schema_rec IN
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant\_%' ESCAPE '\'
  LOOP
    SELECT id INTO tenant_uuid FROM public.tenants
    WHERE schema_name = schema_rec.schema_name LIMIT 1;
    IF tenant_uuid IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = schema_rec.schema_name AND table_name = 'forsikring_policies'
    ) THEN CONTINUE; END IF;
    PERFORM public.provision_tenant_forsikring_sager(schema_rec.schema_name, tenant_uuid);
    RAISE NOTICE 'Provisioned forsikring_sager for %', schema_rec.schema_name;
  END LOOP;
END $$;
