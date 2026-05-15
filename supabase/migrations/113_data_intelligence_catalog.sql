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
