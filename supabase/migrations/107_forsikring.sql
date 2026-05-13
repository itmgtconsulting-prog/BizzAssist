-- ============================================================
-- Migration 107: Forsikrings-modul (BIZZ-FORSIKRING-MVP / BIZZ-1351)
-- ============================================================
-- Tilføjer fire tenant-scoped tabeller til håndtering af bygnings-
-- forsikringer:
--
--   forsikring_documents  — uploadede PDF-filer (Supabase Storage refs)
--   forsikring_policies   — strukturerede police-data (parsed fra PDF)
--   forsikring_coverages  — enkelte dækninger pr. police
--   forsikring_gaps       — gap-detektioner fra analyse-engine
--
-- Mønster: schema-per-tenant. Tabellerne provisioneres til:
--   1. Nye tenants via udvidelse af provision_tenant_schema()
--   2. Eksisterende tenants via backfill-loop (BIZZ-644 mønster)
--
-- ISO 27001:
--   A.9   — Access Control (RLS pr. tabel)
--   A.12  — Operations (audit_log via app-kode)
--   A.18  — Compliance (PII fra polices håndteret som klassificeret data)
--
-- GDPR:
--   - Polices kan indeholde forsikringstager-CVR + adresser
--   - Retention: 36 mdr efter aftale-udløb (sletning via
--     /api/cron/purge-old-data — udvides senere)
--   - User-deletion: cascade via tenant_id på alle tabeller
-- ============================================================

-- ─── Del 1: provision-helper for forsikrings-tabeller ─────────

