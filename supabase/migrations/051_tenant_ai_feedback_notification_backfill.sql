-- ============================================================
-- Migration 051: Backfill tenant-scoped tables + provision function
-- BIZZ-644
-- ============================================================
-- Problem: Migrations 040 (ai_feedback_log) og 043 (notification_preferences)
-- definerede tenant-scoped tabeller, men var skrevet til en literal 'tenant'
-- schema (template) og kunne derfor ikke anvendes direkte på test/prod hvor
-- tenants bor i per-tenant tenant_<id>-schemaer.
--
-- Fix i 2 trin (denne migration):
--   1. Udvid provision_tenant_schema() til også at oprette de to tabeller
--      for nye tenants der provisioneres fremover.
--   2. Backfill-loop der anvender CREATE TABLE IF NOT EXISTS + RLS-policies
--      på alle eksisterende tenant_* schemaer.
--
-- Begge dele er idempotente — kan køres flere gange uden fejl.
-- ============================================================

-- ─── Del 1: Opdater provision_tenant_schema med de to tabeller ─────────────

-- Provisioneringsfunktionen skal ved nye tenants også oprette
-- ai_feedback_log + notification_preferences i deres schema.
-- Vi indkapsler som en separat funktion der kan kaldes både fra
-- provision_tenant_schema (for nye tenants) og fra backfill-loopet
-- nedenfor (for eksisterende tenants).

CREATE OR REPLACE FUNCTION public.provision_tenant_ai_tables(
  p_schema_name text,
  p_tenant_id   uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- ── ai_feedback_log (BIZZ-237 / migration 040) ───────────────────────

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.ai_feedback_log ('
    '  id                   bigserial   PRIMARY KEY,'
    '  tenant_id            uuid        NOT NULL DEFAULT %L::uuid,'
    '  user_id              uuid        NOT NULL,'
    '  conversation_id      uuid,'
    '  question_text        text        NOT NULL,'
    '  feedback_type        text        NOT NULL CHECK (feedback_type IN ('
    '    ''tool_failure'',''no_data'',''user_thumbs_down'',''missing_capability'''
    '  )),'
    '  ai_response_snippet  text,'
    '  page_context         text,'
    '  metadata             jsonb       DEFAULT ''{}''::jsonb,'
    '  jira_ticket_id       text,'
    '  created_at           timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id
  );

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_ai_feedback_log_tenant_created_%I '
    'ON %I.ai_feedback_log (tenant_id, created_at DESC)',
    p_schema_name, p_schema_name
  );

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_ai_feedback_log_type_%I '
    'ON %I.ai_feedback_log (feedback_type, created_at DESC)',
    p_schema_name, p_schema_name
  );

  EXECUTE format('ALTER TABLE %I.ai_feedback_log ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format(
    'DROP POLICY IF EXISTS "ai_feedback_log: members read"  ON %I.ai_feedback_log',
    p_schema_name
  );
  EXECUTE format(
    'DROP POLICY IF EXISTS "ai_feedback_log: members write" ON %I.ai_feedback_log',
    p_schema_name
  );
  EXECUTE format(
    'DROP POLICY IF EXISTS "ai_feedback_log: admin delete"  ON %I.ai_feedback_log',
    p_schema_name
  );

  EXECUTE format(
    'CREATE POLICY "ai_feedback_log: members read"  ON %I.ai_feedback_log '
    'FOR SELECT USING (public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "ai_feedback_log: members write" ON %I.ai_feedback_log '
    'FOR INSERT WITH CHECK (public.can_tenant_write(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "ai_feedback_log: admin delete"  ON %I.ai_feedback_log '
    'FOR DELETE USING (public.is_tenant_admin(tenant_id))',
    p_schema_name
  );

  -- ── notification_preferences (BIZZ-273 / migration 043) ─────────────

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.notification_preferences ('
    '  id                 uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  user_id            uuid        NOT NULL,'
    '  tenant_id          uuid        NOT NULL DEFAULT %L::uuid,'
    '  notification_type  text        NOT NULL,'
    '  channel            text        NOT NULL DEFAULT ''in_app'','
    '  enabled            boolean     NOT NULL DEFAULT true,'
    '  created_at         timestamptz NOT NULL DEFAULT now(),'
    '  updated_at         timestamptz NOT NULL DEFAULT now(),'
    '  UNIQUE(user_id, notification_type, channel)'
    ')',
    p_schema_name, p_tenant_id
  );

  EXECUTE format('ALTER TABLE %I.notification_preferences ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format(
    'DROP POLICY IF EXISTS "notification_preferences: user read"   ON %I.notification_preferences',
    p_schema_name
  );
  EXECUTE format(
    'DROP POLICY IF EXISTS "notification_preferences: user write"  ON %I.notification_preferences',
    p_schema_name
  );
  EXECUTE format(
    'DROP POLICY IF EXISTS "notification_preferences: user update" ON %I.notification_preferences',
    p_schema_name
  );

  EXECUTE format(
    'CREATE POLICY "notification_preferences: user read"   ON %I.notification_preferences '
    'FOR SELECT USING (user_id = auth.uid() AND public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "notification_preferences: user write"  ON %I.notification_preferences '
    'FOR INSERT WITH CHECK (user_id = auth.uid() AND public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "notification_preferences: user update" ON %I.notification_preferences '
    'FOR UPDATE USING (user_id = auth.uid() AND public.is_tenant_member(tenant_id)) '
    'WITH CHECK (user_id = auth.uid() AND public.is_tenant_member(tenant_id))',
    p_schema_name
  );
END;
$$;

-- ─── Del 2: Backfill alle eksisterende tenant_*-schemaer ─────────────────

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
    -- Find tenant_id for dette schema via tenants-tabellen.
    -- Hvis der ikke findes en mapping (fx orphan schema), spring over.
    SELECT id INTO tenant_uuid
      FROM public.tenants
     WHERE schema_name = schema_rec.schema_name
     LIMIT 1;

    IF tenant_uuid IS NULL THEN
      RAISE NOTICE 'Skipping schema % — ingen tenants-række med matching schema_name', schema_rec.schema_name;
      CONTINUE;
    END IF;

    PERFORM public.provision_tenant_ai_tables(schema_rec.schema_name, tenant_uuid);
    RAISE NOTICE 'Backfilled tenant schema %', schema_rec.schema_name;
  END LOOP;
END $$;
