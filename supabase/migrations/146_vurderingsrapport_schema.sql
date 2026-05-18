-- ============================================================
-- Migration 146: vurderingsrapport — sags-baseret ejendomsvurdering (BIZZ-1640)
-- ============================================================
-- Sag → Upload-zoner → Dokumenter → Rapport-tabs
-- Pattern: tenant-schema provisioning (same as forsikring_sager 111)
-- ============================================================

CREATE OR REPLACE FUNCTION public.provision_tenant_vurdering_sager(
  p_schema_name text,
  p_tenant_id   uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Sager
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.vurdering_sager ('
    '  id              uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id       uuid        NOT NULL DEFAULT %L::uuid,'
    '  sag_nummer      text        NOT NULL,'
    '  beskrivelse     text,'
    '  kunde_type      text        NOT NULL CHECK (kunde_type IN (''virksomhed'',''person'')),'
    '  kunde_id        text        NOT NULL,'
    '  kunde_navn      text,'
    '  ejendom_bfe     bigint,'
    '  ejendom_adresse text,'
    '  ejendom_dawa_id text,'
    '  domain_id       uuid,'
    '  rapport_tone    text        DEFAULT ''realkredit'' CHECK (rapport_tone IN (''realkredit'',''bankraadgiver'',''memo'')),'
    '  status          text        NOT NULL DEFAULT ''oprettet'' CHECK (status IN (''oprettet'',''dataindsamling'',''rapport_genereret'',''afsluttet'')),'
    '  created_by      uuid        REFERENCES auth.users(id),'
    '  created_at      timestamptz NOT NULL DEFAULT now(),'
    '  updated_at      timestamptz NOT NULL DEFAULT now(),'
    '  UNIQUE (tenant_id, sag_nummer)'
    ')',
    p_schema_name, p_tenant_id
  );

  EXECUTE format('ALTER TABLE %I.vurdering_sager ENABLE ROW LEVEL SECURITY', p_schema_name);
  EXECUTE format(
    'CREATE POLICY "vurdering_sager: members read" ON %I.vurdering_sager'
    '  FOR ALL USING (tenant_id = %L::uuid)',
    p_schema_name, p_tenant_id
  );

  -- Upload-zoner
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.vurdering_upload_zoner ('
    '  id          uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  sag_id      uuid        NOT NULL REFERENCES %I.vurdering_sager(id) ON DELETE CASCADE,'
    '  tenant_id   uuid        NOT NULL DEFAULT %L::uuid,'
    '  zone_type   text        NOT NULL CHECK (zone_type IN (''lejeindtaegter'',''driftsudgifter'',''besigtigelse'',''referenceejendomme'',''oevrige'')),'
    '  fritekst    text,'
    '  created_at  timestamptz DEFAULT now(),'
    '  updated_at  timestamptz DEFAULT now(),'
    '  UNIQUE (sag_id, zone_type)'
    ')',
    p_schema_name, p_schema_name, p_tenant_id
  );

  EXECUTE format('ALTER TABLE %I.vurdering_upload_zoner ENABLE ROW LEVEL SECURITY', p_schema_name);
  EXECUTE format(
    'CREATE POLICY "vurdering_upload_zoner: members read" ON %I.vurdering_upload_zoner'
    '  FOR ALL USING (tenant_id = %L::uuid)',
    p_schema_name, p_tenant_id
  );

  -- Dokumenter
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.vurdering_dokumenter ('
    '  id              uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  sag_id          uuid        NOT NULL REFERENCES %I.vurdering_sager(id) ON DELETE CASCADE,'
    '  zone_id         uuid        NOT NULL REFERENCES %I.vurdering_upload_zoner(id) ON DELETE CASCADE,'
    '  tenant_id       uuid        NOT NULL DEFAULT %L::uuid,'
    '  storage_path    text        NOT NULL,'
    '  original_name   text        NOT NULL,'
    '  mime_type       text        NOT NULL,'
    '  size_bytes      integer     NOT NULL DEFAULT 0,'
    '  parse_status    text        NOT NULL DEFAULT ''pending'' CHECK (parse_status IN (''pending'',''parsing'',''parsed'',''failed'')),'
    '  parse_error     text,'
    '  parsed_data     jsonb,'
    '  uploaded_by     uuid        REFERENCES auth.users(id),'
    '  created_at      timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_schema_name, p_schema_name, p_tenant_id
  );

  EXECUTE format('ALTER TABLE %I.vurdering_dokumenter ENABLE ROW LEVEL SECURITY', p_schema_name);
  EXECUTE format(
    'CREATE POLICY "vurdering_dokumenter: members read" ON %I.vurdering_dokumenter'
    '  FOR ALL USING (tenant_id = %L::uuid)',
    p_schema_name, p_tenant_id
  );

  -- Rapport-tabs (8 sektioner)
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.vurdering_rapport_tabs ('
    '  id          uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  sag_id      uuid        NOT NULL REFERENCES %I.vurdering_sager(id) ON DELETE CASCADE,'
    '  tenant_id   uuid        NOT NULL DEFAULT %L::uuid,'
    '  tab_key     text        NOT NULL CHECK (tab_key IN (''identifikation'',''bygningsdata'',''energi'',''vurdering_skat'',''tinglysning'',''servitutter'',''beliggenhed'',''risiko'')),'
    '  indhold     jsonb       NOT NULL DEFAULT ''{}''::jsonb,'
    '  ai_genereret boolean    NOT NULL DEFAULT false,'
    '  redigeret   boolean     NOT NULL DEFAULT false,'
    '  created_at  timestamptz DEFAULT now(),'
    '  updated_at  timestamptz DEFAULT now(),'
    '  UNIQUE (sag_id, tab_key)'
    ')',
    p_schema_name, p_schema_name, p_tenant_id
  );

  EXECUTE format('ALTER TABLE %I.vurdering_rapport_tabs ENABLE ROW LEVEL SECURITY', p_schema_name);
  EXECUTE format(
    'CREATE POLICY "vurdering_rapport_tabs: members read" ON %I.vurdering_rapport_tabs'
    '  FOR ALL USING (tenant_id = %L::uuid)',
    p_schema_name, p_tenant_id
  );
END;
$$;

COMMENT ON FUNCTION public.provision_tenant_vurdering_sager IS
  'BIZZ-1640: Provision vurderingsrapport tables in a tenant schema';
