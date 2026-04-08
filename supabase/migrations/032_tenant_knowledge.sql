-- ============================================================
-- Migration 032: Tenant knowledge base for AI context
-- BizzAssist — BIZZ-37
-- ============================================================
-- Stores tenant-uploaded documents and freeform knowledge that
-- the AI assistant can reference when answering questions.
-- Each row belongs to exactly one tenant and is scoped with
-- row-level security so cross-tenant access is impossible.
--
-- Retention: content is user-managed; no automatic expiry.
-- GDPR: each row carries tenant_id and created_by for cascade
-- delete via the tenant schema DROP used during offboarding.
--
-- ISO 27001: A.9 (Access Control) — RLS enforced via
-- public.is_tenant_member() / public.is_tenant_admin() helpers.
-- ============================================================


-- ──────────────────────────────────────────────────────────────
-- PART 1: Create table in the shared tenant schema namespace
-- ──────────────────────────────────────────────────────────────

-- NOTE: tenant_knowledge lives in the "tenant" schema used by
-- the Supabase PostgREST .schema('tenant') API. Each physical
-- tenant has its own schema (tenant_<uuid>), but this shared
-- table carries an explicit tenant_id column that is always
-- filtered in application code and enforced via RLS.
CREATE TABLE IF NOT EXISTS tenant.tenant_knowledge (
  id          bigserial    PRIMARY KEY,
  tenant_id   uuid         NOT NULL,
  title       text         NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  content     text         NOT NULL CHECK (char_length(content) BETWEEN 1 AND 50000),
  source_type text         NOT NULL DEFAULT 'manual'
                           CHECK (source_type IN ('manual', 'upload', 'url')),
  created_by  uuid         NOT NULL,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenant.tenant_knowledge IS
  'Tenant-uploaded knowledge snippets injected into the AI assistant system prompt. '
  'Max 50 000 chars per row. BIZZ-37.';

-- Index: fast lookup by tenant when building AI context
CREATE INDEX IF NOT EXISTS tenant_knowledge_tenant_idx
  ON tenant.tenant_knowledge (tenant_id, created_at DESC);


-- ──────────────────────────────────────────────────────────────
-- PART 2: Row Level Security
-- ──────────────────────────────────────────────────────────────

ALTER TABLE tenant.tenant_knowledge ENABLE ROW LEVEL SECURITY;

-- Read: any tenant member may view their own tenant's knowledge
DROP POLICY IF EXISTS "knowledge: members read" ON tenant.tenant_knowledge;
CREATE POLICY "knowledge: members read"
  ON tenant.tenant_knowledge
  FOR SELECT
  USING (public.is_tenant_member(tenant_id));

-- Write: only tenant admins may insert / update
DROP POLICY IF EXISTS "knowledge: admins write" ON tenant.tenant_knowledge;
CREATE POLICY "knowledge: admins write"
  ON tenant.tenant_knowledge
  FOR INSERT
  WITH CHECK (public.is_tenant_admin(tenant_id));

DROP POLICY IF EXISTS "knowledge: admins update" ON tenant.tenant_knowledge;
CREATE POLICY "knowledge: admins update"
  ON tenant.tenant_knowledge
  FOR UPDATE
  USING (public.is_tenant_admin(tenant_id))
  WITH CHECK (public.is_tenant_admin(tenant_id));

-- Delete: only tenant admins may delete
DROP POLICY IF EXISTS "knowledge: admins delete" ON tenant.tenant_knowledge;
CREATE POLICY "knowledge: admins delete"
  ON tenant.tenant_knowledge
  FOR DELETE
  USING (public.is_tenant_admin(tenant_id));


-- ──────────────────────────────────────────────────────────────
-- PART 3: Auto-update updated_at trigger
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION tenant.set_knowledge_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_knowledge_updated_at ON tenant.tenant_knowledge;
CREATE TRIGGER trg_knowledge_updated_at
  BEFORE UPDATE ON tenant.tenant_knowledge
  FOR EACH ROW EXECUTE FUNCTION tenant.set_knowledge_updated_at();
