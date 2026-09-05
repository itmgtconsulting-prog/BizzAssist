-- Migration 214: daekkende index (cvr) INCLUDE (navn) paa cvr_virksomhed (BIZZ-2228)
--
-- Fund (prod perf-review 2026-09-05): SELECT cvr,navn ... WHERE cvr > $1 ORDER BY cvr
-- (sitemap-keyset + de mange .select('cvr, navn') single-row-opslag) tog gns. 206 ms.
-- EXPLAIN ANALYZE viste 479 tilfaeldige heap-reads pr. 1000 raekker: primaernoeglen
-- daekker kun 'cvr', saa 'navn' krver et heap-fetch pr. raekke -> spredt disk-I/O.
--
-- BEMAERK: ticketens praemis om "17 GB index-bloat" var forkert. cvr_virksomhed er
-- 22 GB total, men 15.7 GB af det er TOAST (adresse_json/ansatte_json m.fl.), heap er
-- 5.3 GB og ALLE indexes tilsammen kun 658 MB (14k dead tuples, autovacuum'et samme
-- dag). Der er INGEN index-bloat -> REINDEX ville vaere en no-op og er udeladt.
--
-- Fix: additivt daekkende index. Goer (cvr, navn)-opslag index-only (ingen heap-fetch)
-- -> 206 ms falder mod ~1 ms. Non-partial (ikke WHERE navn IS NOT NULL) saa BAADE
-- keyset-scan OG single-row cvr=$1-opslag kan bruge det index-only.
--
-- Sikkert: CONCURRENTLY (ingen laas), rent additivt, reversibelt (DROP INDEX).
-- Anslaaet stoerrelse: ~100-150 MB paa 2.25M raekker.

CREATE INDEX CONCURRENTLY IF NOT EXISTS cvr_virksomhed_cvr_navn_covering_idx
  ON public.cvr_virksomhed USING btree (cvr) INCLUDE (navn);
