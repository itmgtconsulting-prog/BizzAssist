-- ============================================================
-- Migration 027: Move recent_entities to public schema
-- BizzAssist — Fix: Supabase REST API only exposes 'public' schema.
-- Tenant-schema tables were inaccessible via the JS client,
-- causing all /api/recents calls to silently return empty results.
-- ============================================================
-- recent_entities stores per-user view history (not sensitive business data).
-- Tenant isolation is enforced via tenant_id column + RLS on user_id.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.recent_entities (
  id           uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  tenant_id    uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type  text        NOT NULL CHECK (entity_type IN ('company','property','person','search')),
  entity_id    text        NOT NULL,
  display_name text        NOT NULL,
  entity_data  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  visited_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, entity_type, entity_id)
);

ALTER TABLE public.recent_entities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "recent_entities: own read"   ON public.recent_entities;
DROP POLICY IF EXISTS "recent_entities: own write"  ON public.recent_entities;
DROP POLICY IF EXISTS "recent_entities: own update" ON public.recent_entities;
DROP POLICY IF EXISTS "recent_entities: own delete" ON public.recent_entities;

-- Users can only see and modify their own rows
CREATE POLICY "recent_entities: own read"   ON public.recent_entities FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "recent_entities: own write"  ON public.recent_entities FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "recent_entities: own update" ON public.recent_entities FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "recent_entities: own delete" ON public.recent_entities FOR DELETE USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS recent_entities_user_type_idx ON public.recent_entities (user_id, entity_type, visited_at DESC);
CREATE INDEX IF NOT EXISTS recent_entities_tenant_idx    ON public.recent_entities (tenant_id, user_id, visited_at DESC);

GRANT ALL ON public.recent_entities TO authenticated;
GRANT ALL ON public.recent_entities TO service_role;
