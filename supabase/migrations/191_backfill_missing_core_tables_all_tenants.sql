-- Migration 191: Backfill 3 manglende kerne-tabeller i ALLE tenant-schemaer (BIZZ-2196)
--
-- Ældre tenants (især i prod, hvor provision_tenant_schema var en forældet version)
-- mangler ai_token_usage, activity_log og support_chat_sessions. At køre den fulde
-- provision_tenant_schema på dem fejler, fordi nogle har LEGACY-versioner af andre
-- tabeller (fx ai_messages uden tenant_id) → policy-fejl ruller resten tilbage.
--
-- Denne migration opretter KUN de 3 manglende tabeller (+ indexes, RLS, policies,
-- grants) idempotent for hvert tenant-schema, og rører ikke de legacy-konfliktende
-- tabeller. ai_token_usage er vigtigst (AI-forbrugs-audit / billing).

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT t.schema_name AS s, t.id AS tid
    FROM public.tenants t
    JOIN information_schema.schemata sc ON sc.schema_name = t.schema_name
  LOOP
    -- ── ai_token_usage ─────────────────────────────────────────
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.ai_token_usage ('
      '  id          bigserial    PRIMARY KEY,'
      '  tenant_id   uuid         NOT NULL DEFAULT %L::uuid,'
      '  user_id     uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,'
      '  tokens_in   integer      NOT NULL DEFAULT 0,'
      '  tokens_out  integer      NOT NULL DEFAULT 0,'
      '  model       text         NOT NULL,'
      '  created_at  timestamptz  NOT NULL DEFAULT now()'
      ')', r.s, r.tid);
    EXECUTE format('CREATE INDEX IF NOT EXISTS ai_token_usage_tenant_month_idx ON %I.ai_token_usage (tenant_id, created_at DESC)', r.s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS ai_token_usage_user_idx ON %I.ai_token_usage (user_id, created_at DESC)', r.s);
    EXECUTE format('ALTER TABLE %I.ai_token_usage ENABLE ROW LEVEL SECURITY', r.s);
    EXECUTE format('DROP POLICY IF EXISTS "ai_token_usage: members read" ON %I.ai_token_usage', r.s);
    EXECUTE format('DROP POLICY IF EXISTS "ai_token_usage: admin delete" ON %I.ai_token_usage', r.s);
    EXECUTE format('CREATE POLICY "ai_token_usage: members read" ON %I.ai_token_usage FOR SELECT USING (public.is_tenant_member(tenant_id))', r.s);
    EXECUTE format('CREATE POLICY "ai_token_usage: admin delete" ON %I.ai_token_usage FOR DELETE USING (public.is_tenant_admin(tenant_id))', r.s);

    -- ── activity_log ───────────────────────────────────────────
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.activity_log ('
      '  id            bigserial   PRIMARY KEY,'
      '  tenant_id     uuid        NOT NULL DEFAULT %L::uuid,'
      '  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,'
      '  event_type    text        NOT NULL CHECK (event_type IN ('
      '    ''address_search'',''ai_chat'',''page_view'',''property_open'',''company_open'',''owner_open'')),'
      '  payload       jsonb       NOT NULL DEFAULT ''{}''::jsonb,'
      '  created_at    timestamptz NOT NULL DEFAULT now()'
      ')', r.s, r.tid);
    EXECUTE format('CREATE INDEX IF NOT EXISTS activity_log_tenant_created_idx ON %I.activity_log (tenant_id, created_at DESC)', r.s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS activity_log_user_idx ON %I.activity_log (user_id, created_at DESC)', r.s);
    EXECUTE format('ALTER TABLE %I.activity_log ENABLE ROW LEVEL SECURITY', r.s);
    EXECUTE format('DROP POLICY IF EXISTS "activity_log: members read" ON %I.activity_log', r.s);
    EXECUTE format('DROP POLICY IF EXISTS "activity_log: admin delete" ON %I.activity_log', r.s);
    EXECUTE format('CREATE POLICY "activity_log: members read" ON %I.activity_log FOR SELECT USING (public.is_tenant_member(tenant_id))', r.s);
    EXECUTE format('CREATE POLICY "activity_log: admin delete" ON %I.activity_log FOR DELETE USING (public.is_tenant_admin(tenant_id))', r.s);

    -- ── support_chat_sessions ──────────────────────────────────
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.support_chat_sessions ('
      '  id          bigserial    PRIMARY KEY,'
      '  tenant_id   uuid         NOT NULL DEFAULT %L::uuid,'
      '  user_id     uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,'
      '  tokens_used integer      NOT NULL DEFAULT 0,'
      '  created_at  timestamptz  NOT NULL DEFAULT now()'
      ')', r.s, r.tid);
    EXECUTE format('CREATE INDEX IF NOT EXISTS support_sessions_user_day_idx ON %I.support_chat_sessions (user_id, created_at DESC)', r.s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS support_sessions_tenant_idx ON %I.support_chat_sessions (tenant_id, created_at DESC)', r.s);
    EXECUTE format('ALTER TABLE %I.support_chat_sessions ENABLE ROW LEVEL SECURITY', r.s);
    EXECUTE format('DROP POLICY IF EXISTS "support_chat_sessions: members read" ON %I.support_chat_sessions', r.s);
    EXECUTE format('DROP POLICY IF EXISTS "support_chat_sessions: admin delete" ON %I.support_chat_sessions', r.s);
    EXECUTE format('CREATE POLICY "support_chat_sessions: members read" ON %I.support_chat_sessions FOR SELECT USING (public.is_tenant_member(tenant_id))', r.s);
    EXECUTE format('CREATE POLICY "support_chat_sessions: admin delete" ON %I.support_chat_sessions FOR DELETE USING (public.is_tenant_admin(tenant_id))', r.s);

    -- Grants (SECURITY DEFINER-ejede tabeller kræver eksplicit grant til PostgREST-roller)
    EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO authenticated, service_role', r.s);
    EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO authenticated, service_role', r.s);
  END LOOP;
END $$;
