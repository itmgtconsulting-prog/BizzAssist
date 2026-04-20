-- Migration 049: RLS write-policies for plan_configs + token_packs
--
-- BIZZ-636: Super-admin kunne ikke oprette nye abonnementsplaner på
-- /dashboard/admin/plans → Planer. POST til /api/admin/plans returnerede
-- 500 Internal server error med PG-fejl "new row violates row-level
-- security policy for table plan_configs".
--
-- Root cause: Migration 009 aktiverede RLS på plan_configs + token_packs
-- men tilføjede KUN en SELECT-policy. Enhver INSERT/UPDATE/DELETE blev
-- derfor nægtet — også fra service_role hvis policy-baserede restrictions
-- på auth.uid() overvalidering slog igennem pga. RLS FORCE-semantik.
--
-- Fix: Tilføj eksplicitte write-policies for:
--   (a) service_role — vores admin-API (createAdminClient) bruger denne
--   (b) authenticated super-admin — via app_metadata.isAdmin check
--
-- Pattern matcher andre admin-tabeller i projektet (fx tenants,
-- subscriptions hvor lignende policies findes).
--
-- Idempotent — migration kan køres flere gange uden fejl.

-- ─── plan_configs write-policies ─────────────────────────────────────────

-- Service role: fuld write-adgang (brugt af /api/admin/plans via admin client)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'plan_configs'
      AND policyname = 'plan_configs_service_role_write'
  ) THEN
    CREATE POLICY plan_configs_service_role_write
      ON public.plan_configs
      AS PERMISSIVE
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- Super-admin (authenticated user med app_metadata.isAdmin = true):
-- Dette dækker det sjældne tilfælde hvor admin-UI'et rammer DB direkte
-- via brugerens session (ikke service_role). Referee app_metadata er
-- en JWT-claim der sættes via Supabase Auth Admin API på brugeroprettelse.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'plan_configs'
      AND policyname = 'plan_configs_admin_write'
  ) THEN
    CREATE POLICY plan_configs_admin_write
      ON public.plan_configs
      AS PERMISSIVE
      FOR ALL
      TO authenticated
      USING (
        coalesce(
          (auth.jwt() -> 'app_metadata' ->> 'isAdmin')::boolean,
          false
        )
      )
      WITH CHECK (
        coalesce(
          (auth.jwt() -> 'app_metadata' ->> 'isAdmin')::boolean,
          false
        )
      );
  END IF;
END $$;

-- ─── token_packs write-policies (samme mønster) ─────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'token_packs'
      AND policyname = 'token_packs_service_role_write'
  ) THEN
    CREATE POLICY token_packs_service_role_write
      ON public.token_packs
      AS PERMISSIVE
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'token_packs'
      AND policyname = 'token_packs_admin_write'
  ) THEN
    CREATE POLICY token_packs_admin_write
      ON public.token_packs
      AS PERMISSIVE
      FOR ALL
      TO authenticated
      USING (
        coalesce(
          (auth.jwt() -> 'app_metadata' ->> 'isAdmin')::boolean,
          false
        )
      )
      WITH CHECK (
        coalesce(
          (auth.jwt() -> 'app_metadata' ->> 'isAdmin')::boolean,
          false
        )
      );
  END IF;
END $$;
