-- ============================================================
-- Migration 028: activity_log — user event tracking
-- BizzAssist — BIZZ-91: Server-side activity logging to Supabase
--
-- Tracks user events for usage analytics and future billing.
-- Retention: 12 months (enforced by /api/cron/purge-old-data).
-- No PII stored — payload contains only identifiers and counts.
-- ============================================================

CREATE TABLE IF NOT EXISTS tenant.activity_log (
  id            bigserial   PRIMARY KEY,
  tenant_id     uuid        NOT NULL,
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type    text        NOT NULL CHECK (
    event_type IN (
      'address_search',
      'ai_chat',
      'page_view',
      'property_open',
      'company_open',
      'owner_open'
    )
  ),
  payload       jsonb       NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Index for per-tenant analytics queries (most common access pattern)
CREATE INDEX IF NOT EXISTS activity_log_tenant_created_idx
  ON tenant.activity_log (tenant_id, created_at DESC);

-- Index for per-user queries (billing, quota, user-level analytics)
CREATE INDEX IF NOT EXISTS activity_log_user_idx
  ON tenant.activity_log (user_id, created_at DESC);
