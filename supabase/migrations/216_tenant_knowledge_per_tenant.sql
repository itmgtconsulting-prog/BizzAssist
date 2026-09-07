-- ============================================================
-- Migration 216: Move tenant_knowledge into per-tenant schemas
-- BizzAssist — BIZZ-2277 (KB.1, parent BIZZ-2276)
-- ============================================================
-- The knowledge base (videnbase) was originally created (mig 032)
-- in the shared "tenant" schema, which is NOT exposed to PostgREST
-- (db_schema = public, graphql_public, tenant_<slug> only). Any
-- .schema('tenant') call therefore fails with PGRST106, so the
-- feature was broken end-to-end: routes silently degraded and the
-- AI assistant never received any tenant knowledge.
--
-- This migration relocates tenant_knowledge to the per-tenant
-- tenant_<slug> schemas (the same model every other tenant feature
-- uses), so the exposed schema API can reach it and RLS gates it.
--
-- Design:
--   * New sub-provisioner provision_tenant_knowledge(schema, tenant_id)
--     creates the table + index + RLS + updated_at trigger in ONE
--     tenant schema, idempotently (CREATE ... IF NOT EXISTS,
--     DROP POLICY IF EXISTS before CREATE POLICY).
--   * It is wired into provision_tenant_all_features so every NEW
--     tenant automatically gets the table (before the trailing
--     GRANT block — BIZZ-2165 — so PostgREST roles can reach it).
--   * A backfill loop provisions the table into every EXISTING
--     tenant schema and grants access.
--
-- RLS: SELECT gated by public.is_tenant_member(tenant_id) (the
-- BIZZ-2271 defense-in-depth backstop for the `authenticated` role
-- used by tenantUserDb reads); writes gated by is_tenant_admin.
-- Writes from the service_role admin client (tenantDb) bypass RLS
-- and are authorised in the route by role check.
--
-- Non-destructive:
--   * CREATE TABLE IF NOT EXISTS — never drops/overwrites data.
--   * The old shared tenant.tenant_knowledge table is LEFT IN PLACE
--     (it is empty on test, absent on prod) and becomes dead once
--     the routes/AI read path are repointed in KB.2/KB.3. Dropping
--     it is deferred to an explicit cleanup ticket.
--
-- GDPR / retention: unchanged from mig 032 — rows carry tenant_id +
-- created_by; cascade delete happens via tenant-schema DROP on
-- offboarding. No automatic expiry (user-managed content).
--
-- ISO 27001: A.9 (Access Control) — RLS enforced via
-- public.is_tenant_member() / public.is_tenant_admin().
-- ============================================================


