-- ============================================================================
-- 078: public.system_config — Central admin-konfigurerbar nøgle/værdi-store.
--
-- BIZZ-419: Flytter hardcoded værdier (endpoints, emails, rate-limits, cache-
-- TTL osv.) fra kode til DB så admin kan opdatere uden redeploy.
-- Adgang er strengt gated: kun super-admin (app_metadata.isAdmin=true) må
-- læse eller skrive. Application-code læser via systemConfig.getConfig()
-- helper der cacher 5 min for at undgå DB-roundtrips per request.
--
-- Fallback-hierarki ved læsning:
--   1. LRU cache (5 min TTL)
--   2. public.system_config row
--   3. process.env fallback
--   4. caller-provided defaultValue
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.system_config (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  category    TEXT         NOT NULL,
  key         TEXT         NOT NULL UNIQUE,
  value       JSONB        NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_by  UUID         REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS system_config_category_idx ON public.system_config (category);
CREATE INDEX IF NOT EXISTS system_config_updated_at_idx ON public.system_config (updated_at DESC);

COMMENT ON TABLE public.system_config IS
  'BIZZ-419: Central admin-konfigurerbar nøgle/værdi-store. Læs via app/lib/systemConfig.ts getConfig(). Super-admin only via RLS.';
COMMENT ON COLUMN public.system_config.category IS
  'Gruppering til admin-UI (endpoints, email, rate_limits, cache, company, feature_flags)';
COMMENT ON COLUMN public.system_config.key IS
  'Unik konstant-navn som koden slår op på (snake_case, fx support_email, datafordeler_graphql_url)';
COMMENT ON COLUMN public.system_config.value IS
  'JSONB så vi understøtter både string, number, boolean, object og array uden schema-migrationer';

-- ─── RLS: super_admin only ──────────────────────────────────────────────────
ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;

-- Drop eventuelle legacy policies før vi opretter nye (idempotent)
DROP POLICY IF EXISTS system_config_admin_read ON public.system_config;
DROP POLICY IF EXISTS system_config_admin_write ON public.system_config;

-- Læse-policy: authenticated med app_metadata.isAdmin=true
CREATE POLICY system_config_admin_read ON public.system_config
  FOR SELECT TO authenticated
  USING (
    coalesce(
      (auth.jwt() -> 'app_metadata' ->> 'isAdmin')::boolean,
      false
    ) = true
  );

-- Skrive-policy: samme check. Service_role bypasser RLS så backfill-scripts
-- og getConfig() fallback kan skrive uden auth-context.
CREATE POLICY system_config_admin_write ON public.system_config
  FOR ALL TO authenticated
  USING (
    coalesce(
      (auth.jwt() -> 'app_metadata' ->> 'isAdmin')::boolean,
      false
    ) = true
  )
  WITH CHECK (
    coalesce(
      (auth.jwt() -> 'app_metadata' ->> 'isAdmin')::boolean,
      false
    ) = true
  );

-- ─── updated_at trigger ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.system_config_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS system_config_touch_updated_at ON public.system_config;
CREATE TRIGGER system_config_touch_updated_at
  BEFORE UPDATE ON public.system_config
  FOR EACH ROW
  EXECUTE FUNCTION public.system_config_touch_updated_at();
