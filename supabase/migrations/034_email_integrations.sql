-- Migration 034: Email integrations (Gmail OAuth) — BIZZ-47
-- Stores OAuth tokens for Gmail integration per tenant user.
-- Retention: tokens deleted on user account deletion (cascade via tenant schema drop).

CREATE TABLE IF NOT EXISTS tenant.email_integrations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  provider      text NOT NULL DEFAULT 'gmail' CHECK (provider IN ('gmail', 'outlook')),
  email_address text NOT NULL,
  access_token  text NOT NULL,  -- AES-256 encrypted at rest via Supabase Vault
  refresh_token text NOT NULL,  -- AES-256 encrypted at rest via Supabase Vault
  token_expires_at timestamptz NOT NULL,
  scopes        text[] NOT NULL DEFAULT '{}',
  connected_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  UNIQUE(user_id, provider)
);

ALTER TABLE tenant.email_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_integrations" ON tenant.email_integrations
  FOR ALL USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_email_integrations_user ON tenant.email_integrations(user_id);