-- ──────────────────────────────────────────────────────────────
-- PART 1: Per-tenant sub-provisioner
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.provision_tenant_knowledge(
  p_schema_name text,
  p_tenant_id   uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Table (mirrors mig 032 column definition; tenant_id defaults to
  -- this tenant so app inserts need not supply it, but it is still
  -- always filtered/checked by RLS).
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.tenant_knowledge ('
    '  id          bigserial   PRIMARY KEY,'
    '  tenant_id   uuid        NOT NULL DEFAULT %L::uuid,'
    '  title       text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),'
    '  content     text        NOT NULL CHECK (char_length(content) BETWEEN 1 AND 50000),'
    '  source_type text        NOT NULL DEFAULT ''manual'''
    '                          CHECK (source_type IN (''manual'', ''upload'', ''url'')),'
    '  created_by  uuid        NOT NULL,'
    '  created_at  timestamptz NOT NULL DEFAULT now(),'
    '  updated_at  timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id
  );

  -- Index: fast lookup by tenant when building AI context
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS tenant_knowledge_tenant_idx'
    '  ON %I.tenant_knowledge (tenant_id, created_at DESC)',
    p_schema_name
  );

  -- Row Level Security
  EXECUTE format('ALTER TABLE %I.tenant_knowledge ENABLE ROW LEVEL SECURITY', p_schema_name);

  -- Read: any tenant member may view their own tenant's knowledge
  EXECUTE format('DROP POLICY IF EXISTS "knowledge: members read" ON %I.tenant_knowledge', p_schema_name);
  EXECUTE format(
    'CREATE POLICY "knowledge: members read" ON %I.tenant_knowledge'
    '  FOR SELECT USING (public.is_tenant_member(tenant_id))',
    p_schema_name
  );

  -- Write (insert): only tenant admins
  EXECUTE format('DROP POLICY IF EXISTS "knowledge: admins write" ON %I.tenant_knowledge', p_schema_name);
  EXECUTE format(
    'CREATE POLICY "knowledge: admins write" ON %I.tenant_knowledge'
    '  FOR INSERT WITH CHECK (public.is_tenant_admin(tenant_id))',
    p_schema_name
  );

  -- Update: only tenant admins
  EXECUTE format('DROP POLICY IF EXISTS "knowledge: admins update" ON %I.tenant_knowledge', p_schema_name);
  EXECUTE format(
    'CREATE POLICY "knowledge: admins update" ON %I.tenant_knowledge'
    '  FOR UPDATE USING (public.is_tenant_admin(tenant_id))'
    '            WITH CHECK (public.is_tenant_admin(tenant_id))',
    p_schema_name
  );

  -- Delete: only tenant admins
  EXECUTE format('DROP POLICY IF EXISTS "knowledge: admins delete" ON %I.tenant_knowledge', p_schema_name);
  EXECUTE format(
    'CREATE POLICY "knowledge: admins delete" ON %I.tenant_knowledge'
    '  FOR DELETE USING (public.is_tenant_admin(tenant_id))',
    p_schema_name
  );

  -- Auto-update updated_at (reuse the generic public.set_updated_at trigger fn)
  EXECUTE format('DROP TRIGGER IF EXISTS trg_knowledge_updated_at ON %I.tenant_knowledge', p_schema_name);
  EXECUTE format(
    'CREATE TRIGGER trg_knowledge_updated_at'
    '  BEFORE UPDATE ON %I.tenant_knowledge'
    '  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
    p_schema_name
  );
END;
$function$;

COMMENT ON FUNCTION public.provision_tenant_knowledge(text, uuid) IS
  'Creates tenant_knowledge (+index+RLS+updated_at trigger) in one tenant_<slug> schema. Idempotent. BIZZ-2277.';


-- ──────────────────────────────────────────────────────────────
-- PART 2: Wire into the umbrella provisioner (new tenants)
--   Inserted just BEFORE the trailing GRANT block so the freshly
--   created table/sequence are granted to authenticated/service_role
--   (BIZZ-2165). Full body re-declared (CREATE OR REPLACE).
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.provision_tenant_all_features(p_schema_name text, p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- BIZZ-2194: Normalisér notifications + property_snapshots til kanonisk skema
  BEGIN PERFORM public.provision_tenant_notify_canonical(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features notify_canonical %: %', p_schema_name, SQLERRM; END;

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

  -- Videnbase / knowledge base (mig 216, BIZZ-2277)
  BEGIN PERFORM public.provision_tenant_knowledge(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features knowledge %: %', p_schema_name, SQLERRM; END;

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
$function$;


-- ──────────────────────────────────────────────────────────────
-- PART 3: Backfill every physically-existing tenant schema
--   Provisions into EVERY tenant_<slug> schema that actually exists
--   and has a matching public.tenants row (needed for tenant_id).
--   We deliberately do NOT filter on closed_at: an offboarded tenant
--   has its schema DROPPED, so it simply won't appear here — while a
--   schema that still exists may be actively queried (e.g. the E2E
--   tenant on test is flagged closed_at but is live), and leaving it
--   without the table breaks those queries. Adding an empty table to
--   a not-yet-dropped schema is harmless (no PII). This also avoids
--   referencing closed_at, which is absent on prod (BIZZ-2199).
-- ──────────────────────────────────────────────────────────────

DO $backfill$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT t.schema_name, t.id
    FROM information_schema.schemata s
    JOIN public.tenants t ON t.schema_name = s.schema_name
    WHERE s.schema_name LIKE 'tenant\_%'
  LOOP
    BEGIN
      PERFORM public.provision_tenant_knowledge(r.schema_name, r.id);
      EXECUTE format(
        'GRANT ALL ON TABLE %I.tenant_knowledge TO authenticated, service_role',
        r.schema_name
      );
      EXECUTE format(
        'GRANT ALL ON SEQUENCE %I.tenant_knowledge_id_seq TO authenticated, service_role',
        r.schema_name
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'backfill knowledge %: %', r.schema_name, SQLERRM;
    END;
  END LOOP;
END;
$backfill$;
