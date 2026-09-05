-- Migration 213: syntetisk unik-nøgle til mv_ejerskab_beriget + mv_boligpris_handler (BIZZ-2222)
--
-- De 2 MV'er har ægte dublet-rækker → ingen naturlig unik nøgle → kunne ikke få
-- unique index → REFRESH MATERIALIZED VIEW CONCURRENTLY var umuligt, så den
-- daglige refresh tog ACCESS EXCLUSIVE-lås (blokerede læsninger i morgen-vinduet).
--
-- Fix: tilføj en syntetisk unik nøgle (row_number()) i MV-definitionen + unique
-- index på den. refresh_materialized_view() proever ALLEREDE CONCURRENTLY foerst
-- (falder tilbage til regular ved fejl), saa den bruger nu automatisk
-- CONCURRENTLY → ingen lock.
--
-- Sikkert: ingen dependents (verificeret via pg_depend). Reversibelt: recreate
-- uden mv_row_id-kolonnen.
--
-- WITH NO DATA: DDL'en er oejeblikkelig (ingen populate) → intet Cloudflare-524
-- paa store MV'er, og MV'en droppes kun kortvarigt (findes straks igen, blot tom)
-- frem for at vaere vaek i minutter. Populate sker BAGEFTER via
-- SELECT public.refresh_materialized_view('<mv>') (koeres in-DB/pg_cron, taaler
-- lange runs; funktionen proever CONCURRENTLY, falder tilbage til regular paa den
-- foerste (u-populerede) refresh). Den daglige pg_cron-refresh holder dem friske
-- fremover — nu med CONCURRENTLY (ingen ACCESS EXCLUSIVE-laas) takket vaere den
-- unique index.

-- ── mv_ejerskab_beriget ──────────────────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS public.mv_ejerskab_beriget;
CREATE MATERIALIZED VIEW public.mv_ejerskab_beriget AS
SELECT sub.*, row_number() OVER () AS mv_row_id
FROM (
  SELECT e.bfe_nummer,
         e.ejer_navn,
         e.ejer_cvr,
         e.ejer_type,
         e.ejerandel_taeller,
         e.ejerandel_naevner,
         CASE
           WHEN e.ejerandel_naevner > 0
             THEN round(e.ejerandel_taeller::numeric / e.ejerandel_naevner::numeric * 100::numeric, 1)
           ELSE NULL::numeric
         END AS ejerandel_pct,
         e.virkning_fra,
         e.virkning_til,
         e.status,
         cv.navn AS virksomhed_navn,
         cv.virksomhedsform,
         cv.branche_tekst,
         cv.branche_kode,
         cv.status AS virksomhed_status,
         cd.enhedsnummer AS person_enhedsnummer
  FROM ejf_ejerskab e
    LEFT JOIN cvr_virksomhed cv ON cv.cvr = e.ejer_cvr
    LEFT JOIN cvr_deltager cd ON e.ejer_type = 'person'::text AND cd.navn = e.ejer_navn AND cd.is_aktiv = true
  WHERE e.status = 'gældende'::text
) sub
WITH NO DATA;
CREATE UNIQUE INDEX ux_mv_ejerskab_beriget_key ON public.mv_ejerskab_beriget (mv_row_id);
CREATE INDEX idx_mv_ejerskab_beriget_bfe ON public.mv_ejerskab_beriget USING btree (bfe_nummer);
CREATE INDEX idx_mv_ejerskab_beriget_cvr ON public.mv_ejerskab_beriget USING btree (ejer_cvr) WHERE (ejer_cvr IS NOT NULL);
CREATE INDEX idx_mv_ejerskab_beriget_person ON public.mv_ejerskab_beriget USING btree (person_enhedsnummer) WHERE (person_enhedsnummer IS NOT NULL);

-- ── mv_boligpris_handler ─────────────────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS public.mv_boligpris_handler;
CREATE MATERIALIZED VIEW public.mv_boligpris_handler AS
SELECT sub.*, row_number() OVER () AS mv_row_id
FROM (
  SELECT h.bfe_nummer::integer AS bfe_nummer,
         h.overtagelsesdato::date AS overtagelsesdato,
         h.samlet_koebesum,
         COALESCE(NULLIF(b.samlet_boligareal, 0), NULLIF(b.samlet_erhvervsareal, 0)) AS samlet_boligareal,
         b.byg021_anvendelse::integer AS byg021_anvendelse,
         b.opfoerelsesaar::integer AS opfoerelsesaar,
         b.antal_etager::integer AS antal_etager,
         b.antal_vaerelser,
         b.kommune_kode::integer AS kommune_kode
  FROM v_ejerskifte_handel h
    JOIN bbr_ejendom_status b ON h.bfe_nummer = b.bfe_nummer
  WHERE h.samlet_koebesum > 0 AND h.overtagelsesdato IS NOT NULL AND b.kommune_kode IS NOT NULL
) sub
WITH NO DATA;
CREATE UNIQUE INDEX ux_mv_boligpris_handler_key ON public.mv_boligpris_handler (mv_row_id);
CREATE INDEX idx_mbh_dato ON public.mv_boligpris_handler USING btree (overtagelsesdato DESC);
CREATE INDEX idx_mbh_kommune_type_dato ON public.mv_boligpris_handler USING btree (kommune_kode, byg021_anvendelse, overtagelsesdato DESC);
CREATE INDEX idx_mbh_type_dato ON public.mv_boligpris_handler USING btree (byg021_anvendelse, overtagelsesdato DESC);
