-- ============================================================
-- Migration 097: Unified analyse datamodel
-- BIZZ-1265: Materialized views + lookup-tabeller for pivot-analyse
-- og AI query builder. Giver brugervenlige dimensioner (by, kommune,
-- region, m², ejer, branche) uden at brugeren kender DB-struktur.
--
-- Kræver: 069 (bbr_ejendom_status), 076 (berigelse), 082 (cache_dar/vur)
-- Refresh: Nightly via /api/cron/refresh-materialized-views
-- ============================================================

-- ── 1. Lookup-tabeller (referencedata) ────────────────────────────────

-- Kommune-reference: 98 kommuner med kode, navn og region
CREATE TABLE IF NOT EXISTS public.kommune_ref (
  kommune_kode  SMALLINT PRIMARY KEY,
  kommunenavn   TEXT NOT NULL,
  region        TEXT NOT NULL
);

COMMENT ON TABLE public.kommune_ref IS
  'BIZZ-1265: Statisk kommune-lookup (98 kommuner) med region. Kilde: DAWA.';

-- Seed kommuner (de 5 regioner + alle 98 kommuner)
INSERT INTO public.kommune_ref (kommune_kode, kommunenavn, region) VALUES
  (101, 'København', 'Hovedstaden'),
  (147, 'Frederiksberg', 'Hovedstaden'),
  (151, 'Ballerup', 'Hovedstaden'),
  (153, 'Brøndby', 'Hovedstaden'),
  (155, 'Dragør', 'Hovedstaden'),
  (157, 'Gentofte', 'Hovedstaden'),
  (159, 'Gladsaxe', 'Hovedstaden'),
  (161, 'Glostrup', 'Hovedstaden'),
  (163, 'Herlev', 'Hovedstaden'),
  (165, 'Albertslund', 'Hovedstaden'),
  (167, 'Hvidovre', 'Hovedstaden'),
  (169, 'Høje-Taastrup', 'Hovedstaden'),
  (173, 'Lyngby-Taarbæk', 'Hovedstaden'),
  (175, 'Rødovre', 'Hovedstaden'),
  (183, 'Ishøj', 'Hovedstaden'),
  (185, 'Tårnby', 'Hovedstaden'),
  (187, 'Vallensbæk', 'Hovedstaden'),
  (190, 'Furesø', 'Hovedstaden'),
  (201, 'Allerød', 'Hovedstaden'),
  (210, 'Fredensborg', 'Hovedstaden'),
  (217, 'Helsingør', 'Hovedstaden'),
  (219, 'Hillerød', 'Hovedstaden'),
  (223, 'Hørsholm', 'Hovedstaden'),
  (230, 'Rudersdal', 'Hovedstaden'),
  (240, 'Egedal', 'Hovedstaden'),
  (250, 'Frederikssund', 'Hovedstaden'),
  (260, 'Halsnæs', 'Hovedstaden'),
  (270, 'Gribskov', 'Hovedstaden'),
  (400, 'Bornholm', 'Hovedstaden'),
  (306, 'Odsherred', 'Sjælland'),
  (316, 'Holbæk', 'Sjælland'),
  (320, 'Faxe', 'Sjælland'),
  (326, 'Kalundborg', 'Sjælland'),
  (329, 'Ringsted', 'Sjælland'),
  (330, 'Slagelse', 'Sjælland'),
  (336, 'Stevns', 'Sjælland'),
  (340, 'Sorø', 'Sjælland'),
  (350, 'Lejre', 'Sjælland'),
  (360, 'Lolland', 'Sjælland'),
  (370, 'Næstved', 'Sjælland'),
  (376, 'Guldborgsund', 'Sjælland'),
  (390, 'Vordingborg', 'Sjælland'),
  (253, 'Greve', 'Sjælland'),
  (259, 'Køge', 'Sjælland'),
  (265, 'Roskilde', 'Sjælland'),
  (269, 'Solrød', 'Sjælland'),
  (410, 'Middelfart', 'Syddanmark'),
  (420, 'Assens', 'Syddanmark'),
  (430, 'Faaborg-Midtfyn', 'Syddanmark'),
  (440, 'Kerteminde', 'Syddanmark'),
  (450, 'Nyborg', 'Syddanmark'),
  (461, 'Odense', 'Syddanmark'),
  (479, 'Svendborg', 'Syddanmark'),
  (480, 'Nordfyns', 'Syddanmark'),
  (482, 'Langeland', 'Syddanmark'),
  (492, 'Ærø', 'Syddanmark'),
  (510, 'Haderslev', 'Syddanmark'),
  (530, 'Billund', 'Syddanmark'),
  (540, 'Sønderborg', 'Syddanmark'),
  (550, 'Tønder', 'Syddanmark'),
  (561, 'Esbjerg', 'Syddanmark'),
  (563, 'Fanø', 'Syddanmark'),
  (573, 'Varde', 'Syddanmark'),
  (575, 'Vejen', 'Syddanmark'),
  (580, 'Aabenraa', 'Syddanmark'),
  (607, 'Fredericia', 'Syddanmark'),
  (615, 'Horsens', 'Midtjylland'),
  (621, 'Kolding', 'Syddanmark'),
  (630, 'Vejle', 'Syddanmark'),
  (657, 'Herning', 'Midtjylland'),
  (661, 'Holstebro', 'Midtjylland'),
  (665, 'Lemvig', 'Midtjylland'),
  (671, 'Struer', 'Midtjylland'),
  (706, 'Syddjurs', 'Midtjylland'),
  (707, 'Norddjurs', 'Midtjylland'),
  (710, 'Favrskov', 'Midtjylland'),
  (727, 'Odder', 'Midtjylland'),
  (730, 'Randers', 'Midtjylland'),
  (740, 'Silkeborg', 'Midtjylland'),
  (741, 'Samsø', 'Midtjylland'),
  (746, 'Skanderborg', 'Midtjylland'),
  (751, 'Aarhus', 'Midtjylland'),
  (756, 'Ikast-Brande', 'Midtjylland'),
  (760, 'Ringkøbing-Skjern', 'Midtjylland'),
  (766, 'Hedensted', 'Midtjylland'),
  (773, 'Morsø', 'Nordjylland'),
  (779, 'Skive', 'Midtjylland'),
  (787, 'Thisted', 'Nordjylland'),
  (791, 'Viborg', 'Midtjylland'),
  (810, 'Brønderslev', 'Nordjylland'),
  (813, 'Frederikshavn', 'Nordjylland'),
  (820, 'Vesthimmerlands', 'Nordjylland'),
  (825, 'Læsø', 'Nordjylland'),
  (840, 'Rebild', 'Nordjylland'),
  (846, 'Mariagerfjord', 'Nordjylland'),
  (849, 'Jammerbugt', 'Nordjylland'),
  (851, 'Aalborg', 'Nordjylland'),
  (860, 'Hjørring', 'Nordjylland')
