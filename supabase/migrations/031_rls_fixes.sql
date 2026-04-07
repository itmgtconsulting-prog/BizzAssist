-- ============================================================
-- Migration 031: RLS fixes for tables added in migrations 028–029
-- BizzAssist — BIZZ-141 / BIZZ-142 / BIZZ-143 / BIZZ-144
-- ============================================================
-- Migrations 023 (BIZZ-141–144) addressed the original set of
-- RLS gaps, but three tables added in migrations 028 and 029 were
-- left without Row Level Security policies:
--
--   tenant.activity_log         (migration 028) — no RLS
--   tenant.support_chat_sessions (migration 029) — no RLS
--   public.support_chat_abuse   (migration 029) — no RLS
--
-- This migration:
--   a) Enables RLS and creates correct policies on those tables
--      in all existing tenant schemas (via a DO block loop)
--   b) Updates provision_tenant_schema() so new tenants get the
--      same policies from day one
--
-- All per-tenant tables use public.is_tenant_member() /
-- public.is_tenant_admin() helpers (SECURITY DEFINER, migration 004)
-- to avoid RLS recursion. ISO 27001 A.9 (Access Control).
-- ============================================================


-- ──────────────────────────────────────────────────────────────
-- PART 1: Patch existing tenant schemas
-- ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schema_name
    FROM   public.tenants
  LOOP

    -- ── activity_log (migration 028) ───────────────────────
    -- tenant.activity_log was created without ENABLE ROW LEVEL
    -- SECURITY, leaving it accessible to any authenticated user
    -- across all tenants. Fix: enable RLS + scope read to
    -- tenant members, writes to the service role only (the API
    -- routes that record events use the service key).

    -- activity_log may not exist in schemas provisioned before
    -- migration 028 was applied — skip gracefully.
    IF EXISTS (
      SELECT 1
      FROM   information_schema.tables
      WHERE  table_schema = r.schema_name
        AND  table_name   = 'activity_log'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.activity_log ENABLE ROW LEVEL SECURITY',
        r.schema_name
      );

      -- Read: tenant members may view their own tenant's activity
      EXECUTE format(
        'DROP POLICY IF EXISTS "activity_log: members read" ON %I.activity_log',
        r.schema_name
      );
      EXECUTE format(
        'CREATE POLICY "activity_log: members read" ON %I.activity_log '
        'FOR SELECT USING (public.is_tenant_member(tenant_id))',
        r.schema_name
      );

      -- Write: service_role only — authenticated INSERT is intentionally
      -- blocked because writes come exclusively from server-side API routes
      -- using the service key. No explicit INSERT policy for authenticated.
      -- (Service role bypasses RLS by default in Supabase.)

      -- Delete: tenant admins may purge activity records (GDPR erasure)
      EXECUTE format(
        'DROP POLICY IF EXISTS "activity_log: admin delete" ON %I.activity_log',
        r.schema_name
      );
      EXECUTE format(
        'CREATE POLICY "activity_log: admin delete" ON %I.activity_log '
        'FOR DELETE USING (public.is_tenant_admin(tenant_id))',
        r.schema_name
      );
    END IF;


    -- ── support_chat_sessions (migration 029) ─────────────
    -- Same issue: table exists in tenant schemas but RLS was
    -- never enabled. Users should only see their own tenant's
    -- support sessions; writes come from the service role.

    IF EXISTS (
      SELECT 1
      FROM   information_schema.tables
      WHERE  table_schema = r.schema_name
        AND  table_name   = 'support_chat_sessions'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.support_chat_sessions ENABLE ROW LEVEL SECURITY',
        r.schema_name
      );

      -- Read: tenant members only
      EXECUTE format(
        'DROP POLICY IF EXISTS "support_chat_sessions: members read" ON %I.support_chat_sessions',
        r.schema_name
      );
      EXECUTE format(
        'CREATE POLICY "support_chat_sessions: members read" ON %I.support_chat_sessions '
        'FOR SELECT USING (public.is_tenant_member(tenant_id))',
        r.schema_name
      );

      -- Writes (INSERT) go via service_role — no authenticated INSERT policy.

      -- Delete: admin only (GDPR erasure path)
      EXECUTE format(
        'DROP POLICY IF EXISTS "support_chat_sessions: admin delete" ON %I.support_chat_sessions',
        r.schema_name
      );
      EXECUTE format(
        'CREATE POLICY "support_chat_sessions: admin delete" ON %I.support_chat_sessions '
        'FOR DELETE USING (public.is_tenant_admin(tenant_id))',
        r.schema_name
      );
    END IF;

  END LOOP;
