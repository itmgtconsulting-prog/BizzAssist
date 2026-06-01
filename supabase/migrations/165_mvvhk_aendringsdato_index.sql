-- BIZZ-1953: index on the radar sort key for mv_virksomhedshandel_kandidater
--
-- The virksomhedshandler radar (app/api/virksomhedshandler/kandidater/route.ts)
-- orders by COALESCE(gyldig_til, gyldig_fra) DESC NULLS LAST. The MV has grown to
-- ~1.25M rows; without an index on that expression the query falls back to a
-- Parallel Seq Scan + Sort of ~221k filtered rows and exceeds the 25s API timeout
-- (returns 502 'Ekstern API fejl'), so the radar is 100% down.
--
-- This expression index matches the ORDER BY exactly and lets Postgres return the
-- LIMIT 50 page via an index scan instead of a full sort.
--
-- NB: built non-concurrently here so it can run inside the standard migration
-- transaction. On an already-populated MV in prod/test, prefer applying via a
-- direct DB connection (the Supabase Management API gateway times out at ~120s and
-- cannot build an index of this size).
CREATE INDEX IF NOT EXISTS idx_mvvhk_aendringsdato
  ON public.mv_virksomhedshandel_kandidater (COALESCE(gyldig_til, gyldig_fra) DESC NULLS LAST);
