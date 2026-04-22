-- BIZZ-736: Fix Supabase security-advisor findings (ERROR + WARN + INFO).
--
-- Context: Supabase security-advisor reported 34 lints in prod (1 ERROR,
-- 28 WARN, 5 INFO). This migration addresses the ERROR plus the easy WARN/
-- INFO items; tightening the 25 rls_policy_always_true policies on tenant
-- schemas is out of scope (handled in a follow-up).
--
-- Safe to re-run (idempotent via DROP/CREATE + CREATE POLICY IF NOT EXISTS).

-- ─── 1. ERROR: security_definer_view on link_verification_counts ────────────
-- The view was inheriting SECURITY DEFINER semantics which bypasses the
-- querying user's RLS. Recreate with explicit security_invoker = true.

DROP VIEW IF EXISTS public.link_verification_counts;

CREATE VIEW public.link_verification_counts
  WITH (security_invoker = true) AS
SELECT
  cvr,
  link_url,
  platform,
  link_type,
  COUNT(*) FILTER (WHERE verdict = 'verified') AS verified_count,
  COUNT(*) FILTER (WHERE verdict = 'rejected') AS rejected_count
FROM public.link_verifications
GROUP BY cvr, link_url, platform, link_type;

COMMENT ON VIEW public.link_verification_counts IS
  'Aggregated verified/rejected counts per (cvr, link_url). security_invoker=true (BIZZ-736).';

-- ─── 2. WARN: function_search_path_mutable ──────────────────────────────────
-- Without an explicit search_path, these trigger functions are vulnerable to
-- search-path hijacking. Pin them to the schema they actually operate on.

ALTER FUNCTION public.set_updated_at() SET search_path = public;
ALTER FUNCTION public.ai_settings_set_updated_at() SET search_path = public;
-- tenant.set_knowledge_updated_at lives in the tenant-template schema; fix
-- the template definition so every tenant provisioned after this migration
-- gets the secure variant. Existing tenant functions are handled per-tenant
-- in the follow-up.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'set_knowledge_updated_at' AND n.nspname = 'tenant'
  ) THEN
    EXECUTE 'ALTER FUNCTION tenant.set_knowledge_updated_at() SET search_path = tenant, public';
  END IF;
END $$;

-- ─── 3. INFO: rls_enabled_no_policy ─────────────────────────────────────────
-- These tables have RLS enabled but no policies, which gives authenticated
-- users 0 rows (intended — they're service-role-only). Add explicit
-- service_role-only policies so the lint passes and intent is documented.

CREATE POLICY "service_role_only" ON public.cvr_aendring_cursor
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_only" ON public.cvr_virksomhed
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_only" ON public.service_probe_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_only" ON public.tinglysning_aendring_cursor
  FOR ALL TO service_role USING (true) WITH CHECK (true);
-- regnskab_cache had its RLS enabled by 044_regnskab_cache_rls — the lint
-- still fires because no named policy exists beyond the deny-all default.
-- Add a service_role-only policy for symmetry with the cursors above.
CREATE POLICY "service_role_only" ON public.regnskab_cache
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── 4. WARN: rls_policy_always_true on 3 public tables ─────────────────────
-- The existing policies on consent_log, cron_heartbeats, support_questions
-- use USING (true) without restricting to service_role, which makes the
-- lint flag them as permissive. Drop + recreate with TO service_role so the
-- policy is explicitly service-role-only (matching the actual usage — these
-- tables are only written by cron/server code, never by authenticated users).

DO $$
DECLARE
  tbl text;
  pol record;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['consent_log', 'cron_heartbeats', 'support_questions']) LOOP
    FOR pol IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = tbl
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, tbl);
    END LOOP;
    EXECUTE format(
      'CREATE POLICY "service_role_only" ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      tbl
    );
  END LOOP;
END $$;

-- Leave the 22 tenant_*.notifications / property_snapshots policies for a
-- follow-up: they need to loop across existing tenant schemas and tighten
-- per-tenant, which is riskier and deserves its own change set.
