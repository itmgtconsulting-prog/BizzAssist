-- ============================================================
-- Migration 112: forsikring_analyse_documents — analyse-centreret model (BIZZ-1404)
-- ============================================================
-- Junction-tabel mellem analyser og dokumenter (many-to-many).
-- analyse_id på forsikring_gaps for per-analyse gap-scoping.
-- sag_id på forsikring_analyser for kunde-sag link.
-- ============================================================

CREATE OR REPLACE FUNCTION public.provision_tenant_forsikring_analyse_documents(
  p_schema_name text,
  p_tenant_id   uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- ─── 1. Junction-tabel: forsikring_analyse_documents ──────
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.forsikring_analyse_documents ('
    '  id              uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id       uuid        NOT NULL DEFAULT %L::uuid,'
    '  analyse_id      uuid        NOT NULL,'
    '  document_id     uuid        NOT NULL,'
    '  source          text        NOT NULL DEFAULT ''uploaded'''
    '                  CHECK (source IN (''uploaded'',''reused'')),'
    '  created_at      timestamptz NOT NULL DEFAULT now(),'
    '  UNIQUE (analyse_id, document_id)'
    ')',
    p_schema_name, p_tenant_id
  );

  -- RLS
  EXECUTE format(
    'ALTER TABLE %I.forsikring_analyse_documents ENABLE ROW LEVEL SECURITY',
    p_schema_name
  );
  EXECUTE format(
    'DO $rls$ BEGIN '
    '  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = %L AND tablename = ''forsikring_analyse_documents'' AND policyname = ''forsikring_analyse_documents: members read'') THEN '
    '    CREATE POLICY "forsikring_analyse_documents: members read" ON %I.forsikring_analyse_documents FOR SELECT USING (public.is_tenant_member(tenant_id)); '
    '  END IF; '
    '  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = %L AND tablename = ''forsikring_analyse_documents'' AND policyname = ''forsikring_analyse_documents: members write'') THEN '
    '    CREATE POLICY "forsikring_analyse_documents: members write" ON %I.forsikring_analyse_documents FOR INSERT WITH CHECK (public.can_tenant_write(tenant_id)); '
    '  END IF; '
    '  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = %L AND tablename = ''forsikring_analyse_documents'' AND policyname = ''forsikring_analyse_documents: admin delete'') THEN '
    '    CREATE POLICY "forsikring_analyse_documents: admin delete" ON %I.forsikring_analyse_documents FOR DELETE USING (public.is_tenant_admin(tenant_id)); '
    '  END IF; '
    'END $rls$',
    p_schema_name, p_schema_name,
    p_schema_name, p_schema_name,
    p_schema_name, p_schema_name
  );

  -- Indexes
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS ix_fad_analyse ON %I.forsikring_analyse_documents (analyse_id)',
    p_schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS ix_fad_document ON %I.forsikring_analyse_documents (document_id)',
    p_schema_name
  );

  -- ─── 2. analyse_id på forsikring_gaps ─────────────────────
  EXECUTE format(
    'ALTER TABLE %I.forsikring_gaps ADD COLUMN IF NOT EXISTS analyse_id uuid',
    p_schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS ix_forsikring_gaps_analyse ON %I.forsikring_gaps (analyse_id) WHERE analyse_id IS NOT NULL',
    p_schema_name
  );

  -- ─── 3. sag_id på forsikring_analyser ─────────────────────
  EXECUTE format(
    'ALTER TABLE %I.forsikring_analyser ADD COLUMN IF NOT EXISTS sag_id uuid',
    p_schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS ix_forsikring_analyser_sag ON %I.forsikring_analyser (sag_id) WHERE sag_id IS NOT NULL',
    p_schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS ix_forsikring_analyser_kunde ON %I.forsikring_analyser (kunde_id)',
    p_schema_name
  );

  -- ─── 4. Data-backfill: link eksisterende docs til analyser ─
  -- For hver analyse: find policies der matcher via kunde_id, find deres documents, opret links
  EXECUTE format(
    'INSERT INTO %I.forsikring_analyse_documents (tenant_id, analyse_id, document_id, source) '
    'SELECT DISTINCT p.tenant_id, a.id, d.id, ''uploaded'' '
    'FROM %I.forsikring_analyser a '
    'JOIN %I.forsikring_policies p ON p.kunde_id = a.kunde_id AND p.tenant_id = a.tenant_id '
    'JOIN %I.forsikring_documents d ON d.id = p.document_id AND d.tenant_id = p.tenant_id '
    'WHERE d.id IS NOT NULL '
    'ON CONFLICT (analyse_id, document_id) DO NOTHING',
    p_schema_name,
    p_schema_name, p_schema_name, p_schema_name
  );

  -- ─── 5. Backfill analyse_id på gaps via policy → analyse link ─
  EXECUTE format(
    'UPDATE %I.forsikring_gaps g '
    'SET analyse_id = ad.analyse_id '
    'FROM %I.forsikring_analyse_documents ad '
    'JOIN %I.forsikring_documents d ON d.id = ad.document_id '
    'JOIN %I.forsikring_policies p ON p.document_id = d.id '
    'WHERE g.policy_id = p.id AND g.analyse_id IS NULL '
    'AND ad.tenant_id = g.tenant_id',
    p_schema_name,
    p_schema_name, p_schema_name, p_schema_name
  );

END;
$$;

-- Backfill alle tenant-schemas
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
      WHERE table_schema = schema_rec.schema_name AND table_name = 'forsikring_analyser'
    ) THEN CONTINUE; END IF;
    PERFORM public.provision_tenant_forsikring_analyse_documents(schema_rec.schema_name, tenant_uuid);
    RAISE NOTICE 'Provisioned forsikring_analyse_documents for %', schema_rec.schema_name;
  END LOOP;
END $$;