CREATE OR REPLACE FUNCTION public.provision_tenant_forsikring_tables(
  p_schema_name text,
  p_tenant_id   uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN

  -- ── 1. forsikring_documents ─────────────────────────────────
  -- Uploaded PDF filer. Reference til Supabase Storage bucket
  -- `forsikring-documents` (private). Holder metadata + ekstraheret tekst.

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.forsikring_documents ('
    '  id              uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id       uuid        NOT NULL DEFAULT %L::uuid,'
    '  storage_path    text        NOT NULL,'
    '  original_name   text        NOT NULL,'
    '  mime_type       text        NOT NULL DEFAULT ''application/pdf'','
    '  size_bytes      bigint      NOT NULL,'
    '  extracted_text  text,'
    '  parse_status    text        NOT NULL DEFAULT ''pending'''
    '                  CHECK (parse_status IN (''pending'',''parsing'',''parsed'',''failed'')),'
    '  parse_error     text,'
    '  policy_id       uuid,'
    '  uploaded_by     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,'
    '  created_at      timestamptz NOT NULL DEFAULT now(),'
    '  updated_at      timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id
  );

  EXECUTE format(
    'ALTER TABLE %I.forsikring_documents ENABLE ROW LEVEL SECURITY',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_documents: members read" ON %I.forsikring_documents'
    '  FOR SELECT USING (public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_documents: members write" ON %I.forsikring_documents'
    '  FOR INSERT WITH CHECK (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_documents: members update" ON %I.forsikring_documents'
    '  FOR UPDATE USING (public.can_tenant_write(tenant_id))'
    '  WITH CHECK (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_documents: admin delete" ON %I.forsikring_documents'
    '  FOR DELETE USING (public.is_tenant_admin(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE TRIGGER forsikring_documents_updated_at'
    '  BEFORE UPDATE ON %I.forsikring_documents'
    '  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at()',
    p_schema_name
  );

  -- ── 2. forsikring_policies ──────────────────────────────────
  -- Strukturerede police-data efter parsing. En police kan referere
  -- tilbage til kilde-dokumentet via document_id, og til en saved_entity
  -- ejendom via property_entity_id (string for CVR/BFE-flexibilitet).

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.forsikring_policies ('
    '  id                    uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id             uuid        NOT NULL DEFAULT %L::uuid,'
    '  document_id           uuid        REFERENCES %I.forsikring_documents(id) ON DELETE SET NULL,'
    '  policy_number         text        NOT NULL,'
    '  insurer_name          text        NOT NULL,'
    '  insurer_cvr           text,'
    '  broker_name           text,'
    '  policyholder_name     text        NOT NULL,'
    '  policyholder_cvr      text,'
    '  policyholder_address  text,'
    '  property_address      text,'
    '  property_matrikel     text,'
    '  property_bfe          text,'
    '  property_entity_id    text,'
    '  business_activity     text,'
    '  building_use          text,'
    '  building_area_m2      integer,'
    '  building_floors       integer,'
    '  building_year_built   integer,'
    '  building_has_basement boolean,'
    '  insurance_form        text'
    '                        CHECK (insurance_form IN (''nyvaerdi'',''sum'',''f_risiko'',''nedrivning'',''uforsikret'')),'
    '  sum_insured_dkk       bigint,'
    '  annual_premium_dkk    integer,'
    '  general_deductible_dkk integer,'
    '  effective_from        date,'
    '  effective_to          date,'
    '  main_renewal_date     date,'
    '  policy_issued_date    date,'
    '  raw_metadata          jsonb       NOT NULL DEFAULT ''{}''::jsonb,'
    '  created_by            uuid        REFERENCES auth.users(id) ON DELETE SET NULL,'
    '  created_at            timestamptz NOT NULL DEFAULT now(),'
    '  updated_at            timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id, p_schema_name
  );

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_forsikring_policies_property '
    'ON %I.forsikring_policies (tenant_id, property_bfe)',
    p_schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_forsikring_policies_renewal '
    'ON %I.forsikring_policies (tenant_id, main_renewal_date)',
    p_schema_name
  );

  EXECUTE format(
    'ALTER TABLE %I.forsikring_policies ENABLE ROW LEVEL SECURITY',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_policies: members read" ON %I.forsikring_policies'
    '  FOR SELECT USING (public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_policies: members write" ON %I.forsikring_policies'
    '  FOR INSERT WITH CHECK (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_policies: members update" ON %I.forsikring_policies'
    '  FOR UPDATE USING (public.can_tenant_write(tenant_id))'
    '  WITH CHECK (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_policies: admin delete" ON %I.forsikring_policies'
    '  FOR DELETE USING (public.is_tenant_admin(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE TRIGGER forsikring_policies_updated_at'
    '  BEFORE UPDATE ON %I.forsikring_policies'
    '  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at()',
    p_schema_name
  );

  -- ── 3. forsikring_coverages ─────────────────────────────────
  -- Enkelte dækninger på en police. En police har typisk 5-15 dækninger
  -- (brand, bygningskasko, glas, sanitet, insekt/svamp, restværdi, ...).
  -- is_covered=false bruges til eksplicit ekskluderede dækninger.

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.forsikring_coverages ('
    '  id              uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id       uuid        NOT NULL DEFAULT %L::uuid,'
    '  policy_id       uuid        NOT NULL REFERENCES %I.forsikring_policies(id) ON DELETE CASCADE,'
    '  coverage_code   text        NOT NULL,'
    '  coverage_label  text        NOT NULL,'
    '  is_covered      boolean     NOT NULL DEFAULT true,'
    '  sum_dkk         bigint,'
    '  deductible_dkk  integer,'
    '  conditions_ref  text,'
    '  notes           text,'
    '  created_at      timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id, p_schema_name
  );

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_forsikring_coverages_policy '
    'ON %I.forsikring_coverages (tenant_id, policy_id)',
    p_schema_name
  );

  EXECUTE format(
    'ALTER TABLE %I.forsikring_coverages ENABLE ROW LEVEL SECURITY',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_coverages: members read" ON %I.forsikring_coverages'
    '  FOR SELECT USING (public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_coverages: members write" ON %I.forsikring_coverages'
    '  FOR INSERT WITH CHECK (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_coverages: members update" ON %I.forsikring_coverages'
    '  FOR UPDATE USING (public.can_tenant_write(tenant_id))'
    '  WITH CHECK (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_coverages: admin delete" ON %I.forsikring_coverages'
    '  FOR DELETE USING (public.is_tenant_admin(tenant_id))',
    p_schema_name
  );

  -- ── 4. forsikring_gaps ──────────────────────────────────────
  -- Gap-detektioner fra analyse-engine. Genberegnes når policer eller
  -- ekstern data (BBR, tinglysning) ændrer sig. severity styrer UI-prioritet.

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.forsikring_gaps ('
    '  id                  uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id           uuid        NOT NULL DEFAULT %L::uuid,'
    '  policy_id           uuid        NOT NULL REFERENCES %I.forsikring_policies(id) ON DELETE CASCADE,'
    '  check_id            text        NOT NULL,'
    '  category            text        NOT NULL,'
    '  severity            text        NOT NULL'
    '                      CHECK (severity IN (''info'',''warning'',''critical'')),'
    '  title               text        NOT NULL,'
    '  description         text        NOT NULL,'
    '  recommendation      text,'
    '  estimated_impact_dkk bigint,'
    '  source_data         jsonb       NOT NULL DEFAULT ''{}''::jsonb,'
    '  is_resolved         boolean     NOT NULL DEFAULT false,'
    '  resolved_at         timestamptz,'
    '  resolved_by         uuid        REFERENCES auth.users(id) ON DELETE SET NULL,'
    '  created_at          timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id, p_schema_name
  );

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_forsikring_gaps_policy '
    'ON %I.forsikring_gaps (tenant_id, policy_id, is_resolved)',
    p_schema_name
  );

  EXECUTE format(
    'ALTER TABLE %I.forsikring_gaps ENABLE ROW LEVEL SECURITY',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_gaps: members read" ON %I.forsikring_gaps'
    '  FOR SELECT USING (public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_gaps: members write" ON %I.forsikring_gaps'
    '  FOR INSERT WITH CHECK (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_gaps: members update" ON %I.forsikring_gaps'
    '  FOR UPDATE USING (public.can_tenant_write(tenant_id))'
    '  WITH CHECK (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_gaps: admin delete" ON %I.forsikring_gaps'
    '  FOR DELETE USING (public.is_tenant_admin(tenant_id))',
    p_schema_name
  );

  -- Foreign key fra documents til policies (sat efter policies eksisterer)
  EXECUTE format(
    'DO $body$ BEGIN '
    'IF NOT EXISTS ('
    '  SELECT 1 FROM information_schema.table_constraints'
    '  WHERE table_schema = %L AND table_name = ''forsikring_documents'''
    '    AND constraint_name = ''forsikring_documents_policy_id_fkey'''
    ') THEN '
    '  ALTER TABLE %I.forsikring_documents '
    '    ADD CONSTRAINT forsikring_documents_policy_id_fkey '
    '    FOREIGN KEY (policy_id) REFERENCES %I.forsikring_policies(id) ON DELETE SET NULL; '
    'END IF; END $body$;',
    p_schema_name, p_schema_name, p_schema_name
  );

