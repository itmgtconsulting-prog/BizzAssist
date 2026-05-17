-- ============================================================
-- Migration 109: forsikring_analyser + forsikring_aktiver (BIZZ-1361)
-- ============================================================
-- Tilføjer to nye tenant-scoped tabeller til forsikrings-modulet:
--
--   forsikring_analyser  — én row pr. gap-analyse-kørsel
--   forsikring_aktiver   — assets opdaget under koncern-walk
--
-- Mønster: schema-per-tenant via provision-helper + backfill-loop.
--
-- GDPR:
--   - Aktiver kan indeholde adresser + CVR
--   - Retention: 36 mdr (sletning via purge-old-data cron)
--   - Cascade: slet analyse → aktiver slettes
-- ============================================================

-- ─── Del 1: Udvid provision-helper ────────────────────────────

CREATE OR REPLACE FUNCTION public.provision_tenant_forsikring_analyser_tables(
  p_schema_name text,
  p_tenant_id   uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN

  -- ── 1. forsikring_analyser ──────────────────────────────────
  -- Én row pr. gap-analyse-kørsel. Gemmer kunde-info + sammendrag.

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.forsikring_analyser ('
    '  id              uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id       uuid        NOT NULL DEFAULT %L::uuid,'
    '  kunde_type      text        NOT NULL CHECK (kunde_type IN (''virksomhed'',''person'')),'
    '  kunde_id        text        NOT NULL,'
    '  kunde_navn      text,'
    '  total_aktiver   int         NOT NULL DEFAULT 0,'
    '  insured_count   int         NOT NULL DEFAULT 0,'
    '  uninsured_count int         NOT NULL DEFAULT 0,'
    '  total_risk_score int        NOT NULL DEFAULT 0,'
    '  summary         jsonb,'
    '  created_by      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,'
    '  created_at      timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id
  );

  EXECUTE format(
    'ALTER TABLE %I.forsikring_analyser ENABLE ROW LEVEL SECURITY',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_analyser: members read" ON %I.forsikring_analyser'
    '  FOR SELECT USING (public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_analyser: members write" ON %I.forsikring_analyser'
    '  FOR INSERT WITH CHECK (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_analyser: admin delete" ON %I.forsikring_analyser'
    '  FOR DELETE USING (public.is_tenant_admin(tenant_id))',
    p_schema_name
  );

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS ix_forsikring_analyser_tenant ON %I.forsikring_analyser (tenant_id, created_at DESC)',
    p_schema_name
  );

  -- ── 2. forsikring_aktiver ───────────────────────────────────
  -- Assets opdaget under koncern-walk. FK til forsikring_analyser
  -- med cascade-delete. Optionelt FK til forsikring_policies (match).

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.forsikring_aktiver ('
    '  id                uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id         uuid        NOT NULL DEFAULT %L::uuid,'
    '  analyse_id        uuid        NOT NULL REFERENCES %I.forsikring_analyser(id) ON DELETE CASCADE,'
    '  type              text        NOT NULL CHECK (type IN (''ejendom'',''virksomhed'',''bil'',''bestyrelsespost'')),'
    '  label             text        NOT NULL,'
    '  bfe               int,'
    '  cvr               text,'
    '  regnr             text,'
    '  vaerdi_dkk        bigint,'
    '  haeftelser_dkk    bigint,'
    '  byggeaar          int,'
    '  ansatte           int,'
    '  adresse           text,'
    '  matched_policy_id uuid,'
    '  match_score       int,'
    '  raw_data          jsonb,'
    '  created_at        timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id, p_schema_name
  );

  EXECUTE format(
    'ALTER TABLE %I.forsikring_aktiver ENABLE ROW LEVEL SECURITY',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_aktiver: members read" ON %I.forsikring_aktiver'
    '  FOR SELECT USING (public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_aktiver: members write" ON %I.forsikring_aktiver'
    '  FOR INSERT WITH CHECK (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_aktiver: admin delete" ON %I.forsikring_aktiver'
    '  FOR DELETE USING (public.is_tenant_admin(tenant_id))',
    p_schema_name
  );

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS ix_forsikring_aktiver_analyse ON %I.forsikring_aktiver (analyse_id)',
    p_schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS ix_forsikring_aktiver_tenant ON %I.forsikring_aktiver (tenant_id)',
    p_schema_name
  );

  -- FK fra aktiver.matched_policy_id → forsikring_policies (hvis policies-tabel eksisterer)
  EXECUTE format(
    'DO $body$ BEGIN '
    'IF NOT EXISTS ('
    '  SELECT 1 FROM information_schema.table_constraints'
    '  WHERE table_schema = %L AND table_name = ''forsikring_aktiver'''
    '    AND constraint_name = ''forsikring_aktiver_policy_fkey'''
    ') AND EXISTS ('
    '  SELECT 1 FROM information_schema.tables'
    '  WHERE table_schema = %L AND table_name = ''forsikring_policies'''
    ') THEN '
    '  ALTER TABLE %I.forsikring_aktiver '
    '    ADD CONSTRAINT forsikring_aktiver_policy_fkey '
    '    FOREIGN KEY (matched_policy_id) REFERENCES %I.forsikring_policies(id) ON DELETE SET NULL; '
    'END IF; END $body$;',
    p_schema_name, p_schema_name, p_schema_name, p_schema_name
  );

END;
$$;

COMMENT ON FUNCTION public.provision_tenant_forsikring_analyser_tables(text, uuid) IS
  'BIZZ-1361: Provisionerer forsikring_analyser + forsikring_aktiver for en tenant. '
  'Cascade-delete: slet analyse → aktiver slettes. Idempotent.';


-- ─── Del 2: Backfill alle eksisterende tenant_*-schemaer ──────

DO $$
DECLARE
  schema_rec  record;
  tenant_uuid uuid;
BEGIN
  FOR schema_rec IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant\_%' ESCAPE '\'
  LOOP
    SELECT id INTO tenant_uuid
      FROM public.tenants
     WHERE schema_name = schema_rec.schema_name
     LIMIT 1;

    IF tenant_uuid IS NULL THEN
      RAISE NOTICE 'Skipping schema % — ingen tenants-række', schema_rec.schema_name;
      CONTINUE;
    END IF;

    PERFORM public.provision_tenant_forsikring_analyser_tables(schema_rec.schema_name, tenant_uuid);
    RAISE NOTICE 'Backfilled forsikring_analyser+aktiver til %', schema_rec.schema_name;
  END LOOP;
END $$;
