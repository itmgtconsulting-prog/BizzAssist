-- 030_ai_token_usage.sql
-- ai_token_usage: monthly token consumption per tenant for billing and rate limiting.
-- Retention: records are kept for 13 months to support year-over-year comparisons,
-- then purged by /api/cron/purge-old-data.
-- Every row is scoped to tenant_id + user_id for GDPR cascade-delete compliance.

CREATE TABLE IF NOT EXISTS tenant.ai_token_usage (
  id          bigserial    PRIMARY KEY,
  tenant_id   uuid         NOT NULL,
  user_id     uuid         NOT NULL,
  tokens_in   integer      NOT NULL DEFAULT 0,
  tokens_out  integer      NOT NULL DEFAULT 0,
  model       text         NOT NULL,
  created_at  timestamptz  NOT NULL DEFAULT now()
);

-- Index optimised for the monthly quota check query:
--   WHERE tenant_id = $1 AND created_at >= <month_start>
CREATE INDEX IF NOT EXISTS ai_token_usage_tenant_month_idx
  ON tenant.ai_token_usage (tenant_id, created_at DESC);

-- Index for per-user lookups (GDPR delete, user-level analytics)
CREATE INDEX IF NOT EXISTS ai_token_usage_user_idx
  ON tenant.ai_token_usage (user_id, created_at DESC);