ON CONFLICT (kommune_kode) DO NOTHING;

-- BBR anvendelseskode-reference (de mest gængse bolig/erhverv koder)
CREATE TABLE IF NOT EXISTS public.bbr_anvendelse_ref (
  anvendelse_kode  SMALLINT PRIMARY KEY,
  anvendelse_tekst TEXT NOT NULL,
  kategori         TEXT NOT NULL  -- 'bolig', 'erhverv', 'institution', 'andet'
);

COMMENT ON TABLE public.bbr_anvendelse_ref IS
  'BIZZ-1265: BBR byg021 anvendelseskode-lookup. Kilde: BBR kodeoversættelse.';

INSERT INTO public.bbr_anvendelse_ref (anvendelse_kode, anvendelse_tekst, kategori) VALUES
  (110, 'Stuehus til landbrugsejendom', 'bolig'),
  (120, 'Fritliggende enfamilieshus (parcelhus)', 'bolig'),
  (130, 'Række-, kæde- eller dobbelthus', 'bolig'),
  (140, 'Etageboligbebyggelse (lejlighed)', 'bolig'),
  (150, 'Kollegium', 'bolig'),
  (160, 'Døgninstitution (plejehjem mv.)', 'institution'),
  (185, 'Anneks i tilknytning til helårsbolig', 'bolig'),
  (190, 'Anden helårsbolig', 'bolig'),
  (210, 'Erhvervsmæssig produktion (industri/håndværk)', 'erhverv'),
  (220, 'Erhvervsmæssig produktion (industri) med integreret bolig', 'erhverv'),
  (230, 'El-, gas-, vand- eller varmeværk', 'erhverv'),
  (290, 'Anden til produktion, transport', 'erhverv'),
  (310, 'Transport- og garageanlæg', 'erhverv'),
  (320, 'Kontor, handel og lager', 'erhverv'),
  (330, 'Kontor, handel og lager med integreret bolig', 'erhverv'),
  (390, 'Anden til handel, transport, kontor', 'erhverv'),
  (410, 'Fritidsbolig (sommerhus)', 'bolig'),
  (420, 'Fritidsbolig med integreret erhverv', 'bolig'),
  (430, 'Kolonihavehus', 'bolig'),
  (510, 'Kulturel virksomhed, undervisning', 'institution'),
  (520, 'Sygehus, sundhedscenter', 'institution'),
  (530, 'Daginstitution', 'institution'),
  (540, 'Servicefunktion for samfærdsel', 'erhverv'),
  (585, 'Anden institution, herunder kaserne', 'institution'),
  (590, 'Anden institution', 'institution'),
  (910, 'Garage', 'andet'),
  (920, 'Carport', 'andet'),
  (930, 'Udhus', 'andet'),
  (940, 'Drivhus/overdækket areal', 'andet'),
  (950, 'Fritliggende overdækket areal', 'andet'),
  (960, 'Teknikbygning (forsyning)', 'andet'),
  (970, 'Tiloversbleven landbrugsbygning', 'andet'),
  (999, 'Ukendt bygning', 'andet')
