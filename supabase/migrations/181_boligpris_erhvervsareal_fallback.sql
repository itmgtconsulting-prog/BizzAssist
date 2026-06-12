-- BIZZ-2110: m²/m²-pris mangler på ~25% af "Seneste handler"-linjerne —
-- erhvervsejendomme (Detailhandel/Industri mv.) har intet boligareal, og
-- bbr_ejendom_status.samlet_erhvervsareal var 100% NULL (aldrig backfillet).
--
-- Denne migration genbygger mv_boligpris_handler så areal-kolonnen falder
-- tilbage på erhvervsareal når boligareal mangler:
--
--   samlet_boligareal := COALESCE(NULLIF(boligareal,0), NULLIF(erhvervsareal,0))
--
-- Kolonnenavnet beholdes (samlet_boligareal), så RPC'erne fra migration 180
-- (dynamisk SQL mod m.samlet_boligareal) og API-routen er uændrede — både
-- SELECT, areal_min/max-filtrene og m²-pris-beregningen bruger automatisk
-- fallback-arealet. Rækker hvor BBR reelt intet areal har, forbliver NULL
-- og viser fortsat "–" (ingen opfundne tal).
--
-- Datakilden backfilles af scripts/backfill-bbr-erhvervsareal.mjs
-- (BBR v2 4-trins pipeline; enh028ArealTilErhverv med byg040-fallback;
-- 0 = "hentet, intet i BBR"-sentinel). MV'en skal REFRESH'es efter backfill.

DROP MATERIALIZED VIEW IF EXISTS public.mv_boligpris_handler;
CREATE MATERIALIZED VIEW public.mv_boligpris_handler AS
SELECT
  h.bfe_nummer::int                        AS bfe_nummer,
  (h.overtagelsesdato)::date               AS overtagelsesdato,
  h.samlet_koebesum::bigint                AS samlet_koebesum,
  COALESCE(
    NULLIF(b.samlet_boligareal, 0),
    NULLIF(b.samlet_erhvervsareal, 0)
  )::int                                   AS samlet_boligareal,
  b.byg021_anvendelse::int                 AS byg021_anvendelse,
  b.opfoerelsesaar::int                    AS opfoerelsesaar,
  b.antal_etager::int                      AS antal_etager,
  b.antal_vaerelser::int                   AS antal_vaerelser,
  b.kommune_kode::int                      AS kommune_kode
FROM v_ejerskifte_handel h
JOIN bbr_ejendom_status b ON h.bfe_nummer = b.bfe_nummer
WHERE h.samlet_koebesum > 0
  AND h.overtagelsesdato IS NOT NULL
  AND b.kommune_kode IS NOT NULL;

-- Indeks som i migration 173/175 (dækker de typiske query-stier)
CREATE INDEX idx_mbh_kommune_type_dato
  ON public.mv_boligpris_handler (kommune_kode, byg021_anvendelse, overtagelsesdato DESC);
CREATE INDEX idx_mbh_type_dato
  ON public.mv_boligpris_handler (byg021_anvendelse, overtagelsesdato DESC);
CREATE INDEX idx_mbh_dato
  ON public.mv_boligpris_handler (overtagelsesdato DESC);

COMMENT ON COLUMN public.bbr_ejendom_status.samlet_erhvervsareal IS
  'BIZZ-2110: Sum af enh028ArealTilErhverv (fallback byg040) over aktive BBR-bygninger/enheder. Backfillet via scripts/backfill-bbr-erhvervsareal.mjs. 0 = hentet, intet i BBR.';
