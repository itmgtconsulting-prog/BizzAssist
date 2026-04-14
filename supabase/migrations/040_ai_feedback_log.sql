-- BIZZ-237: AI feedback log — captures unmet needs and user satisfaction signals.
--
-- This table lives in the TENANT schema (data isolation). Each tenant gets
-- their own ai_feedback_log table via the provisionTenantSchema function.
--
-- GDPR: user_id + tenant_id enable cascade delete on account removal.
-- Retention: 12 months (enforced by /api/cron/purge-old-data).

CREATE TABLE IF NOT EXISTS tenant.ai_feedback_log (
  id              bigserial    PRIMARY KEY,
  tenant_id       uuid         NOT NULL,
  user_id         uuid         NOT NULL,
  conversation_id uuid,
  question_text   text         NOT NULL,
  feedback_type   text         NOT NULL CHECK (feedback_type IN (
    'tool_failure',
    'no_data',
    'user_thumbs_down',
    'missing_capability'
  )),
  ai_response_snippet text,
  page_context    text,
  metadata        jsonb        DEFAULT '{}',
  jira_ticket_id  text,
  created_at      timestamptz  NOT NULL DEFAULT now()
);

-- Index for admin dashboard queries (most recent first, filterable by type)
CREATE INDEX IF NOT EXISTS idx_ai_feedback_log_tenant_created
  ON tenant.ai_feedback_log (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_feedback_log_type
  ON tenant.ai_feedback_log (feedback_type, created_at DESC);

-- RLS: tenant isolation
ALTER TABLE tenant.ai_feedback_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_ai_feedback ON tenant.ai_feedback_log
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
