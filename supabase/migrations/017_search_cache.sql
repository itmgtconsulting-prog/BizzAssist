-- 017_search_cache.sql
-- Brave Search result cache — reduces API usage by caching per-query results for 24h.
-- Stored in public schema (not tenant schema) since search results are not tenant-specific.

CREATE TABLE IF NOT EXISTS search_cache (
  query_hash  TEXT        PRIMARY KEY,
  results     JSONB       NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Index for TTL-based cleanup queries
CREATE INDEX IF NOT EXISTS idx_search_cache_created ON search_cache (created_at);

-- No RLS needed — access is via service role key from server-side routes only.
-- Service role bypasses RLS, and anon/authenticated roles should never reach this table.
ALTER TABLE search_cache ENABLE ROW LEVEL SECURITY;

-- Block all direct client access (service role bypasses this)
CREATE POLICY "no_direct_access" ON search_cache
  AS RESTRICTIVE
  FOR ALL
  USING (false);

COMMENT ON TABLE search_cache IS
  'Cache for Brave Search API results. TTL=24h enforced in application layer. '
  'Keyed by SHA-256 hash of (query + params). Reduces Brave API usage.';
