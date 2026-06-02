-- BIZZ-1976: Persistent watermark for inkrementel CVR delta-sync.
--
-- Problem: pull-cvr-deltager-aendringer brugte et FAST 5-dages rullende vindue
-- (now - 5d) i stedet for et gemt watermark. Ved cron-nedetid > 5 dage tabes
-- delta permanent (jf. BIZZ-1954/1975: DB stoppede 16. maj, live-CVR var ved
-- 30. maj — 14 dages tabt delta).
--
-- Løsning: gem sidste succesfulde watermark pr. sync-kilde og genoptag derfra.
-- Watermark baseres på CVR-feltet sidstIndlaest (hvornår posten kom ind i
-- distributions-feed'et) — IKKE sidstOpdateret. sidstIndlaest er monotont
-- stigende ift. vores forbrug af feed'et og fanger også genudgivelser/
-- korrektioner hvor sidstOpdateret ikke flytter sig (verificeret: poster med
-- sidstIndlaest=2026-05-30 men sidstOpdateret=2019-01-15).
--
-- Retention: permanent driftsdata (ingen PII) — én række pr. sync-kilde.

CREATE TABLE IF NOT EXISTS public.sync_state (
  -- Kilde-identifikator, fx 'cvr_deltager'. Én række pr. inkrementel sync.
  source          TEXT PRIMARY KEY,
  -- Sidste succesfulde watermark (MAX sidstIndlaest hentet i sidste kørsel).
  -- Næste kørsel genoptager fra denne værdi (minus safety-overlap).
  last_watermark  TIMESTAMPTZ,
  -- Hvornår sidste kørsel afsluttede + hvor mange poster den hentede.
  last_run_at     TIMESTAMPTZ,
  last_run_count  INTEGER,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sync_state IS
  'BIZZ-1976: persistent watermark pr. inkrementel sync-kilde (genoptag-fra-punkt). Drift-metadata, ingen PII.';

-- Index på cvr_deltager.sidst_indlaest:
--  1) reconciliation-check (count poster i [from,to]-vindue mod CVR ES)
--  2) hurtig MAX(sidst_indlaest) ved watermark-fremskrivning
CREATE INDEX IF NOT EXISTS cvr_deltager_sidst_indlaest_idx
  ON public.cvr_deltager (sidst_indlaest DESC);
