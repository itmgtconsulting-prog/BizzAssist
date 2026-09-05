-- Migration 208: AI token-usage via public SECURITY DEFINER RPCs (BIZZ-2205)
--
-- Root cause of the always-empty Forbrugshistorik: the app wrote/read token
-- usage via admin.schema('tenant').from('ai_token_usage'), but the shared
-- `tenant` schema is exposed to PostgREST in NO environment (db_schema only
-- lists public/graphql_public + a handful of per-tenant schemas). Every call
-- therefore returned PGRST106 ("Invalid schema: tenant") — silently swallowed by
-- a catch{}. In prod the `tenant` schema didn't even exist.
--
-- Fix: route all token-usage writes/reads through SECURITY DEFINER functions in
-- `public` (always exposed), mirroring the ai_chat_* RPC pattern. Idempotent +
-- applied to all three environments.

-- 1. Ensure the shared audit table exists (missing entirely in prod).
CREATE SCHEMA IF NOT EXISTS tenant;

CREATE TABLE IF NOT EXISTS tenant.ai_token_usage (
  id          bigserial    PRIMARY KEY,
  tenant_id   uuid         NOT NULL,
  user_id     uuid         NOT NULL,
  tokens_in   integer      NOT NULL DEFAULT 0,
  tokens_out  integer      NOT NULL DEFAULT 0,
  model       text         NOT NULL,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  route       text
);
CREATE INDEX IF NOT EXISTS ai_token_usage_tenant_month_idx
  ON tenant.ai_token_usage (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_token_usage_user_idx
  ON tenant.ai_token_usage (user_id, created_at DESC);

-- 2. Write RPC — inserts one audit row. SECURITY DEFINER so it works without
--    exposing the tenant schema to PostgREST.
CREATE OR REPLACE FUNCTION public.record_ai_token_usage(
  p_tenant_id uuid,
  p_user_id   uuid,
  p_tokens_in integer,
  p_tokens_out integer,
  p_model     text,
  p_route     text DEFAULT NULL
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = tenant, public, pg_temp
AS $$
  INSERT INTO tenant.ai_token_usage (tenant_id, user_id, tokens_in, tokens_out, model, route)
  VALUES (p_tenant_id, p_user_id, p_tokens_in, p_tokens_out, p_model, p_route);
$$;

-- 3. Read RPC — paginated usage history for one tenant+user.
CREATE OR REPLACE FUNCTION public.get_ai_token_usage(
  p_tenant_id uuid,
  p_user_id   uuid,
  p_limit     integer,
  p_offset    integer
) RETURNS TABLE (
  id          bigint,
  route       text,
  tokens_in   integer,
  tokens_out  integer,
  model       text,
  created_at  timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenant, public, pg_temp
AS $$
  SELECT id, route, tokens_in, tokens_out, model, created_at
  FROM tenant.ai_token_usage
  WHERE tenant_id = p_tenant_id AND user_id = p_user_id
  ORDER BY created_at DESC
  LIMIT GREATEST(p_limit, 0) OFFSET GREATEST(p_offset, 0);
$$;

-- 4. Total row count for the same filter (usage-history pagination).
CREATE OR REPLACE FUNCTION public.get_ai_token_usage_total(
  p_tenant_id uuid,
  p_user_id   uuid
) RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenant, public, pg_temp
AS $$
  SELECT count(*) FROM tenant.ai_token_usage
  WHERE tenant_id = p_tenant_id AND user_id = p_user_id;
$$;

-- 5. Monthly token sum for the tenant budget gate (tokens_in + tokens_out since
--    the first of the current month).
CREATE OR REPLACE FUNCTION public.tenant_monthly_token_sum(
  p_tenant_id uuid
) RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenant, public, pg_temp
AS $$
  SELECT COALESCE(SUM(tokens_in + tokens_out), 0)::bigint
  FROM tenant.ai_token_usage
  WHERE tenant_id = p_tenant_id
    AND created_at >= date_trunc('month', now());
$$;

-- 6. Grants — the app calls these as service_role; usage-history reads via the
--    service-role admin client. authenticated included for defensive parity.
GRANT EXECUTE ON FUNCTION public.record_ai_token_usage(uuid, uuid, integer, integer, text, text) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ai_token_usage(uuid, uuid, integer, integer) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ai_token_usage_total(uuid, uuid) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_monthly_token_sum(uuid) TO service_role, authenticated;
