-- ============================================================
-- Migration 196: dataintel-skema + tabeller i PROD (schema-paritet)
-- BIZZ-2198/2196: PROD manglede HELE dataintel-skemaet (findes i test/dev).
-- Uden dataintel.analytics_knowledge kan AI knowledge-cachen ikke bygges i
-- prod (refresh-knowledge-cache + job-koeen fejler paa relation-does-not-exist).
-- Konsoliderer de idempotente migrationer 113/114/116. No-op i test/dev.
--
-- Fuld schema-paritet for de OEVRIGE 5 prod-manglende tabeller
-- (verified_links, support_chat_abuse, tinglysning_akt_extraction,
-- user_sessions, daekningsanalyse_saved) er en separat opgave (BIZZ-2196):
-- de gamle migrationer re-applier ikke rent pga. skema-drift (link_id m.fl.).
-- ============================================================

CREATE SCHEMA IF NOT EXISTS dataintel;

-- ─── fra 113_data_intelligence_catalog.sql ───
-- ============================================================
-- Migration 113: data_intelligence_catalog (BIZZ-1406)
-- ============================================================
-- Pre-beregnet metadata om whitelistede tabeller. Injiceres i AI
-- system prompt så Claude kender datasættets struktur, dækning
-- og typiske værdier uden at skulle slå op for hvert spørgsmål.
--
-- Schema 'dataintel' i stedet for 'analyse' fordi sidstnævnte er
-- et PostgreSQL nøgleord (alias for ANALYZE).
--
-- Refreshes natligt via /api/cron/refresh-data-catalog (BIZZ-1408).
-- Format-helper i app/lib/dataIntelligence/formatCatalogForPrompt.ts (BIZZ-1409).
-- ============================================================

CREATE SCHEMA IF NOT EXISTS dataintel;

CREATE TABLE IF NOT EXISTS dataintel.data_catalog (
  table_schema    text        NOT NULL,
  table_name      text        NOT NULL,
  -- Tom streng = række på tabel-niveau (row_count for hele tabellen).
  -- Ellers = kolonne-niveau metadata (null/distinct/top-values).
  column_name     text        NOT NULL DEFAULT '',
  data_type       text,
  row_count       bigint,
  null_count      bigint,
  distinct_count  bigint,
  -- Format: [{"value": "X", "count": N}, ...] — top 10 mest hyppige
  -- værdier. Ekskluderet for kolonner markeret pii_flag=true.
  top_values      jsonb,
  min_value       text,
  max_value       text,
  semantic_label  text,
  pii_flag        boolean     NOT NULL DEFAULT false,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_schema, table_name, column_name)
);

-- Index for fast filtering på en specifik tabel og for freshness-queries.
CREATE INDEX IF NOT EXISTS data_catalog_table_idx
  ON dataintel.data_catalog (table_schema, table_name);
CREATE INDEX IF NOT EXISTS data_catalog_computed_at_idx
  ON dataintel.data_catalog (computed_at DESC);

-- ─── RLS ────────────────────────────────────────────────────
-- Catalog er ikke tenant-scoped: metadata om vores datasæt er global.
-- Læsetilladelse for alle authenticated brugere; service_role har
-- fuld adgang via bypass.
ALTER TABLE dataintel.data_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS data_catalog_read_authenticated ON dataintel.data_catalog;
CREATE POLICY data_catalog_read_authenticated
  ON dataintel.data_catalog
  FOR SELECT
  TO authenticated
  USING (true);

-- Authenticated brugere skal kunne læse via PostgREST.
GRANT USAGE ON SCHEMA dataintel TO authenticated, anon, service_role;
GRANT SELECT ON dataintel.data_catalog TO authenticated;
GRANT ALL ON dataintel.data_catalog TO service_role;

-- ─── Kommentarer ───────────────────────────────────────────
COMMENT ON TABLE dataintel.data_catalog IS
  'BIZZ-1406: Metadata om whitelistede tabeller — injiceres i AI system prompt. Refreshes nightly.';
COMMENT ON COLUMN dataintel.data_catalog.column_name IS
  'Tom streng = række på tabel-niveau (row_count). Ellers kolonne-metadata.';
COMMENT ON COLUMN dataintel.data_catalog.top_values IS
  'JSONB array af top-10 hyppigste værdier. NULL hvis pii_flag=true.';