END;
$$;


-- ──────────────────────────────────────────────────────────────
-- PART 2: public.support_chat_abuse (migration 029)
-- ──────────────────────────────────────────────────────────────
-- This is a platform-level table (not per-tenant) that tracks
-- abuse / lockout state per user. It was created without RLS.
--
-- Policy intent:
--   • A user may read their own row (to check if they are locked out)
--   • No authenticated INSERT / UPDATE / DELETE — all writes happen
--     via service_role in the API route (POST /api/support/chat)
--   • Admins who need to unlock users do so via the service key
--     in the admin panel — not directly from the authenticated client

ALTER TABLE public.support_chat_abuse ENABLE ROW LEVEL SECURITY;

-- Drop any pre-existing policies to make this idempotent
DROP POLICY IF EXISTS "support_chat_abuse: read own"           ON public.support_chat_abuse;
DROP POLICY IF EXISTS "support_chat_abuse: deny authenticated" ON public.support_chat_abuse;
DROP POLICY IF EXISTS "support_chat_abuse: service all"        ON public.support_chat_abuse;

-- A user may read their own abuse record (needed to show a locked-out
-- message in the UI without requiring a service-role call)
CREATE POLICY "support_chat_abuse: read own"
  ON public.support_chat_abuse
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- All mutations are blocked for the authenticated role.
-- Service role (used by the API route) bypasses RLS automatically.
CREATE POLICY "support_chat_abuse: deny write authenticated"
  ON public.support_chat_abuse
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

CREATE POLICY "support_chat_abuse: deny update authenticated"
  ON public.support_chat_abuse
  FOR UPDATE
  TO authenticated
  USING (false);

CREATE POLICY "support_chat_abuse: deny delete authenticated"
  ON public.support_chat_abuse
  FOR DELETE
  TO authenticated
  USING (false);


