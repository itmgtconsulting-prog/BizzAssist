-- Migration 035: Add LinkedIn provider to email_integrations — BIZZ-48
-- Extends the provider check constraint to include 'linkedin'.
--
-- Background: migration 034 created email_integrations with CHECK (provider IN ('gmail', 'outlook')).
-- PostgreSQL does not support ALTER TABLE ... MODIFY CONSTRAINT inline,
-- so we drop and recreate the constraint.
--
-- Note: LinkedIn access tokens last 60 days (no refresh tokens in standard OAuth).
-- The refresh_token column is stored as an empty string for LinkedIn rows.

ALTER TABLE tenant.email_integrations
  DROP CONSTRAINT IF EXISTS email_integrations_provider_check;

ALTER TABLE tenant.email_integrations
  ADD CONSTRAINT email_integrations_provider_check
    CHECK (provider IN ('gmail', 'outlook', 'linkedin'));