ON CONFLICT (anvendelse_kode) DO NOTHING;

-- ── 2. Materialized view: Ejendomsperspektiv ──────────────────────────

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_analyse_ejendom AS
SELECT
  bbr.bfe_nummer,
  bbr.samlet_boligareal    AS boligareal_m2,
  bbr.opfoerelsesaar,
  bbr.energimaerke,
  bbr.byg021_anvendelse    AS anvendelse_kode,
  anv.anvendelse_tekst,
  anv.kategori             AS anvendelse_kategori,
  bbr.bbr_status_code,
  bbr.is_udfaset,
  bbr.kommune_kode,
  kr.kommunenavn,
  kr.region,
  -- Ejer (seneste gældende)
  ej.ejer_navn,
  ej.ejer_type,
  ej.ejer_cvr,
  CASE
    WHEN ej.ejerandel_naevner > 0
    THEN ROUND((ej.ejerandel_taeller::numeric / ej.ejerandel_naevner) * 100, 1)
    ELSE NULL
  END AS ejerandel_pct,
  -- Virksomhedsejer
  cv.navn                  AS virksomhed_navn,
  cv.branche_tekst         AS virksomhed_branche,
  cv.virksomhedsform       AS virksomhed_form,
  cv.ansatte_aar           AS virksomhed_ansatte
FROM public.bbr_ejendom_status bbr
LEFT JOIN public.kommune_ref kr
  ON kr.kommune_kode = bbr.kommune_kode
LEFT JOIN public.bbr_anvendelse_ref anv
  ON anv.anvendelse_kode = bbr.byg021_anvendelse
LEFT JOIN LATERAL (
  SELECT ejer_navn, ejer_type, ejer_cvr, ejerandel_taeller, ejerandel_naevner
  FROM public.ejf_ejerskab
  WHERE ejf_ejerskab.bfe_nummer = bbr.bfe_nummer
    AND status = 'gældende'
  ORDER BY virkning_fra DESC NULLS LAST
  LIMIT 1
) ej ON true
LEFT JOIN public.cvr_virksomhed cv
  ON cv.cvr = ej.ejer_cvr
WHERE bbr.is_udfaset = false
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_analyse_ejendom_bfe
  ON public.mv_analyse_ejendom (bfe_nummer);
CREATE INDEX IF NOT EXISTS idx_mv_analyse_ejendom_kommune
  ON public.mv_analyse_ejendom (kommune_kode);
CREATE INDEX IF NOT EXISTS idx_mv_analyse_ejendom_anvendelse
  ON public.mv_analyse_ejendom (anvendelse_kode);

COMMENT ON MATERIALIZED VIEW public.mv_analyse_ejendom IS
  'BIZZ-1265: Flad ejendomsanalyse-view. Joiner BBR + ejer + virksomhed + kommune + anvendelse. Refresh nightly.';

-- ── 3. Materialized view: Virksomhedsperspektiv ───────────────────────

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_analyse_virksomhed AS
SELECT
  cv.cvr,
  cv.navn,
  cv.branche_kode,
  cv.branche_tekst,
  cv.virksomhedsform,
  cv.status,
  cv.stiftet,
  cv.ophoert,
  cv.ansatte_aar AS ansatte,
  -- Antal ejede ejendomme
  COALESCE(ej_count.antal_ejendomme, 0) AS antal_ejendomme
FROM public.cvr_virksomhed cv
LEFT JOIN LATERAL (
  SELECT COUNT(DISTINCT bfe_nummer)::int AS antal_ejendomme
  FROM public.ejf_ejerskab
  WHERE ejf_ejerskab.ejer_cvr = cv.cvr
    AND status = 'gældende'
) ej_count ON true
WHERE cv.status IS NOT NULL
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_analyse_virksomhed_cvr
  ON public.mv_analyse_virksomhed (cvr);
CREATE INDEX IF NOT EXISTS idx_mv_analyse_virksomhed_branche
  ON public.mv_analyse_virksomhed (branche_kode);
CREATE INDEX IF NOT EXISTS idx_mv_analyse_virksomhed_form
  ON public.mv_analyse_virksomhed (virksomhedsform);

COMMENT ON MATERIALIZED VIEW public.mv_analyse_virksomhed IS
  'BIZZ-1265: Flad virksomhedsanalyse-view. CVR + ejede ejendomme count. Refresh nightly.';

-- ── 4. RLS (read-only for service role) ───────────────────────────────

-- Lookup-tabeller er offentlige (ingen PII)
ALTER TABLE public.kommune_ref ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_kommune_ref" ON public.kommune_ref
  FOR SELECT USING (true);

ALTER TABLE public.bbr_anvendelse_ref ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_bbr_anvendelse_ref" ON public.bbr_anvendelse_ref
  FOR SELECT USING (true);
