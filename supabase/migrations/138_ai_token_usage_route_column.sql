-- ============================================================================
-- 138: Tilføj route-kolonne til tenant.ai_token_usage — BIZZ-1594 (PR1)
-- ============================================================================
-- Foundation for central recordAiUsage-helper i app/lib/aiTracking.ts.
-- model-kolonnen findes allerede; vi tilføjer kun route + index så vi kan
-- rapportere AI-token-forbrug per tool (article-search, chat, generate-
-- listing, osv).
--
-- Idempotent — IF NOT EXISTS overalt.
-- ============================================================================

-- Guard: skip hvis tenant.ai_token_usage ikke findes endnu (PROD har det ikke
-- pr. 2026-05-16 — migration 030 var aldrig kørt i PROD).
DO $$
BEGIN
  IF to_regclass('tenant.ai_token_usage') IS NULL THEN
    RAISE NOTICE 'tenant.ai_token_usage findes ikke — skipper migration 138';
    RETURN;
  END IF;

  -- Tilføj route-kolonne (NULL tilladt for legacy rows uden tracking-helper)
  EXECUTE 'ALTER TABLE tenant.ai_token_usage ADD COLUMN IF NOT EXISTS route TEXT';

  EXECUTE 'COMMENT ON COLUMN tenant.ai_token_usage.route IS ''BIZZ-1594: AI-route der genererede forbruget (fx ai.chat, ai.article-search). NULL for legacy rows fra før recordAiUsage-helper.''';

  -- Index for per-route rapportering
  EXECUTE 'CREATE INDEX IF NOT EXISTS ai_token_usage_route_month_idx ON tenant.ai_token_usage (tenant_id, route, created_at DESC) WHERE route IS NOT NULL';
END $$;
