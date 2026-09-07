-- ============================================================
-- Migration 217: Move email_integrations into per-tenant schemas
-- BizzAssist — BIZZ-2275 (integrations slice)
-- ============================================================
-- email_integrations (Gmail/LinkedIn/Outlook OAuth tokens, mig 034/035)
-- was created in the shared "tenant" schema, which is NOT exposed to
-- PostgREST (db_schema = public, graphql_public, tenant_<slug> only).
-- Any .schema('tenant') / tenantDb('tenant') call therefore fails with
-- PGRST106. On top of that the integrations routes passed a tenant UUID
-- to tenantDb() (which expects a schema name), and the table was never
-- provisioned to prod at all — so the integrations feature (settings →
-- integrations, Gmail + LinkedIn) was broken end-to-end in every env.
--
-- This relocates email_integrations to the per-tenant tenant_<slug>
-- schemas (same model as tenant_knowledge / mig 216, BIZZ-2277), so the
-- exposed schema API can reach it and RLS gates it.
--
-- RLS: user-scoped (user_id = auth.uid()) exactly as mig 034 — each user
-- only sees their own OAuth rows. Routes run via the service_role admin
-- client (tenantDb(schemaName)) and additionally filter by user_id.
--
-- Non-destructive:
--   * CREATE TABLE IF NOT EXISTS — never drops/overwrites data.
--   * The old shared tenant.email_integrations is LEFT IN PLACE (empty on
--     test, absent on prod) and becomes dead once routes are repointed.
--     Dropping it is deferred to an explicit cleanup ticket.
--
-- GDPR / retention: unchanged from mig 034 — rows carry user_id; cascade
-- delete happens via tenant-schema DROP on offboarding. Tokens are
-- sensitive (OAuth access/refresh) — schema and RLS preserved verbatim.
-- ============================================================


-- ──────────────────────────────────────────────────────────────
-- PART 1: Per-tenant sub-provisioner
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.provision_tenant_email_integrations(
  p_schema_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Table (mirrors mig 034 columns + mig 035 provider constraint).
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.email_integrations ('
    '  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),'
    '  user_id          uuid        NOT NULL,'
    '  provider         text        NOT NULL DEFAULT ''gmail'''
    '                               CHECK (provider IN (''gmail'', ''outlook'', ''linkedin'')),'
    '  email_address    text        NOT NULL,'
    '  access_token     text        NOT NULL,'
    '  refresh_token    text        NOT NULL,'
    '  token_expires_at timestamptz NOT NULL,'
    '  scopes           text[]      NOT NULL DEFAULT ''{}'','
    '  connected_at     timestamptz NOT NULL DEFAULT now(),'
    '  last_used_at     timestamptz,'
    '  UNIQUE (user_id, provider)'
    ')',
    p_schema_name
  );

  -- Index: fast lookup by user
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_email_integrations_user'
    '  ON %I.email_integrations (user_id)',
    p_schema_name
  );

  -- Row Level Security — user-scoped (each user only their own rows)
  EXECUTE format('ALTER TABLE %I.email_integrations ENABLE ROW LEVEL SECURITY', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "users_own_integrations" ON %I.email_integrations', p_schema_name);
  EXECUTE format(
    'CREATE POLICY "users_own_integrations" ON %I.email_integrations'
    '  FOR ALL USING (user_id = auth.uid())',
    p_schema_name
  );
END;
$function$;

COMMENT ON FUNCTION public.provision_tenant_email_integrations(text) IS
  'Creates email_integrations (+index+user-scoped RLS) in one tenant_<slug> schema. Idempotent. BIZZ-2275.';


-- ──────────────────────────────────────────────────────────────
-- PART 2: Wire into the umbrella provisioner (new tenants)
--   Inserted just BEFORE the trailing GRANT block so the freshly
--   created table is granted to authenticated/service_role (BIZZ-2165).
--   Full body re-declared (CREATE OR REPLACE) to preserve every
--   existing sub-provisioner call, incl. the knowledge one (mig 216).
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

  -- Email/OAuth integrations (mig 217, BIZZ-2275)
  BEGIN PERFORM public.provision_tenant_email_integrations(p_schema_name);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features email_integrations %: %', p_schema_name, SQLERRM; END;

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
--   Same approach as mig 216: provision into every tenant_<slug>
--   schema that actually exists and has a matching public.tenants
--   row. No closed_at filter (offboarded tenants have their schema
--   dropped; the join to tenants + schemata-existence handles the
--   rest, and closed_at is absent on prod — BIZZ-2199).
-- ──────────────────────────────────────────────────────────────

DO $backfill$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT t.schema_name
    FROM information_schema.schemata s
    JOIN public.tenants t ON t.schema_name = s.schema_name
    WHERE s.schema_name LIKE 'tenant\_%'
  LOOP
    BEGIN
      PERFORM public.provision_tenant_email_integrations(r.schema_name);
      EXECUTE format(
        'GRANT ALL ON TABLE %I.email_integrations TO authenticated, service_role',
        r.schema_name
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'backfill email_integrations %: %', r.schema_name, SQLERRM;
    END;
  END LOOP;
END;
$backfill$;
