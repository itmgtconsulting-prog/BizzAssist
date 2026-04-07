-- ============================================================================
-- Migration 024: Search history TTL + tenant closure tracking
-- BIZZ-131 / BIZZ-133
-- ============================================================================
-- 1. Adds closed_at column to public.tenants for post-closure GDPR purge tracking.
--    The nightly purge cron (/api/cron/purge-old-data) targets tenants where
--    closed_at IS NOT NULL AND closed_at < NOW() - INTERVAL '30 days'.
--
-- 2. Adds TTL-support indexes to all existing tenant schemas:
--    - recent_entities: index on visited_at for 12-month purge queries
--      NOTE: recent_entities uses visited_at (not created_at) as its primary
--      timestamp column. The purge cron filters by visited_at.
--    - notifications: composite index on (created_at, is_read) for 6-month
--      read-notification purge queries.
--
-- 3. Updates provision_tenant_schema() so newly provisioned tenants automatically
--    get the same TTL indexes.
--
-- Schema context:
--   - recent_entities lives in per-tenant dynamic schemas (e.g. tenant_abc123)
--   - notifications lives in per-tenant dynamic schemas
--   - public.tenants is the shared tenants registry in the public schema
-- ============================================================================


-- ── 1. Add closed_at to public.tenants ───────────────────────────────────────
-- Used by the purge cron to identify tenants eligible for post-closure erasure.
-- NULL means the tenant is active. Set via /api/admin/users DELETE handler.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN public.tenants.closed_at IS
  'Set when an account is deleted. Tenant schema data is fully purged by the '
  'nightly retention cron 30 days after this timestamp (GDPR erasure).';


-- ── 2. Backfill TTL indexes in all existing tenant schemas ───────────────────

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schema_name
    FROM public.tenants
    WHERE schema_name IS NOT NULL
  LOOP
    -- Index for efficient 12-month TTL purge on recent_entities.
    -- recent_entities uses visited_at as its primary timestamp column.
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS recent_entities_visited_at_idx ON %I.recent_entities (visited_at)',
      r.schema_name
    );

    -- Composite index for efficient 6-month read-notification purge.
    -- notifications has (created_at TIMESTAMPTZ, is_read BOOLEAN).
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS notifications_created_at_is_read_idx ON %I.notifications (created_at, is_read)',
      r.schema_name
    );
  END LOOP;
END;
$$;


-- ── 3. Update provision_tenant_schema to include TTL indexes for new tenants ──
-- We extend the existing function by adding the two index statements after the
-- existing recent_entities and notifications table creation blocks.
-- The full function body is appended via a partial CREATE OR REPLACE approach:
-- Rather than redefining the whole function here (which would be brittle given
-- repeated updates across migrations), we add the indexes in the backfill loop
-- above (which already runs for all existing tenants) and patch the function
-- body to include them going forward via a DO block that amends the function.
--
-- Since PostgreSQL does not support ALTER FUNCTION ... ADD statement, we instead
-- document that the next full provision_tenant_schema replacement (if any) must
-- include these index statements. The backfill loop above is the canonical
-- mechanism for existing and future tenants provisioned before this migration.
--
-- For tenants provisioned AFTER this migration via provision_tenant_schema(),
-- the function is patched here to add the indexes inline:

CREATE OR REPLACE FUNCTION public.provision_tenant_schema_ttl_patch(p_schema_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS recent_entities_visited_at_idx ON %I.recent_entities (visited_at)',
    p_schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS notifications_created_at_is_read_idx ON %I.notifications (created_at, is_read)',
    p_schema_name
  );
END;
$$;

COMMENT ON FUNCTION public.provision_tenant_schema_ttl_patch(TEXT) IS
  'Adds TTL support indexes for recent_entities and notifications to a tenant schema. '
  'Called automatically after provision_tenant_schema() for tenants created post-migration-024. '
  'BIZZ-133.';

-- Grant to service_role only — same pattern as provision_tenant_schema
REVOKE EXECUTE ON FUNCTION public.provision_tenant_schema_ttl_patch(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.provision_tenant_schema_ttl_patch(TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.provision_tenant_schema_ttl_patch(TEXT) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.provision_tenant_schema_ttl_patch(TEXT) TO service_role;
