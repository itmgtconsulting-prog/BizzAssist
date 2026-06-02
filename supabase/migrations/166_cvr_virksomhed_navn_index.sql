-- BIZZ-1961: btree index on cvr_virksomhed.navn for exact name lookups.
--
-- The virksomhedshandler radar (app/api/virksomhedshandler/kandidater/route.ts)
-- classifies each deltager as person or company by looking up the deltager name
-- in cvr_virksomhed (deltager_er_virksomhed + deltager_cvr) so company-deltagere
-- link to /dashboard/companies instead of the person page. cvr_deltager.enhedstype
-- is NULL in the cache, so the name match is the only available signal.
--
-- cvr_virksomhed only had GIN (tsvector / trgm) indexes on navn, which do not serve
-- exact `navn = ANY(array)` equality. Without a btree index that lookup falls back to
-- a hash join over ~2.1M rows (~7s for 50 names) and risks the 30s API timeout.
--
-- A plain btree on navn lets the ≤200 page names resolve via index probes (~ms).
--
-- NB: built non-concurrently here so it can run inside the standard migration
-- transaction. On the already-populated table in prod/test the Management API can
-- build it directly (~20s); for very large tables prefer a direct DB connection.
CREATE INDEX IF NOT EXISTS idx_cvr_virksomhed_navn
  ON public.cvr_virksomhed (navn);
