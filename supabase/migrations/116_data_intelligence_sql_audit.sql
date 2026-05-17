-- ============================================================
-- Migration 116: ai_sql_audit table (BIZZ-1423)
-- ============================================================
-- Audit-log for hver AI-genereret SQL-query. Kritisk for ISO 27001 +
-- sporbarhed. 12 måneders retention (GDPR).
-- ============================================================

CREATE TABLE IF NOT EXISTS dataintel.ai_sql_audit (
  id              uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  tenant_id       uuid        NOT NULL,
  user_id         uuid        NOT NULL,
  user_prompt     text        NOT NULL,
  generated_sql   text        NOT NULL,
  ast_validated   boolean     NOT NULL DEFAULT false,
  executed        boolean     NOT NULL DEFAULT false,
  error           text,
  row_count       integer,
  duration_ms     integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_sql_audit_tenant_idx
  ON dataintel.ai_sql_audit (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_sql_audit_executed_idx
  ON dataintel.ai_sql_audit (executed, ast_validated, created_at DESC);

-- ─── RLS ────────────────────────────────────────────────────
-- Audit-log er tenant-scoped: brugere kan kun se egne queries.
-- service_role har fuld adgang (cron + admin views).
ALTER TABLE dataintel.ai_sql_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_sql_audit_own_tenant ON dataintel.ai_sql_audit;
CREATE POLICY ai_sql_audit_own_tenant
  ON dataintel.ai_sql_audit
  FOR SELECT
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tenant_id
      FROM public.tenant_memberships
      WHERE user_id = auth.uid()
    )
  );

GRANT SELECT ON dataintel.ai_sql_audit TO authenticated;
GRANT ALL    ON dataintel.ai_sql_audit TO service_role;

COMMENT ON TABLE dataintel.ai_sql_audit IS
  'BIZZ-1423: Audit-log for AI-genereret SQL. 12 mdr retention. ISO 27001 A.12.4.';
