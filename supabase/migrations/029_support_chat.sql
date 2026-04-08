-- ============================================================
-- Migration 029: support_chat — AI-powered support chat sessions
-- BizzAssist — BIZZ: Support Chat with Abuse Protection
--
-- support_chat_sessions: tracks support AI token usage per user,
--   separate from the main AI quota (different billing bucket).
--   Retention: 12 months (enforced by /api/cron/purge-old-data).
--   No PII stored — only token counts and UUIDs.
--
-- support_chat_abuse: escalating lockout tracker in public schema
--   (not tenant-scoped, because abuse is a platform-level concern).
--   Lockout escalation:
--     1st violation → 30 minutes
--     2nd violation → 2 hours
--     3rd violation → 24 hours
--     4th+ violation → permanently_locked = true (admin unlock required)
-- ============================================================

-- Support chat sessions — tenant-scoped, tracks token usage per user
CREATE TABLE IF NOT EXISTS tenant.support_chat_sessions (
  id              bigserial    PRIMARY KEY,
  tenant_id       uuid         NOT NULL,
  user_id         uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tokens_used     integer      NOT NULL DEFAULT 0,
  created_at      timestamptz  NOT NULL DEFAULT now()
);

-- Index for per-user, per-day abuse detection queries
CREATE INDEX IF NOT EXISTS support_sessions_user_day_idx
  ON tenant.support_chat_sessions (user_id, created_at DESC);

-- Index for per-tenant analytics
CREATE INDEX IF NOT EXISTS support_sessions_tenant_idx
  ON tenant.support_chat_sessions (tenant_id, created_at DESC);

-- Support chat abuse tracker — platform-level, not tenant-scoped
CREATE TABLE IF NOT EXISTS public.support_chat_abuse (
  user_id            uuid         PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  violation_count    integer      NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  permanently_locked boolean      NOT NULL DEFAULT false,
  last_violation     timestamptz,
  unlocked_by        uuid         REFERENCES auth.users(id) ON DELETE SET NULL,
  unlocked_at        timestamptz,
  updated_at         timestamptz  NOT NULL DEFAULT now()
);
