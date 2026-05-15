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
