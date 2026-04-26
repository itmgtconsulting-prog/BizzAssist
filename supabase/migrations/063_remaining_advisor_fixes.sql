-- BIZZ-736 follow-up: remaining 3 advisor findings after 061 + 062.
--
-- 1) ERROR policy_exists_rls_disabled on tenant_jakob_test.notifications:
--    RLS was disabled on the table but a policy exists. Enable RLS so the
--    policy actually applies.
-- 2) WARN rls_policy_always_true on public.verified_links "verified_links:
--    update service" — missed by 061 because it wasn't in the initial list.
-- 3) WARN rls_policy_always_true on tenant_*.property_snapshots "service
--    update" — migration 062 only fixed "service write", not "service
--    update". Extend to cover both policy names.

-- ─── 1. Enable RLS where policies exist but RLS is off ──────────────────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT n.nspname AS schemaname, c.relname AS tablename
    FROM pg_policies p
    JOIN pg_class c ON c.relname = p.tablename
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = p.schemaname
    WHERE p.schemaname LIKE 'tenant_%'
      AND c.relrowsecurity = false
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schemaname, r.tablename);
  END LOOP;
END $$;

-- ─── 2. public.verified_links — tighten UPDATE policy ──────────────────────
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'verified_links'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.verified_links', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "service_role_only"
  ON public.verified_links
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ─── 3. Extend 062 to cover tenant_*.property_snapshots "service update" ───
DO $$
DECLARE
  sch text;
BEGIN
  FOR sch IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant_%' AND nspname <> 'tenant'
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = sch AND tablename = 'property_snapshots'
    ) THEN
      -- Drop any policy on property_snapshots whose name matches the
      -- known-permissive variants and recreate as service_role-only.
      EXECUTE format(
        'DROP POLICY IF EXISTS %I ON %I.property_snapshots',
        'property_snapshots: service update',
        sch
      );
      -- If a consolidated policy already exists from 062, skip; otherwise
      -- create a service-role-only UPDATE policy.
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = sch
          AND tablename = 'property_snapshots'
          AND policyname = 'property_snapshots: service update'
      ) THEN
        EXECUTE format(
          'CREATE POLICY %I ON %I.property_snapshots FOR UPDATE TO service_role USING (true) WITH CHECK (true)',
          'property_snapshots: service update',
          sch
        );
      END IF;
    END IF;
  END LOOP;
END $$;
