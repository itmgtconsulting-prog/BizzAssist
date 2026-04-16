-- BIZZ-273: Notification preferences per user per tenant.
-- Allows users to opt-in/out of specific notification types and channels.

-- Add to tenant schema provisioning function
-- For existing tenants, the table is created on first access.

-- NOTE: This migration creates the table in the public schema as a template.
-- The actual per-tenant table is created by the provisioning function.
-- This serves as documentation of the schema.

/*
CREATE TABLE IF NOT EXISTS tenant_{TENANT_ID}.notification_preferences (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL,
  notification_type TEXT      NOT NULL,  -- 'property_valuation_changed', 'subscription_renewed', etc.
  channel         TEXT        NOT NULL DEFAULT 'in_app',  -- 'in_app', 'email', 'sms'
  enabled         BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, notification_type, channel)
);

ALTER TABLE tenant_{TENANT_ID}.notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notification_preferences: users manage own"
  ON tenant_{TENANT_ID}.notification_preferences
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
*/

-- For now, notification preferences are stored in user_metadata
-- to avoid per-tenant schema migration complexity. This can be
-- migrated to a dedicated table when needed.
