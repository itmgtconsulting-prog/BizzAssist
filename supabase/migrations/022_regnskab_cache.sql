-- ============================================================================
-- 022: Cache for parsede XBRL-regnskabsdata
-- Gemmer regnskabstal per CVR med tidsstempel fra ES (sidstOpdateret).
-- Undgår gentagen XBRL-parsing for samme virksomhed.
-- ============================================================================

CREATE TABLE IF NOT EXISTS regnskab_cache (
  cvr          TEXT        NOT NULL,
  years        JSONB       NOT NULL DEFAULT '[]',
  es_timestamp TEXT        NOT NULL DEFAULT '',
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cvr)
);

-- Index for hurtig opslag
CREATE INDEX IF NOT EXISTS idx_regnskab_cache_fetched ON regnskab_cache (fetched_at);

COMMENT ON TABLE regnskab_cache IS 'Cache for parsede XBRL-regnskabstal per CVR. Invalideres når ES-tidsstempel ændres.';
COMMENT ON COLUMN regnskab_cache.cvr IS '8-cifret CVR-nummer';
COMMENT ON COLUMN regnskab_cache.years IS 'Array af RegnskabsAar objekter (JSON)';
COMMENT ON COLUMN regnskab_cache.es_timestamp IS 'Seneste offentliggoerelsesTidspunkt fra ES — bruges til cache-invalidering';
COMMENT ON COLUMN regnskab_cache.fetched_at IS 'Tidspunkt for sidste XBRL-fetch';
