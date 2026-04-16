-- BIZZ-378: Enable RLS on regnskab_cache to prevent cross-tenant data leakage.
-- This table is a server-side cache of parsed XBRL financial data, keyed by CVR.
-- Only the service_role (admin client) should read/write; authenticated users must
-- go through the API routes which enforce tenant isolation.
--
-- Pattern: same as search_cache (migration 017) — deny all authenticated access.

ALTER TABLE regnskab_cache ENABLE ROW LEVEL SECURITY;

-- Block all authenticated access — service_role bypasses RLS by design.
CREATE POLICY "regnskab_cache_deny_all"
  ON regnskab_cache
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);
