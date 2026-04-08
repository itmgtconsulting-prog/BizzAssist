-- ============================================================
-- Migration 033: Enterprise API tokens
-- BizzAssist — BIZZ-54
-- ============================================================
-- Stores hashed API keys issued to tenants for programmatic
-- access to the BizzAssist public REST API (v1).
--
-- Security design:
--   • Only the SHA-256 hash of the token is persisted — the
--     plaintext is shown to the user exactly once after creation
--     and is never stored or recoverable.
--   • The `prefix` column stores the first 8 visible chars of the
--     token (e.g. "bza_xYzA") so users can identify keys in the UI.
--   • RLS ensures tenants can only see their own tokens.
--   • Soft-delete via `revoked` flag — rows are never hard-deleted
--     so audit history is preserved.
--
-- Retention: indefinite while tenant is active; cascade-deleted
-- when the tenant is offboarded.
-- GDPR: each row carries tenant_id + user_id for cascade delete.
-- ISO 27001: A.9 (Access Control) — RLS + hash-only storage.
-- ============================================================


-- ──────────────────────────────────────────────────────────────
-- PART 1: Table
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenant.api_tokens (
  id          bigserial    PRIMARY KEY,
  tenant_id   uuid         NOT NULL,
  user_id     uuid         NOT NULL,
  name        text         NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  token_hash  text         NOT NULL UNIQUE,  -- SHA-256 hex digest of the raw token
  prefix      text         NOT NULL,          -- First 12 chars of raw token shown in UI
  scopes      text[]       NOT NULL DEFAULT '{}',
  last_used   timestamptz,
  expires_at  timestamptz,                    -- NULL = no expiry
  revoked     boolean      NOT NULL DEFAULT false,
  created_at  timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenant.api_tokens IS
  'Enterprise API keys issued to tenants. Only SHA-256 hashes are stored — '
  'plaintext tokens are shown once at creation and never persisted. BIZZ-54.';

COMMENT ON COLUMN tenant.api_tokens.token_hash IS
  'SHA-256 hex digest of the raw bearer token. Used for fast lookup on every '
  'authenticated API request.';

COMMENT ON COLUMN tenant.api_tokens.prefix IS
  'First 12 characters of the raw token (e.g. "bza_xYzA1234") displayed in '
  'the UI so users can identify which key is which without revealing the secret.';

COMMENT ON COLUMN tenant.api_tokens.scopes IS
  'Array of granted permission scopes, e.g. ''{read:properties, read:companies}''.';

COMMENT ON COLUMN tenant.api_tokens.expires_at IS
  'Optional expiry timestamp. NULL means the token never expires. '
  'The verify endpoint rejects tokens where expires_at < now().';

COMMENT ON COLUMN tenant.api_tokens.revoked IS
  'Soft-delete flag. Revoked tokens are rejected by the verify endpoint but '
  'are never hard-deleted so the audit trail is preserved.';


-- ──────────────────────────────────────────────────────────────
-- PART 2: Indexes
-- ──────────────────────────────────────────────────────────────

-- Tenant listing (dashboard page)
CREATE INDEX IF NOT EXISTS api_tokens_tenant_idx
  ON tenant.api_tokens (tenant_id, created_at DESC);

-- Token verification on every API call — must be extremely fast
CREATE INDEX IF NOT EXISTS api_tokens_hash_idx
  ON tenant.api_tokens (token_hash)
  WHERE revoked = false;


-- ──────────────────────────────────────────────────────────────
-- PART 3: Row Level Security
-- ──────────────────────────────────────────────────────────────

ALTER TABLE tenant.api_tokens ENABLE ROW LEVEL SECURITY;

-- Read: any tenant member may list their own tenant's tokens
DROP POLICY IF EXISTS "api_tokens: members read" ON tenant.api_tokens;
CREATE POLICY "api_tokens: members read"
  ON tenant.api_tokens
  FOR SELECT
  USING (public.is_tenant_member(tenant_id));

-- Create: any tenant member may create keys (admin check done in app layer)
DROP POLICY IF EXISTS "api_tokens: members insert" ON tenant.api_tokens;
CREATE POLICY "api_tokens: members insert"
  ON tenant.api_tokens
  FOR INSERT
  WITH CHECK (public.is_tenant_member(tenant_id));

-- Revoke: only the key owner or a tenant admin may revoke
DROP POLICY IF EXISTS "api_tokens: owner or admin update" ON tenant.api_tokens;
CREATE POLICY "api_tokens: owner or admin update"
  ON tenant.api_tokens
  FOR UPDATE
  USING (
    public.is_tenant_member(tenant_id)
    AND (
      user_id = auth.uid()
      OR public.is_tenant_admin(tenant_id)
    )
  );

-- No hard deletes — only soft-revoke is permitted
DROP POLICY IF EXISTS "api_tokens: no delete" ON tenant.api_tokens;
CREATE POLICY "api_tokens: no delete"
  ON tenant.api_tokens
  FOR DELETE
  USING (false);
