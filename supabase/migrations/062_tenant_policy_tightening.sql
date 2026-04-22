-- BIZZ-736 follow-up: tighten per-tenant policies so they're explicitly
-- service_role-only, matching the public-table fix in 061.
--
-- The security-advisor flags every policy on tenant_*/notifications (INSERT
-- "service write") and tenant_*/property_snapshots (ALL "service write")
-- because they use WITH CHECK (true) or USING (true) without TO service_role.
-- These policies are only ever written by server code under the service_role
-- key, so adding TO service_role matches the actual usage and silences the
-- lint. No functional change — just role-tightening.
--
-- Loops across all tenant_* schemas and recreates the two policies on each.
-- Safe to re-run.

DO $$
DECLARE
  sch text;
BEGIN
  FOR sch IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant_%' AND nspname <> 'tenant'
  LOOP
    -- tenant_*.notifications — "service write" INSERT policy
    IF EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = sch AND tablename = 'notifications'
    ) THEN
      EXECUTE format(
        'DROP POLICY IF EXISTS %I ON %I.notifications',
        'notifications: service write',
        sch
      );
      EXECUTE format(
        'CREATE POLICY %I ON %I.notifications FOR INSERT TO service_role WITH CHECK (true)',
        'notifications: service write',
        sch
      );
    END IF;

    -- tenant_*.property_snapshots — "service write" ALL policy
    IF EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = sch AND tablename = 'property_snapshots'
    ) THEN
      EXECUTE format(
        'DROP POLICY IF EXISTS %I ON %I.property_snapshots',
        'property_snapshots: service write',
        sch
      );
      EXECUTE format(
        'CREATE POLICY %I ON %I.property_snapshots FOR ALL TO service_role USING (true) WITH CHECK (true)',
        'property_snapshots: service write',
        sch
      );
    END IF;
  END LOOP;
END $$;