-- ──────────────────────────────────────────────────────────────
-- PART 3: Update provision_tenant_schema for new tenants
-- ──────────────────────────────────────────────────────────────
-- Extend the provisioning function to include activity_log and
-- support_chat_sessions with correct RLS from creation.
-- ai_token_usage (migration 030) is also added here — it was
-- created without RLS in the same pattern as the tables above.

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
  EXECUTE format('DROP POLICY IF EXISTS "saved_searches: admin delete"  ON %I.saved_searches', p_schema_name);

  EXECUTE format('CREATE POLICY "saved_searches: members read"  ON %I.saved_searches FOR SELECT USING (public.is_tenant_member(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "saved_searches: members write" ON %I.saved_searches FOR INSERT WITH CHECK (public.can_tenant_write(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "saved_searches: admin delete"  ON %I.saved_searches FOR DELETE USING (public.is_tenant_admin(tenant_id))', p_schema_name);


  -- ── 4. reports ───────────────────────────────────────────

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.reports ('
    '  id           uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id    uuid        NOT NULL DEFAULT %L::uuid,'
    '  title        text        NOT NULL,'
    '  report_type  text        NOT NULL CHECK (report_type IN (''company_analysis'',''property_report'',''person_report'',''market_overview'',''custom'')),'
    '  entity_type  text        CHECK (entity_type IN (''company'',''property'',''person'')),'
    '  entity_id    text,'
    '  content      jsonb       NOT NULL DEFAULT ''{}''::jsonb,'
    '  is_exported  boolean     NOT NULL DEFAULT false,'
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
  EXECUTE format('DROP POLICY IF EXISTS "ai_conversations: owner update"  ON %I.ai_conversations', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "ai_conversations: owner delete"  ON %I.ai_conversations', p_schema_name);

  EXECUTE format('CREATE POLICY "ai_conversations: members read"  ON %I.ai_conversations FOR SELECT USING (public.is_tenant_member(tenant_id) AND (created_by = auth.uid() OR is_shared = true))', p_schema_name);
  EXECUTE format('CREATE POLICY "ai_conversations: members write" ON %I.ai_conversations FOR INSERT WITH CHECK (public.can_tenant_write(tenant_id) AND created_by = auth.uid())', p_schema_name);
  EXECUTE format('CREATE POLICY "ai_conversations: owner update"  ON %I.ai_conversations FOR UPDATE USING (created_by = auth.uid() AND public.can_tenant_write(tenant_id)) WITH CHECK (created_by = auth.uid() AND public.can_tenant_write(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "ai_conversations: owner delete"  ON %I.ai_conversations FOR DELETE USING (created_by = auth.uid() AND public.is_tenant_member(tenant_id))', p_schema_name);

  EXECUTE format('DROP TRIGGER IF EXISTS ai_conversations_updated_at ON %I.ai_conversations', p_schema_name);
  EXECUTE format('CREATE TRIGGER ai_conversations_updated_at BEFORE UPDATE ON %I.ai_conversations FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at()', p_schema_name);


  -- ── 6. ai_messages ───────────────────────────────────────

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.ai_messages ('
    '  id              uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id       uuid        NOT NULL DEFAULT %L::uuid,'
    '  conversation_id uuid        NOT NULL,'
    '  role            text        NOT NULL CHECK (role IN (''user'',''assistant'',''system'')),'
    '  content         text        NOT NULL,'
    '  tokens_used     integer,'
    '  created_at      timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id
  );
  EXECUTE format('ALTER TABLE %I.ai_messages ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format('DROP POLICY IF EXISTS "ai_messages: members read"  ON %I.ai_messages', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "ai_messages: members write" ON %I.ai_messages', p_schema_name);

  EXECUTE format('CREATE POLICY "ai_messages: members read"  ON %I.ai_messages FOR SELECT USING (public.is_tenant_member(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "ai_messages: members write" ON %I.ai_messages FOR INSERT WITH CHECK (public.can_tenant_write(tenant_id))', p_schema_name);
  -- No UPDATE policy — messages are immutable after creation.


  -- ── 7. document_embeddings ───────────────────────────────

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.document_embeddings ('
    '  id            uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id     uuid        NOT NULL DEFAULT %L::uuid,'
    '  source_type   text        NOT NULL CHECK (source_type IN (''company'',''property'',''person'',''report'',''search_result'',''custom'')),'
    '  source_id     text        NOT NULL,'
    '  chunk_index   integer     NOT NULL DEFAULT 0,'
    '  content       text        NOT NULL,'
    '  embedding     extensions.vector(1536) NOT NULL,'
    '  metadata      jsonb       NOT NULL DEFAULT ''{}''::jsonb,'
    '  created_at    timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id
  );

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS document_embeddings_hnsw_idx ON %I.document_embeddings USING hnsw (embedding extensions.vector_cosine_ops) WITH (m = 16, ef_construction = 64)',
    p_schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS document_embeddings_source_idx ON %I.document_embeddings (tenant_id, source_type, source_id)',
    p_schema_name
  );

  EXECUTE format('ALTER TABLE %I.document_embeddings ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format('DROP POLICY IF EXISTS "document_embeddings: members read"  ON %I.document_embeddings', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "document_embeddings: members write" ON %I.document_embeddings', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "document_embeddings: admin delete"  ON %I.document_embeddings', p_schema_name);

  EXECUTE format('CREATE POLICY "document_embeddings: members read"  ON %I.document_embeddings FOR SELECT USING (public.is_tenant_member(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "document_embeddings: members write" ON %I.document_embeddings FOR INSERT WITH CHECK (public.can_tenant_write(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "document_embeddings: admin delete"  ON %I.document_embeddings FOR DELETE USING (public.is_tenant_admin(tenant_id))', p_schema_name);


  -- ── 8. audit_log ─────────────────────────────────────────
  -- BIZZ-142: resource_type is explicitly NOT NULL from creation.
  -- No INSERT policy for authenticated — audit writes go via service_role only.

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.audit_log ('
    '  id            uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id     uuid        NOT NULL DEFAULT %L::uuid,'
    '  user_id       uuid        REFERENCES auth.users(id) ON DELETE SET NULL,'
    '  action        text        NOT NULL,'
    '  resource_type text        NOT NULL,'
    '  resource_id   text,'
    '  metadata      jsonb       DEFAULT ''{}''::jsonb,'
    '  ip_address    inet,'
    '  created_at    timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id
  );
  EXECUTE format('ALTER TABLE %I.audit_log ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format('DROP POLICY IF EXISTS "audit_log: members read" ON %I.audit_log', p_schema_name);
  EXECUTE format('CREATE POLICY "audit_log: members read" ON %I.audit_log FOR SELECT USING (public.is_tenant_member(tenant_id))', p_schema_name);


  -- ── 9. recent_entities ───────────────────────────────────

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.recent_entities ('
    '  id            uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id     uuid        NOT NULL DEFAULT %L::uuid,'
    '  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,'
    '  entity_type   text        NOT NULL CHECK (entity_type IN (''company'',''property'',''person'',''search'')),'
    '  entity_id     text        NOT NULL,'
    '  display_name  text        NOT NULL,'
    '  entity_data   jsonb       NOT NULL DEFAULT ''{}''::jsonb,'
    '  visited_at    timestamptz NOT NULL DEFAULT now(),'
    '  UNIQUE (tenant_id, user_id, entity_type, entity_id)'
    ')',
    p_schema_name, p_tenant_id
  );
  EXECUTE format('ALTER TABLE %I.recent_entities ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format('DROP POLICY IF EXISTS "recent_entities: own read"   ON %I.recent_entities', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "recent_entities: own write"  ON %I.recent_entities', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "recent_entities: own update" ON %I.recent_entities', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "recent_entities: own delete" ON %I.recent_entities', p_schema_name);

  EXECUTE format('CREATE POLICY "recent_entities: own read"   ON %I.recent_entities FOR SELECT USING (user_id = auth.uid() AND public.is_tenant_member(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "recent_entities: own write"  ON %I.recent_entities FOR INSERT WITH CHECK (user_id = auth.uid() AND public.can_tenant_write(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "recent_entities: own update" ON %I.recent_entities FOR UPDATE USING (user_id = auth.uid() AND public.can_tenant_write(tenant_id)) WITH CHECK (user_id = auth.uid() AND public.can_tenant_write(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "recent_entities: own delete" ON %I.recent_entities FOR DELETE USING (user_id = auth.uid() AND public.is_tenant_member(tenant_id))', p_schema_name);


  -- ── 10. property_snapshots ───────────────────────────────
  -- BIZZ-144 (fixed in 023): Policies are tenant-member-scoped.
  -- Writes are via service_role (cron job); defence-in-depth INSERT policy added.

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.property_snapshots ('
    '  id            uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id     uuid        NOT NULL DEFAULT %L::uuid,'
    '  entity_id     text        NOT NULL,'
    '  snapshot_hash text        NOT NULL,'
    '  snapshot_data jsonb       NOT NULL DEFAULT ''{}''::jsonb,'
    '  created_at    timestamptz NOT NULL DEFAULT now(),'
    '  updated_at    timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id
  );
  EXECUTE format('ALTER TABLE %I.property_snapshots ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format('DROP POLICY IF EXISTS "property_snapshots: members read"   ON %I.property_snapshots', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "property_snapshots: service write"  ON %I.property_snapshots', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "property_snapshots: service update" ON %I.property_snapshots', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "property_snapshots: admin delete"   ON %I.property_snapshots', p_schema_name);

  EXECUTE format('CREATE POLICY "property_snapshots: members read"   ON %I.property_snapshots FOR SELECT USING (public.is_tenant_member(tenant_id))', p_schema_name);
  EXECUTE format('CREATE POLICY "property_snapshots: service write"  ON %I.property_snapshots FOR INSERT WITH CHECK (true)', p_schema_name);
  EXECUTE format('CREATE POLICY "property_snapshots: service update" ON %I.property_snapshots FOR UPDATE USING (true)', p_schema_name);
  EXECUTE format('CREATE POLICY "property_snapshots: admin delete"   ON %I.property_snapshots FOR DELETE USING (public.is_tenant_admin(tenant_id))', p_schema_name);

  EXECUTE format('DROP TRIGGER IF EXISTS property_snapshots_updated_at ON %I.property_snapshots', p_schema_name);
  EXECUTE format('CREATE TRIGGER property_snapshots_updated_at BEFORE UPDATE ON %I.property_snapshots FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at()', p_schema_name);


  -- ── 11. notifications ─────────────────────────────────────
  -- BIZZ-143 (fixed in 023): Tenant-scoped RLS.

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.notifications ('
    '  id            uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),'
    '  tenant_id     uuid        NOT NULL DEFAULT %L::uuid,'
    '  user_id       uuid        REFERENCES auth.users(id) ON DELETE CASCADE,'
    '  entity_id     text        NOT NULL,'
    '  entity_type   text        NOT NULL DEFAULT ''property'','
    '  title         text        NOT NULL,'
    '  body          text        NOT NULL,'
    '  change_type   text,'
    '  is_read       boolean     NOT NULL DEFAULT false,'
    '  created_at    timestamptz NOT NULL DEFAULT now()'
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

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS notifications_entity_idx ON %I.notifications (entity_id, created_at DESC)',
    p_schema_name
  );


  -- ── 12. activity_log ─────────────────────────────────────
  -- BIZZ-143 / migration 028: RLS now enabled for new tenants.
  -- Writes are via service_role (API routes); authenticated INSERT blocked.

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.activity_log ('
    '  id            bigserial   PRIMARY KEY,'
    '  tenant_id     uuid        NOT NULL DEFAULT %L::uuid,'
    '  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,'
    '  event_type    text        NOT NULL CHECK ('
    '    event_type IN ('
    '      ''address_search'','
    '      ''ai_chat'','
    '      ''page_view'','
    '      ''property_open'','
    '      ''company_open'','
    '      ''owner_open'''
    '    )'
    '  ),'
    '  payload       jsonb       NOT NULL DEFAULT ''{}''::jsonb,'
    '  created_at    timestamptz NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id
  );

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS activity_log_tenant_created_idx ON %I.activity_log (tenant_id, created_at DESC)',
    p_schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS activity_log_user_idx ON %I.activity_log (user_id, created_at DESC)',
    p_schema_name
  );

  EXECUTE format('ALTER TABLE %I.activity_log ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format('DROP POLICY IF EXISTS "activity_log: members read" ON %I.activity_log', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "activity_log: admin delete" ON %I.activity_log', p_schema_name);

  -- Tenant members may read activity for their tenant (usage dashboards)
  EXECUTE format(
    'CREATE POLICY "activity_log: members read" ON %I.activity_log FOR SELECT USING (public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  -- Tenant admins may purge activity records (GDPR erasure)
  EXECUTE format(
    'CREATE POLICY "activity_log: admin delete" ON %I.activity_log FOR DELETE USING (public.is_tenant_admin(tenant_id))',
    p_schema_name
  );
  -- No authenticated INSERT — server-side routes use the service key.


  -- ── 13. support_chat_sessions ─────────────────────────────
  -- BIZZ-143 / migration 029: RLS now enabled for new tenants.

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.support_chat_sessions ('
    '  id          bigserial    PRIMARY KEY,'
    '  tenant_id   uuid         NOT NULL DEFAULT %L::uuid,'
    '  user_id     uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,'
    '  tokens_used integer      NOT NULL DEFAULT 0,'
    '  created_at  timestamptz  NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id
  );

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS support_sessions_user_day_idx ON %I.support_chat_sessions (user_id, created_at DESC)',
    p_schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS support_sessions_tenant_idx ON %I.support_chat_sessions (tenant_id, created_at DESC)',
    p_schema_name
  );

  EXECUTE format('ALTER TABLE %I.support_chat_sessions ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format('DROP POLICY IF EXISTS "support_chat_sessions: members read" ON %I.support_chat_sessions', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "support_chat_sessions: admin delete" ON %I.support_chat_sessions', p_schema_name);

  EXECUTE format(
    'CREATE POLICY "support_chat_sessions: members read" ON %I.support_chat_sessions FOR SELECT USING (public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  EXECUTE format(
    'CREATE POLICY "support_chat_sessions: admin delete" ON %I.support_chat_sessions FOR DELETE USING (public.is_tenant_admin(tenant_id))',
    p_schema_name
  );
  -- No authenticated INSERT — writes come from service_role in the API route.


  -- ── 14. ai_token_usage ───────────────────────────────────
  -- BIZZ-143 / migration 030: RLS now enabled for new tenants.

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.ai_token_usage ('
    '  id          bigserial    PRIMARY KEY,'
    '  tenant_id   uuid         NOT NULL DEFAULT %L::uuid,'
    '  user_id     uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,'
    '  tokens_in   integer      NOT NULL DEFAULT 0,'
    '  tokens_out  integer      NOT NULL DEFAULT 0,'
    '  model       text         NOT NULL,'
    '  created_at  timestamptz  NOT NULL DEFAULT now()'
    ')',
    p_schema_name, p_tenant_id
  );

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS ai_token_usage_tenant_month_idx ON %I.ai_token_usage (tenant_id, created_at DESC)',
    p_schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS ai_token_usage_user_idx ON %I.ai_token_usage (user_id, created_at DESC)',
    p_schema_name
  );

  EXECUTE format('ALTER TABLE %I.ai_token_usage ENABLE ROW LEVEL SECURITY', p_schema_name);

  EXECUTE format('DROP POLICY IF EXISTS "ai_token_usage: members read" ON %I.ai_token_usage', p_schema_name);
  EXECUTE format('DROP POLICY IF EXISTS "ai_token_usage: admin delete" ON %I.ai_token_usage', p_schema_name);

  -- Tenant members may read token usage (for quota display in the UI)
  EXECUTE format(
    'CREATE POLICY "ai_token_usage: members read" ON %I.ai_token_usage FOR SELECT USING (public.is_tenant_member(tenant_id))',
    p_schema_name
  );
  -- Admins may purge old token usage records (GDPR / data minimisation)
  EXECUTE format(
    'CREATE POLICY "ai_token_usage: admin delete" ON %I.ai_token_usage FOR DELETE USING (public.is_tenant_admin(tenant_id))',
    p_schema_name
  );
  -- No authenticated INSERT — writes come from service_role in the AI chat route.


  -- ── 15. Privileges ───────────────────────────────────────

  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA %I TO authenticated', p_schema_name);
  EXECUTE format('GRANT ALL                            ON ALL TABLES    IN SCHEMA %I TO service_role',  p_schema_name);
  EXECUTE format('GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA %I TO authenticated', p_schema_name);
  EXECUTE format('GRANT ALL                            ON ALL SEQUENCES IN SCHEMA %I TO service_role',  p_schema_name);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated', p_schema_name);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT ALL ON TABLES TO service_role', p_schema_name);