COMMENT ON COLUMN dataintel.data_catalog.pii_flag IS
  'True hvis kolonnen indeholder PII (navne, emails, cpr) — top_values genereres ikke.';

-- ─── fra 114_data_intelligence_knowledge.sql ───
-- ============================================================
-- Migration 114: data_intelligence_knowledge (BIZZ-1412)
-- ============================================================
-- Pre-beregnede aggregater for typiske spørgsmål.
-- Builders i app/lib/dataIntelligence/topics/* (BIZZ-1413..1418).
-- Refreshes natligt via /api/cron/refresh-knowledge-cache (BIZZ-1419).
-- ============================================================

CREATE TABLE IF NOT EXISTS dataintel.analytics_knowledge (
  id              uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  topic           text        NOT NULL,
  topic_label_da  text        NOT NULL,
  key             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  value           jsonb       NOT NULL,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  source_query    text
);

-- Unique constraint på (topic, key) for upsert.
-- jsonb-kolonner kan ikke direkte unique-indexeres; brug functional index.
CREATE UNIQUE INDEX IF NOT EXISTS analytics_knowledge_topic_key_idx
  ON dataintel.analytics_knowledge (topic, (key::text));

CREATE INDEX IF NOT EXISTS analytics_knowledge_topic_idx
  ON dataintel.analytics_knowledge (topic, computed_at DESC);

-- ─── RLS ────────────────────────────────────────────────────
ALTER TABLE dataintel.analytics_knowledge ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS analytics_knowledge_read_authenticated ON dataintel.analytics_knowledge;
CREATE POLICY analytics_knowledge_read_authenticated
  ON dataintel.analytics_knowledge
  FOR SELECT
  TO authenticated
  USING (true);

GRANT SELECT ON dataintel.analytics_knowledge TO authenticated;
GRANT ALL    ON dataintel.analytics_knowledge TO service_role;

COMMENT ON TABLE dataintel.analytics_knowledge IS
  'BIZZ-1412: Pre-beregnede aggregater for AI knowledge cache. Refreshes nightly.';
COMMENT ON COLUMN dataintel.analytics_knowledge.topic IS
  'Topic identifier: company_count_by_municipality, data_coverage_bbr, etc.';
COMMENT ON COLUMN dataintel.analytics_knowledge.key IS
  'JSONB key for at identificere en specifik fact (fx {kommunekode: 101}). Tom hvis global.';
COMMENT ON COLUMN dataintel.analytics_knowledge.value IS
  'JSONB value med pre-beregnet svar (fx {count: 142893, active: 118402}).';

-- ─── fra 116_data_intelligence_sql_audit.sql ───
-- ============================================================
-- Migration 116: ai_sql_audit table (BIZZ-1423)
-- ============================================================
-- Audit-log for hver AI-genereret SQL-query. Kritisk for ISO 27001 +
-- sporbarhed. 12 måneders retention (GDPR).
-- ============================================================

CREATE TABLE IF NOT EXISTS dataintel.ai_sql_audit (
  id              uuid        PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  tenant_id       uuid        NOT NULL,
  user_id         uuid        NOT NULL,
  user_prompt     text        NOT NULL,
  generated_sql   text        NOT NULL,
  ast_validated   boolean     NOT NULL DEFAULT false,
  executed        boolean     NOT NULL DEFAULT false,
  error           text,
  row_count       integer,
  duration_ms     integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_sql_audit_tenant_idx
  ON dataintel.ai_sql_audit (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_sql_audit_executed_idx
  ON dataintel.ai_sql_audit (executed, ast_validated, created_at DESC);

-- ─── RLS ────────────────────────────────────────────────────
-- Audit-log er tenant-scoped: brugere kan kun se egne queries.
-- service_role har fuld adgang (cron + admin views).
ALTER TABLE dataintel.ai_sql_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_sql_audit_own_tenant ON dataintel.ai_sql_audit;
CREATE POLICY ai_sql_audit_own_tenant
  ON dataintel.ai_sql_audit
  FOR SELECT
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tenant_id
      FROM public.tenant_memberships
      WHERE user_id = auth.uid()
    )
  );

GRANT SELECT ON dataintel.ai_sql_audit TO authenticated;
GRANT ALL    ON dataintel.ai_sql_audit TO service_role;

COMMENT ON TABLE dataintel.ai_sql_audit IS
  'BIZZ-1423: Audit-log for AI-genereret SQL. 12 mdr retention. ISO 27001 A.12.4.';

