-- ============================================================
-- Migration 183: Master tenant-provisioning orchestrator (BIZZ-2165)
-- ============================================================
-- Rod-årsag: provisionTenantForUser (lib/tenant/provisionTenant.ts) oprettede
-- kun base-tabeller + ai_chat ved signup. Forsikring-, vurdering- og øvrige
-- feature-tabeller blev ALDRIG provisioneret for nye brugere — de blev kun
-- bagudfyldt via ad-hoc migration-DO-blokke. Resultat: nye brugere (fx
-- slj@rtm.dk) kunne ikke uploade policer fordi forsikring_documents-tabellen
-- ikke fandtes i deres schema.
--
-- Derudover var per-feature provision-funktionerne drevet ud af sync mellem de
-- tre miljøer (LOCAL/PREVIEW/PROD):
--   * provision_tenant_forsikring_gaps_analyse_fk manglede i PROD + LOCAL
--   * provision_tenant_vurdering_sager manglede i LOCAL
--   * provision_tenant_schema_ttl_patch manglede i PROD
--   * provision_forsikring_user_scope manglede i ALLE miljøer
--
-- Denne migration:
--   1. (Gen)opretter de fire driftende funktioner så de findes ens i alle 3 miljøer.
--   2. Definerer ÉN orchestrator, provision_tenant_all_features(schema, tenant),
--      der idempotent kalder hele feature-kæden i korrekt FK-rækkefølge.
--   3. Bagudfylder ALLE eksisterende tenant-schemaer.
--
-- Wires ind i provisionTenantForUser så nye brugere får ALLE tabeller.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1a. forsikring_documents user-scope RLS (mig 154, BIZZ-1791)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.provision_forsikring_user_scope(
  p_schema_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  EXECUTE format(
    'DROP POLICY IF EXISTS "forsikring_documents: members read" ON %I.forsikring_documents',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "forsikring_documents: own docs read" ON %I.forsikring_documents'
    '  FOR SELECT USING (uploaded_by = auth.uid() OR public.is_tenant_admin(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS ix_forsikring_docs_user_kunde ON %I.forsikring_documents (uploaded_by, kunde_id) WHERE kunde_id IS NOT NULL',
    p_schema_name
  );
EXCEPTION WHEN duplicate_object THEN
  -- Policy findes allerede — idempotent no-op.
  NULL;
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- 1b. forsikring_gaps → analyser FK med ON DELETE CASCADE (mig 182, BIZZ-2159)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.provision_tenant_forsikring_gaps_analyse_fk(
  p_schema_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  EXECUTE format(
    'DELETE FROM %I.forsikring_gaps g '
    'WHERE g.analyse_id IS NOT NULL '
    'AND NOT EXISTS (SELECT 1 FROM %I.forsikring_analyser an WHERE an.id = g.analyse_id)',
    p_schema_name, p_schema_name
  );
  EXECUTE format(
    'DO $body$ BEGIN '
    'IF NOT EXISTS ('
    '  SELECT 1 FROM information_schema.table_constraints'
    '  WHERE table_schema = %L AND table_name = ''forsikring_gaps'''
    '    AND constraint_name = ''forsikring_gaps_analyse_id_fkey'''
    ') THEN '
    '  ALTER TABLE %I.forsikring_gaps '
    '    ADD CONSTRAINT forsikring_gaps_analyse_id_fkey '
    '    FOREIGN KEY (analyse_id) REFERENCES %I.forsikring_analyser(id) ON DELETE CASCADE; '
    'END IF; END $body$;',
    p_schema_name, p_schema_name, p_schema_name
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- 1c. recent_entities / notifications TTL-indekser (mig 024, BIZZ-133)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.provision_tenant_schema_ttl_patch(p_schema_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS recent_entities_visited_at_idx ON %I.recent_entities (visited_at)',
    p_schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS notifications_created_at_is_read_idx ON %I.notifications (created_at, is_read)',
    p_schema_name
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- 1d. vurderingsrapport-tabeller (mig 146, BIZZ-1640)
-- ─────────────────────────────────────────────────────────────
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
  EXECUTE format('DROP POLICY IF EXISTS "vurdering_sager: members read" ON %I.vurdering_sager', p_schema_name);
  EXECUTE format(
    'CREATE POLICY "vurdering_sager: members read" ON %I.vurdering_sager'
    '  FOR ALL USING (tenant_id = %L::uuid)',
    p_schema_name, p_tenant_id
  );

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
  EXECUTE format('DROP POLICY IF EXISTS "vurdering_upload_zoner: members read" ON %I.vurdering_upload_zoner', p_schema_name);
  EXECUTE format(
    'CREATE POLICY "vurdering_upload_zoner: members read" ON %I.vurdering_upload_zoner'
    '  FOR ALL USING (tenant_id = %L::uuid)',
    p_schema_name, p_tenant_id
  );

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
  EXECUTE format('DROP POLICY IF EXISTS "vurdering_dokumenter: members read" ON %I.vurdering_dokumenter', p_schema_name);
  EXECUTE format(
    'CREATE POLICY "vurdering_dokumenter: members read" ON %I.vurdering_dokumenter'
    '  FOR ALL USING (tenant_id = %L::uuid)',
    p_schema_name, p_tenant_id
  );

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
  EXECUTE format('DROP POLICY IF EXISTS "vurdering_rapport_tabs: members read" ON %I.vurdering_rapport_tabs', p_schema_name);
  EXECUTE format(
    'CREATE POLICY "vurdering_rapport_tabs: members read" ON %I.vurdering_rapport_tabs'
    '  FOR ALL USING (tenant_id = %L::uuid)',
    p_schema_name, p_tenant_id
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- 2. Master-orchestrator: provisionér HELE feature-kæden idempotent.
--    Hvert trin er pakket i sin egen EXCEPTION-blok så ét fejlende
--    feature-modul ikke afbryder de øvrige (vigtigt ved bagudfyldning).
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.provision_tenant_all_features(
  p_schema_name text,
  p_tenant_id   uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- AI chat (mig 073)
  BEGIN PERFORM public.provision_ai_chat_tables(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features ai_chat %: %', p_schema_name, SQLERRM; END;

  -- AI feedback/notification (mig 051)
  BEGIN PERFORM public.provision_tenant_ai_tables(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features ai_tables %: %', p_schema_name, SQLERRM; END;

  -- TTL-indekser (mig 024)
  BEGIN PERFORM public.provision_tenant_schema_ttl_patch(p_schema_name);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features ttl %: %', p_schema_name, SQLERRM; END;

  -- Forsikring-kæde i FK-rækkefølge: tables → analyser → kunde_id → sager → analyse_documents → gaps_fk → user_scope
  BEGIN PERFORM public.provision_tenant_forsikring_tables(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_tables %: %', p_schema_name, SQLERRM; END;

  BEGIN PERFORM public.provision_tenant_forsikring_analyser_tables(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_analyser %: %', p_schema_name, SQLERRM; END;

  BEGIN PERFORM public.provision_tenant_forsikring_kunde_id(p_schema_name);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_kunde_id %: %', p_schema_name, SQLERRM; END;

  BEGIN PERFORM public.provision_tenant_forsikring_sager(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_sager %: %', p_schema_name, SQLERRM; END;

  BEGIN PERFORM public.provision_tenant_forsikring_analyse_documents(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_analyse_docs %: %', p_schema_name, SQLERRM; END;

  BEGIN PERFORM public.provision_tenant_forsikring_gaps_analyse_fk(p_schema_name);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_gaps_fk %: %', p_schema_name, SQLERRM; END;

  BEGIN PERFORM public.provision_forsikring_user_scope(p_schema_name);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_user_scope %: %', p_schema_name, SQLERRM; END;

  -- Vurderingsrapport (mig 146)
  BEGIN PERFORM public.provision_tenant_vurdering_sager(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features vurdering %: %', p_schema_name, SQLERRM; END;

  -- KRITISK (BIZZ-2165): SECURITY DEFINER-funktionerne opretter tabeller ejet af
  -- function-owneren (postgres). PostgREST forbinder som authenticator og skifter
  -- til service_role/authenticated, der har brug for eksplicit GRANT — ellers
  -- fejler enhver .schema(...).from(...) med 42501 "permission denied for table".
  -- Base-provisioneringen GRANT'er kun de tabeller der fandtes paa det tidspunkt,
  -- saa feature-tabeller skabt her SKAL grantes til sidst. Uden dette kunne nye
  -- brugere ikke uploade policer (slj@rtm.dk: forsikring_documents 42501).
  BEGIN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO authenticated, service_role', p_schema_name);
    EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO authenticated, service_role', p_schema_name);
    EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO authenticated, service_role', p_schema_name);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features grants %: %', p_schema_name, SQLERRM; END;
END;
$$;

COMMENT ON FUNCTION public.provision_tenant_all_features(text, uuid) IS
  'BIZZ-2165: Single idempotent entry point that provisions the full feature-table '
  'chain (ai_chat, ai_tables, forsikring, vurdering) for a tenant schema. Called by '
  'provisionTenantForUser at signup and used to backfill existing tenants.';

REVOKE EXECUTE ON FUNCTION public.provision_tenant_all_features(text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.provision_tenant_all_features(text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.provision_tenant_all_features(text, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.provision_tenant_all_features(text, uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 3. Bagudfyld ALLE eksisterende tenant-schemaer.
--    Mapper schema_name → tenant_id via public.tenants så DEFAULT-værdier
--    og RLS-policies får korrekt tenant-uuid.
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT t.schema_name, t.id AS tenant_id
    FROM public.tenants t
    WHERE t.schema_name LIKE 'tenant\_%' ESCAPE '\'
      AND EXISTS (
        SELECT 1 FROM information_schema.schemata s
        WHERE s.schema_name = t.schema_name
      )
  LOOP
    PERFORM public.provision_tenant_all_features(rec.schema_name, rec.tenant_id);
    RAISE NOTICE 'Backfilled all features for % (%)', rec.schema_name, rec.tenant_id;
  END LOOP;
END $$;