END;
$$;

COMMENT ON FUNCTION public.provision_tenant_forsikring_tables(text, uuid) IS
  'Provisionerer forsikrings-tabeller for en tenant. '
  'Kaldes både fra provision_tenant_schema (nye tenants) og fra backfill-loopet '
  'i denne migration (eksisterende tenants). Idempotent.';


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
      RAISE NOTICE 'Skipping schema % — ingen tenants-række med matching schema_name', schema_rec.schema_name;
      CONTINUE;
    END IF;

    PERFORM public.provision_tenant_forsikring_tables(schema_rec.schema_name, tenant_uuid);
    RAISE NOTICE 'Backfilled forsikring-tabeller til %', schema_rec.schema_name;
  END LOOP;
END $$;


-- ─── Del 3: Storage bucket for PDF uploads ────────────────────
-- Private bucket — kun service_role kan læse/skrive. App-kode bruger
-- admin-client til at uploade og generere signed URLs til download.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'forsikring-documents',
  'forsikring-documents',
  false,
  20971520, -- 20 MB
  ARRAY['application/pdf']::text[]
)
ON CONFLICT (id) DO NOTHING;

-- ── RLS for storage.objects (forsikring-documents bucket) ────
-- Path-konvention: {tenant_id}/{policy_id_or_uuid}/{filename}.pdf
-- Service role har fuld adgang. Authenticated users kan IKKE læse direkte —
-- alle downloads går via signed URLs fra app-kode der har verificeret
-- tenant-membership.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'forsikring-documents: service_role full'
  ) THEN
    CREATE POLICY "forsikring-documents: service_role full"
      ON storage.objects FOR ALL
      TO service_role
      USING (bucket_id = 'forsikring-documents')
      WITH CHECK (bucket_id = 'forsikring-documents');
  END IF;
END $$;


COMMENT ON TABLE storage.buckets IS
  'BIZZ-FORSIKRING: forsikring-documents bucket tilføjet i migration 096. '
  'Private, max 20MB, application/pdf only.';