END;
$OUTER$;

COMMENT ON FUNCTION public.provision_tenant_schema(text, uuid) IS
  'Creates a fully isolated schema for a new BizzAssist tenant. '
  'Idempotent — safe to call multiple times (DROP IF EXISTS before every CREATE POLICY/TRIGGER). '
  'ISO 27001 A.9, A.12, A.14. '
  'Updated by migration 023: BIZZ-141/142/143/144 RLS security fixes. '
  'Updated by migration 031: RLS added for activity_log, support_chat_sessions, ai_token_usage.';

-- Lock down execute permissions (idempotent — repeating from previous migrations is safe)
REVOKE EXECUTE ON FUNCTION public.provision_tenant_schema(text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.provision_tenant_schema(text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.provision_tenant_schema(text, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.provision_tenant_schema(text, uuid) TO service_role;


-- ──────────────────────────────────────────────────────────────
-- PART 4: Patch ai_token_usage in existing tenant schemas
-- ──────────────────────────────────────────────────────────────
-- Same loop pattern as Part 1, but for ai_token_usage (migration 030).

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schema_name
    FROM   public.tenants
  LOOP

    IF EXISTS (
      SELECT 1
      FROM   information_schema.tables
      WHERE  table_schema = r.schema_name
        AND  table_name   = 'ai_token_usage'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.ai_token_usage ENABLE ROW LEVEL SECURITY',
        r.schema_name
      );

      EXECUTE format(
        'DROP POLICY IF EXISTS "ai_token_usage: members read" ON %I.ai_token_usage',
        r.schema_name
      );
      EXECUTE format(
        'CREATE POLICY "ai_token_usage: members read" ON %I.ai_token_usage '
        'FOR SELECT USING (public.is_tenant_member(tenant_id))',
        r.schema_name
      );

      EXECUTE format(
        'DROP POLICY IF EXISTS "ai_token_usage: admin delete" ON %I.ai_token_usage',
        r.schema_name
      );
      EXECUTE format(
        'CREATE POLICY "ai_token_usage: admin delete" ON %I.ai_token_usage '
        'FOR DELETE USING (public.is_tenant_admin(tenant_id))',
        r.schema_name
      );
    END IF;

  END LOOP;
END;
$$;
