-- ============================================================
-- Migration 007: User preferences + recent_entities table
-- BizzAssist — Migrate localStorage data to database
-- ============================================================
-- Adds:
--   1. preferences JSONB column to public.users
--   2. recent_entities table to tenant template schema
--
-- Enables cross-device sync of user settings and recently
-- viewed entities (properties, companies, people).
-- ============================================================

-- ── 1. User preferences column ────────────────────────────
-- Stores per-user settings like map_style, ui_preferences, etc.
-- Language is already in public.users.preferred_language (migration 002).
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ── 2. Update provision_tenant_schema to include recent_entities ──

CREATE OR REPLACE FUNCTION public.provision_tenant_schema(
  p_schema_name text,
  p_tenant_id   uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $OUTER$
BEGIN

  -- ── 1. Schema ─────────────────────────────────────────────

  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', p_schema_name);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO authenticated', p_schema_name);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role',  p_schema_name);


  -- ── 2. saved_entities ────────────────────────────────────

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.saved_entities ('
    '  id           uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id    uuid        NOT NULL DEFAULT %L::uuid,'
    '  entity_type  text        NOT NULL CHECK (entity_type IN (''company'',''property'',''person'')),'
    '  entity_id    text        NOT NULL,'
    '  entity_data  jsonb       NOT NULL DEFAULT ''{}''::jsonb,'
    '  is_monitored boolean     NOT NULL DEFAULT false,'
    '  label        text,'
    '  created_by   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,'
    '  created_at   timestamptz NOT NULL DEFAULT now(),'
    '  updated_at   timestamptz NOT NULL DEFAULT now(),'
    '  UNIQUE (tenant_id, entity_type, entity_id)'
    ')',
    p_schema_name, p_tenant_id
  );
  EXECUTE format('ALTER TABLE %I.saved_entities ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format('DROP POLICY IF EXISTS "saved_entities: members read"   ON %I.saved_entities', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "saved_entities: members write"  ON %I.saved_entities', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "saved_entities: members update" ON %I.saved_entities', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "saved_entities: admin delete"   ON %I.saved_entities', p_schema_name);

  EXECUTE format('CREATE POLICY "saved_entities: members read"   ON %I.saved_entities FOR SELECT USING (public.is_tenant_member(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "saved_entities: members write"  ON %I.saved_entities FOR INSERT WITH CHECK (public.can_tenant_write(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "saved_entities: members update" ON %I.saved_entities FOR UPDATE USING (public.can_tenant_write(tenant_id)) WITH CHECK (public.can_tenant_write(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "saved_entities: admin delete"   ON %I.saved_entities FOR DELETE USING (public.is_tenant_admin(tenant_id))', p_schema_name);

  EXECUTE format('DROP TRIGGER IF EXISTS saved_entities_updated_at ON %I.saved_entities', p_schema_name);
  EXECUTE format('CREATE TRIGGER saved_entities_updated_at BEFORE UPDATE ON %I.saved_entities FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at()', p_schema_name);


  -- ── 3. saved_searches ────────────────────────────────────

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.saved_searches ('
    '  id           uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id    uuid        NOT NULL DEFAULT %L::uuid,'
    '  query        text        NOT NULL,'
    '  filters      jsonb       NOT NULL DEFAULT ''{}''::jsonb,'
    '  entity_type  text        NOT NULL DEFAULT ''all'' CHECK (entity_type IN (''company'',''property'',''person'',''all'')),'
    '  result_count integer,'
    '  created_by   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,'
    '  created_at   timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id
  );
  EXECUTE format('ALTER TABLE %I.saved_searches ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format('DROP POLICY IF EXISTS "saved_searches: members read"  ON %I.saved_searches', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "saved_searches: members write" ON %I.saved_searches', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "saved_searches: owner delete"  ON %I.saved_searches', p_schema_name);

  EXECUTE format('CREATE POLICY "saved_searches: members read"  ON %I.saved_searches FOR SELECT USING (public.is_tenant_member(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "saved_searches: members write" ON %I.saved_searches FOR INSERT WITH CHECK (public.can_tenant_write(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "saved_searches: owner delete"  ON %I.saved_searches FOR DELETE USING (created_by = auth.uid())', p_schema_name);


  -- ── 4. reports ───────────────────────────────────────────

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.reports ('
    '  id           uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id    uuid        NOT NULL DEFAULT %L::uuid,'
    '  title        text        NOT NULL,'
    '  report_type  text        NOT NULL CHECK (report_type IN (''company_analysis'',''property_report'',''person_report'',''market_overview'',''custom'')),'
    '  entity_id    text,'
    '  content      jsonb       NOT NULL DEFAULT ''{}''::jsonb,'
    '  created_by   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,'
    '  created_at   timestamptz NOT NULL DEFAULT now(),'
    '  updated_at   timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id
  );
  EXECUTE format('ALTER TABLE %I.reports ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format('DROP POLICY IF EXISTS "reports: members read"   ON %I.reports', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "reports: members write"  ON %I.reports', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "reports: members update" ON %I.reports', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "reports: admin delete"   ON %I.reports', p_schema_name);

  EXECUTE format('CREATE POLICY "reports: members read"   ON %I.reports FOR SELECT USING (public.is_tenant_member(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "reports: members write"  ON %I.reports FOR INSERT WITH CHECK (public.can_tenant_write(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "reports: members update" ON %I.reports FOR UPDATE USING (public.can_tenant_write(tenant_id)) WITH CHECK (public.can_tenant_write(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "reports: admin delete"   ON %I.reports FOR DELETE USING (public.is_tenant_admin(tenant_id))', p_schema_name);

  EXECUTE format('DROP TRIGGER IF EXISTS reports_updated_at ON %I.reports', p_schema_name);
  EXECUTE format('CREATE TRIGGER reports_updated_at BEFORE UPDATE ON %I.reports FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at()', p_schema_name);


  -- ── 5. ai_conversations ──────────────────────────────────

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.ai_conversations ('
    '  id           uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id    uuid        NOT NULL DEFAULT %L::uuid,'
    '  title        text,'
    '  context      jsonb       NOT NULL DEFAULT ''{}''::jsonb,'
    '  is_shared    boolean     NOT NULL DEFAULT false,'
    '  created_by   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,'
    '  created_at   timestamptz NOT NULL DEFAULT now(),'
    '  updated_at   timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id
  );
  EXECUTE format('ALTER TABLE %I.ai_conversations ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format('DROP POLICY IF EXISTS "ai_conversations: members read"  ON %I.ai_conversations', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "ai_conversations: members write" ON %I.ai_conversations', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "ai_conversations: owner delete"  ON %I.ai_conversations', p_schema_name);

  EXECUTE format('CREATE POLICY "ai_conversations: members read"  ON %I.ai_conversations FOR SELECT USING (public.is_tenant_member(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "ai_conversations: members write" ON %I.ai_conversations FOR INSERT WITH CHECK (public.can_tenant_write(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "ai_conversations: owner delete"  ON %I.ai_conversations FOR DELETE USING (created_by = auth.uid())', p_schema_name);

  EXECUTE format('DROP TRIGGER IF EXISTS ai_conversations_updated_at ON %I.ai_conversations', p_schema_name);
  EXECUTE format('CREATE TRIGGER ai_conversations_updated_at BEFORE UPDATE ON %I.ai_conversations FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at()', p_schema_name);


  -- ── 6. ai_messages ───────────────────────────────────────

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.ai_messages ('
    '  id              uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  conversation_id uuid        NOT NULL REFERENCES %I.ai_conversations(id) ON DELETE CASCADE,'
    '  role            text        NOT NULL CHECK (role IN (''user'',''assistant'',''system'')),'
    '  content         text        NOT NULL,'
    '  tool_calls      jsonb,'
    '  token_count     integer,'
    '  created_at      timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_schema_name
  );
  EXECUTE format('ALTER TABLE %I.ai_messages ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format('DROP POLICY IF EXISTS "ai_messages: members read"  ON %I.ai_messages', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "ai_messages: members write" ON %I.ai_messages', p_schema_name);

  EXECUTE format(
    'CREATE POLICY "ai_messages: members read" ON %I.ai_messages FOR SELECT USING ('
    '  EXISTS (SELECT 1 FROM %I.ai_conversations c WHERE c.id = conversation_id AND public.is_tenant_member(c.tenant_id))'
    ')',
    p_schema_name, p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "ai_messages: members write" ON %I.ai_messages FOR INSERT WITH CHECK ('
    '  EXISTS (SELECT 1 FROM %I.ai_conversations c WHERE c.id = conversation_id AND public.can_tenant_write(c.tenant_id))'
    ')',
    p_schema_name, p_schema_name
  );

  EXECUTE format('CREATE INDEX IF NOT EXISTS ai_messages_conv_idx ON %I.ai_messages (conversation_id, created_at)', p_schema_name);


  -- ── 7. document_embeddings ───────────────────────────────

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.document_embeddings ('
    '  id           uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id    uuid        NOT NULL DEFAULT %L::uuid,'
    '  entity_type  text        NOT NULL CHECK (entity_type IN (''company'',''property'',''person'')),'
    '  entity_id    text        NOT NULL,'
    '  chunk_index  integer     NOT NULL DEFAULT 0,'
    '  content      text        NOT NULL,'
    '  embedding    vector(1536) NOT NULL,'
    '  metadata     jsonb       NOT NULL DEFAULT ''{}''::jsonb,'
    '  created_at   timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id
  );
  EXECUTE format('ALTER TABLE %I.document_embeddings ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format('DROP POLICY IF EXISTS "document_embeddings: members read"  ON %I.document_embeddings', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "document_embeddings: members write" ON %I.document_embeddings', p_schema_name);

  EXECUTE format('CREATE POLICY "document_embeddings: members read"  ON %I.document_embeddings FOR SELECT USING (public.is_tenant_member(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "document_embeddings: members write" ON %I.document_embeddings FOR INSERT WITH CHECK (public.can_tenant_write(tenant_id))', p_schema_name);

  EXECUTE format('CREATE INDEX IF NOT EXISTS doc_emb_hnsw_idx ON %I.document_embeddings USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)', p_schema_name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS doc_emb_filter_idx ON %I.document_embeddings (tenant_id, entity_type, entity_id)', p_schema_name);


  -- ── 8. audit_log ─────────────────────────────────────────

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.audit_log ('
    '  id           uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id    uuid        NOT NULL DEFAULT %L::uuid,'
    '  user_id      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,'
    '  action       text        NOT NULL,'
    '  resource_type text,'
    '  resource_id  text,'
    '  metadata     jsonb       NOT NULL DEFAULT ''{}''::jsonb,'
    '  ip_address   inet,'
    '  created_at   timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id
  );
  EXECUTE format('ALTER TABLE %I.audit_log ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format('DROP POLICY IF EXISTS "audit_log: admin read" ON %I.audit_log', p_schema_name);
  EXECUTE format('CREATE POLICY "audit_log: admin read" ON %I.audit_log FOR SELECT USING (public.is_tenant_admin(tenant_id))', p_schema_name);

  EXECUTE format('CREATE INDEX IF NOT EXISTS audit_log_tenant_time_idx ON %I.audit_log (tenant_id, created_at DESC)', p_schema_name);


  -- ── 9. property_snapshots ────────────────────────────────

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.property_snapshots ('
    '  id           uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id    uuid        NOT NULL DEFAULT %L::uuid,'
    '  entity_id    text        NOT NULL,'
    '  snapshot_hash text       NOT NULL,'
    '  snapshot_data jsonb      NOT NULL DEFAULT ''{}''::jsonb,'
    '  created_at   timestamptz NOT NULL DEFAULT now(),'
    '  UNIQUE (tenant_id, entity_id)'
    ')',
    p_schema_name, p_tenant_id
  );
  EXECUTE format('ALTER TABLE %I.property_snapshots ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format('DROP POLICY IF EXISTS "property_snapshots: service read"  ON %I.property_snapshots', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "property_snapshots: service write" ON %I.property_snapshots', p_schema_name);
  EXECUTE format('CREATE POLICY "property_snapshots: service read"  ON %I.property_snapshots FOR SELECT USING (true)', p_schema_name);
  EXECUTE format('CREATE POLICY "property_snapshots: service write" ON %I.property_snapshots FOR ALL    USING (true)', p_schema_name);


  -- ── 10. notifications ────────────────────────────────────

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.notifications ('
    '  id           uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id    uuid        NOT NULL DEFAULT %L::uuid,'
    '  entity_id    text        NOT NULL,'
    '  entity_type  text        NOT NULL DEFAULT ''property'' CHECK (entity_type IN (''company'',''property'',''person'')),'
    '  change_type  text        NOT NULL,'
    '  summary      text        NOT NULL,'
    '  details      jsonb       NOT NULL DEFAULT ''{}''::jsonb,'
    '  is_read      boolean     NOT NULL DEFAULT false,'
    '  created_at   timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id
  );
  EXECUTE format('ALTER TABLE %I.notifications ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format('DROP POLICY IF EXISTS "notifications: members read"   ON %I.notifications', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "notifications: members update" ON %I.notifications', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "notifications: service write"  ON %I.notifications', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "notifications: admin delete"   ON %I.notifications', p_schema_name);

  EXECUTE format('CREATE POLICY "notifications: members read"   ON %I.notifications FOR SELECT USING (public.is_tenant_member(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "notifications: members update" ON %I.notifications FOR UPDATE USING (public.is_tenant_member(tenant_id)) WITH CHECK (public.is_tenant_member(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "notifications: service write"  ON %I.notifications FOR INSERT WITH CHECK (true)', p_schema_name);
  EXECUTE format('CREATE POLICY "notifications: admin delete"   ON %I.notifications FOR DELETE USING (public.is_tenant_admin(tenant_id))', p_schema_name);

  EXECUTE format('CREATE INDEX IF NOT EXISTS notifications_entity_idx ON %I.notifications (entity_id, created_at DESC)', p_schema_name);


  -- ── 11. recent_entities (NEW — migration 007) ───────────
  -- Stores recently viewed properties, companies, and people.
  -- Per-user within a tenant. Max entries enforced by application.

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.recent_entities ('
    '  id           uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id    uuid        NOT NULL DEFAULT %L::uuid,'
    '  user_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,'
    '  entity_type  text        NOT NULL CHECK (entity_type IN (''company'',''property'',''person'')),'
    '  entity_id    text        NOT NULL,'
    '  display_name text        NOT NULL,'
    '  entity_data  jsonb       NOT NULL DEFAULT ''{}''::jsonb,'
    '  visited_at   timestamptz NOT NULL DEFAULT now(),'
    '  UNIQUE (tenant_id, user_id, entity_type, entity_id)'
    ')',
    p_schema_name, p_tenant_id
  );
  EXECUTE format('ALTER TABLE %I.recent_entities ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format('DROP POLICY IF EXISTS "recent_entities: own read"   ON %I.recent_entities', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "recent_entities: own write"  ON %I.recent_entities', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "recent_entities: own update" ON %I.recent_entities', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "recent_entities: own delete" ON %I.recent_entities', p_schema_name);

  -- Users can only see/modify their own recent entities within the tenant
  EXECUTE format('CREATE POLICY "recent_entities: own read"   ON %I.recent_entities FOR SELECT USING (user_id = auth.uid() AND public.is_tenant_member(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "recent_entities: own write"  ON %I.recent_entities FOR INSERT WITH CHECK (user_id = auth.uid() AND public.can_tenant_write(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "recent_entities: own update" ON %I.recent_entities FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())', p_schema_name);
  EXECUTE format('CREATE POLICY "recent_entities: own delete" ON %I.recent_entities FOR DELETE USING (user_id = auth.uid())', p_schema_name);

  EXECUTE format('CREATE INDEX IF NOT EXISTS recent_entities_user_idx ON %I.recent_entities (user_id, entity_type, visited_at DESC)', p_schema_name);


  -- ── Permissions ──────────────────────────────────────────

  EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO authenticated', p_schema_name);
  EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO service_role',  p_schema_name);

END;
$OUTER$;

-- Lock down provisioning to service_role only
REVOKE EXECUTE ON FUNCTION public.provision_tenant_schema(text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.provision_tenant_schema(text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.provision_tenant_schema(text, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.provision_tenant_schema(text, uuid) TO service_role;

-- ── Backfill existing tenant schemas ────────────────────────
-- Create recent_entities in any already-provisioned tenant schemas.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT id, schema_name FROM public.tenants WHERE schema_name IS NOT NULL
  LOOP
    -- Create the table if it doesn't exist
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.recent_entities ('
      '  id           uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
      '  tenant_id    uuid        NOT NULL DEFAULT %L::uuid,'
      '  user_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,'
      '  entity_type  text        NOT NULL CHECK (entity_type IN (''company'',''property'',''person'')),'
      '  entity_id    text        NOT NULL,'
      '  display_name text        NOT NULL,'
      '  entity_data  jsonb       NOT NULL DEFAULT ''{}''::jsonb,'
      '  visited_at   timestamptz NOT NULL DEFAULT now(),'
      '  UNIQUE (tenant_id, user_id, entity_type, entity_id)'
      ')',
      r.schema_name, r.id
    );
    EXECUTE format('ALTER TABLE %I.recent_entities ENABLE ROW LEVEL SECURITY', r.schema_name);

    EXECUTE format('DROP POLICY IF EXISTS "recent_entities: own read"   ON %I.recent_entities', r.schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "recent_entities: own write"  ON %I.recent_entities', r.schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "recent_entities: own update" ON %I.recent_entities', r.schema_name);
    EXECUTE format('DROP POLICY IF EXISTS "recent_entities: own delete" ON %I.recent_entities', r.schema_name);

    EXECUTE format('CREATE POLICY "recent_entities: own read"   ON %I.recent_entities FOR SELECT USING (user_id = auth.uid() AND public.is_tenant_member(tenant_id))', r.schema_name);
    EXECUTE format('CREATE POLICY "recent_entities: own write"  ON %I.recent_entities FOR INSERT WITH CHECK (user_id = auth.uid() AND public.can_tenant_write(tenant_id))', r.schema_name);
    EXECUTE format('CREATE POLICY "recent_entities: own update" ON %I.recent_entities FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())', r.schema_name);
    EXECUTE format('CREATE POLICY "recent_entities: own delete" ON %I.recent_entities FOR DELETE USING (user_id = auth.uid())', r.schema_name);

    EXECUTE format('CREATE INDEX IF NOT EXISTS recent_entities_user_idx ON %I.recent_entities (user_id, entity_type, visited_at DESC)', r.schema_name);

    EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO authenticated', r.schema_name);
    EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO service_role',  r.schema_name);
  END LOOP;
END;
$$;
