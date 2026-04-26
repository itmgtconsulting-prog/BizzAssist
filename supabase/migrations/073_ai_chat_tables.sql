-- ============================================================
-- BIZZ-818 (sub af BIZZ-783): Backend for AI chat-historik.
--
-- Erstatter localStorage-baseret chat-state med en Supabase-backed
-- persistence så (a) brugere kan tilgå samtaler på tværs af devices,
-- (b) samtaler kan indekseres med context (ejendom/virksomhed/person/
-- sag) og (c) vi kan retention-håndtere data per GDPR Art. 5(1)(e).
--
-- Pattern: schema-per-tenant (samme som ai_token_usage fra migration
-- 030/031). Tabellerne oprettes i hver eksisterende tenant_xxx schema
-- via DO-loop + tilføjes til provision_tenant_schema() så fremtidige
-- tenants får dem fra dag ét.
--
-- RLS model:
--   * SELECT: tenant-members (public.is_tenant_member(tenant_id))
--     PLUS user_id = auth.uid() (egne samtaler kun).
--   * UPDATE: user_id = auth.uid() (kun egne samtaler: title, archive).
--   * INSERT/DELETE: service_role only (fra server-side /api/ai/*).
--
-- GDPR / ISO 27001:
--   * ON DELETE CASCADE fra auth.users: session + messages ryddet når
--     brugeren slettes (Art. 17).
--   * ON DELETE CASCADE fra sessions → messages: intern integritet.
--   * 12 mdr retention enforces af /api/cron/purge-old-data (samme
--     commit som denne migration). archived_at IS NOT NULL ekskluderet
--     fra auto-purge — brugeren har aktivt valgt at bevare.
-- ============================================================

-- ─── Hjælper: PL/pgSQL-funktion der opretter tabel + RLS + policies
--     for ét givet tenant-schema. Bruges både fra DO-loop og senere
--     fra provision_tenant_schema() så logikken kun skrives ét sted.
-- ============================================================

CREATE OR REPLACE FUNCTION public.provision_ai_chat_tables(
  p_schema_name text,
  p_tenant_id   uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- ─── ai_chat_sessions ──────────────────────────────────────
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.ai_chat_sessions ('
    '  id              UUID         PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id       UUID         NOT NULL DEFAULT %L::uuid,'
    '  user_id         UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,'
    '  title           TEXT         NOT NULL DEFAULT ''Ny samtale'','
    '  context_type    TEXT         CHECK (context_type IN (''ejendom'',''virksomhed'',''person'',''sag'')),'
    '  context_id      TEXT,'
    '  last_msg_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),'
    '  archived_at     TIMESTAMPTZ,'
    '  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),'
    '  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id
  );

  -- Indexes: sidebar-listing (user + last_msg_at), tenant-analytics,
  -- retention-scan (cron), context-filter (fremtidig feature).
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_user_lastmsg '
    'ON %I.ai_chat_sessions (user_id, last_msg_at DESC) '
    'WHERE archived_at IS NULL',
    p_schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_tenant '
    'ON %I.ai_chat_sessions (tenant_id, last_msg_at DESC)',
    p_schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_retention '
    'ON %I.ai_chat_sessions (last_msg_at) WHERE archived_at IS NULL',
    p_schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_context '
    'ON %I.ai_chat_sessions (context_type, context_id) '
    'WHERE context_type IS NOT NULL',
    p_schema_name
  );

  EXECUTE format('ALTER TABLE %I.ai_chat_sessions ENABLE ROW LEVEL SECURITY', p_schema_name);

  -- Policies
  EXECUTE format(
    'DROP POLICY IF EXISTS "ai_chat_sessions: owner read" ON %I.ai_chat_sessions',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "ai_chat_sessions: owner read" ON %I.ai_chat_sessions '
    'FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.is_tenant_member(tenant_id))',
    p_schema_name
  );

  EXECUTE format(
    'DROP POLICY IF EXISTS "ai_chat_sessions: owner update" ON %I.ai_chat_sessions',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "ai_chat_sessions: owner update" ON %I.ai_chat_sessions '
    'FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())',
    p_schema_name
  );

  EXECUTE format(
    'DROP POLICY IF EXISTS "ai_chat_sessions: service write" ON %I.ai_chat_sessions',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "ai_chat_sessions: service write" ON %I.ai_chat_sessions '
    'FOR ALL TO service_role USING (true) WITH CHECK (true)',
    p_schema_name
  );

  -- ─── ai_chat_messages ──────────────────────────────────────
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.ai_chat_messages ('
    '  id              UUID         PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  session_id      UUID         NOT NULL REFERENCES %I.ai_chat_sessions(id) ON DELETE CASCADE,'
    '  role            TEXT         NOT NULL CHECK (role IN (''user'',''assistant'',''system'',''tool'')),'
    '  content         JSONB        NOT NULL,'
    '  tokens_in       INTEGER,'
    '  tokens_out      INTEGER,'
    '  model           TEXT,'
    '  tool_calls      JSONB,'
    '  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_schema_name
  );

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_session '
    'ON %I.ai_chat_messages (session_id, created_at)',
    p_schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_tokens '
    'ON %I.ai_chat_messages (session_id, created_at) '
    'WHERE tokens_in IS NOT NULL OR tokens_out IS NOT NULL',
    p_schema_name
  );

  EXECUTE format('ALTER TABLE %I.ai_chat_messages ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format(
    'DROP POLICY IF EXISTS "ai_chat_messages: owner read" ON %I.ai_chat_messages',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "ai_chat_messages: owner read" ON %I.ai_chat_messages '
    'FOR SELECT TO authenticated USING ('
    '  EXISTS (SELECT 1 FROM %I.ai_chat_sessions s WHERE s.id = session_id AND s.user_id = auth.uid())'
    ')',
    p_schema_name, p_schema_name
  );

  EXECUTE format(
    'DROP POLICY IF EXISTS "ai_chat_messages: service write" ON %I.ai_chat_messages',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "ai_chat_messages: service write" ON %I.ai_chat_messages '
    'FOR ALL TO service_role USING (true) WITH CHECK (true)',
    p_schema_name
  );

  -- ─── updated_at trigger på sessions ────────────────────────
  -- Genbruger public.set_updated_at() fra migration 002.
  EXECUTE format(
    'DROP TRIGGER IF EXISTS set_updated_at_ai_chat_sessions ON %I.ai_chat_sessions',
    p_schema_name
  );
  EXECUTE format(
    'CREATE TRIGGER set_updated_at_ai_chat_sessions '
    'BEFORE UPDATE ON %I.ai_chat_sessions '
    'FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
    p_schema_name
  );

  -- ─── Privileges (matcher pattern fra migration 031) ───────
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON %I.ai_chat_sessions TO authenticated',
    p_schema_name
  );
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON %I.ai_chat_messages TO authenticated',
    p_schema_name
  );
  EXECUTE format('GRANT ALL ON %I.ai_chat_sessions TO service_role', p_schema_name);
  EXECUTE format('GRANT ALL ON %I.ai_chat_messages TO service_role', p_schema_name);
END;
$$;

COMMENT ON FUNCTION public.provision_ai_chat_tables IS
  'BIZZ-818: Provisions ai_chat_sessions + ai_chat_messages tables in a tenant schema. Called from provision_tenant_schema() for new tenants and from the DO-block below for existing tenants.';

-- ─── Patch existing tenant schemas ───────────────────────────
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT t.id, t.schema_name
    FROM   public.tenants t
    WHERE  t.schema_name IS NOT NULL
      -- Skip tenants hvor schema'et faktisk ikke findes i DB'en
      -- (ghost-tenants fra tidligere failed provisioning).
      AND  EXISTS (
        SELECT 1 FROM information_schema.schemata s
        WHERE s.schema_name = t.schema_name
      )
  LOOP
    PERFORM public.provision_ai_chat_tables(r.schema_name, r.id);
  END LOOP;
END $$;
