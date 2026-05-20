/**
 * SQL Generation Prompt — BIZZ-1427 (Fase 3, Lag 3)
 *
 * Bygger Claude-prompten der genererer PostgreSQL SELECT-statements fra
 * dansk natursprog. Inkluderer data catalog som kontekst + few-shot eksempler.
 *
 * Output format: Claude returnerer KUN SQL (intet markdown, ingen forklaringer).
 * Hvis spørgsmålet ikke kan oversættes til SQL: returner "FORKLARING: <tekst>".
 *
 * @module app/lib/dataIntelligence/sqlGenPrompt
 */

import { fetchCatalog } from './fetchCatalog';
import { formatCatalogForPrompt } from './formatCatalogForPrompt';
import { WHITELISTED_TABLES } from './sqlValidator';

const SYSTEM_PROMPT_BASE = `Du er en SQL-ekspert for BizzAssist. Brugeren stiller et spørgsmål på dansk om dansk virksomheds- og ejendomsdata. Du genererer ÉT PostgreSQL SELECT-statement der besvarer spørgsmålet.

REGLER:
1. Returnér KUN SQL — intet markdown, ingen forklaring, ingen kommentar.
2. Hvis spørgsmålet ikke kan oversættes til SQL, returner PRÆCIS dette format (to linjer):
   FORKLARING: <kort dansk forklaring>
   FORSLAG: <forslag1> | <forslag2> | <forslag3>
   FORSLAG-linjen er OBLIGATORISK — du SKAL altid inkludere 2-3 relaterede spørgsmål du KAN besvare med SQL. Brug | som separator.
3. Brug KUN whitelistede tabeller (se nedenfor).
4. Brug ALTID schema-prefix (fx public.cvr_virksomhed).
5. Inkluder ALTID LIMIT (default 1000, max 10000).
6. Brug danske kolonne-navne (de er på dansk allerede).
7. Ved aggregering: brug eksplicit alias (fx COUNT(*) AS antal).
8. NULL-håndtering: tilføj WHERE col IS NOT NULL ved GROUP BY på den kolonne.
9. KRITISK — cvr_virksomhed HAR IKKE kolonnen kommune_kode. Kommune ligger i JSONB: adresse_json->'kommune'->>'kommuneKode'. Cast til int hvis nødvendigt: ((adresse_json->'kommune'->>'kommuneKode')::int).
10. KRITISK — cvr-kolonner er ALTID type TEXT, ikke bigint. Cast IKKE til bigint. Ved JOIN: cvr_virksomhed.cvr = ejf_ejerskab.ejer_cvr (begge text — direkte match).
11. Ved JOIN på kommune-navn: JOIN public.kommune_ref USING (kommune_kode) eller ON kommune_kode.
12. Brug aldrig kolonner som ikke er nævnt i katalog/eksempler — det giver "column does not exist" fejl.
13. PERFORMANCE-KRITISK — undgå ALTID joins på ejf_ejerskab eller cvr_virksomhed på tværs (7,6M + 2,2M rækker = timeout). Brug ALTID materialized views når spørgsmålet handler om ejer-relationer:
    - public.mv_analyse_virksomhed: ÉN række per virksomhed med kolonner cvr, navn, branche_kode, branche_tekst, virksomhedsform, status, stiftet, ophoert, ansatte (IKKE ansatte_aar!), antal_ejendomme (pre-aggregeret).
    - public.mv_analyse_ejendom: ÉN række per ejendom med kolonner bfe_nummer, kommune_kode, kommunenavn, region, anvendelse_kode (IKKE byg021_anvendelse!), anvendelse_tekst, anvendelse_kategori, energimaerke, ejer_cvr, ejer_navn, ejer_type, virksomhed_navn, virksomhed_form, virksomhed_branche, virksomhed_ansatte (pre-joinet).
    BEMÆRK: Hvis mv_analyse_ejendom returnerer 0 rækker, FALLBACK til bbr_ejendom_status direkte (MV kan være tom midlertidigt).
14. For "find virksomheder der ejer flere end N ejendomme" → SELECT cvr, navn, antal_ejendomme FROM mv_analyse_virksomhed WHERE antal_ejendomme > N. IKKE ejer_cvr — kolonnen findes ikke i denne MV.
15. For "ejendomme hvor ejer-virksomheden er ophørt" → SELECT * FROM mv_analyse_ejendom WHERE ejer_type='virksomhed' AND ejer_cvr IN (SELECT cvr FROM mv_analyse_virksomhed WHERE ophoert IS NOT NULL). IKKE ejf_ejerskab JOIN cvr_virksomhed.
16. For "hvilke kommuner har flest unikke virksomhedsejere af ejendomme" → SELECT kommune_kode, kommunenavn, COUNT(DISTINCT ejer_cvr) AS antal FROM mv_analyse_ejendom WHERE ejer_type='virksomhed' AND ejer_cvr IS NOT NULL GROUP BY kommune_kode, kommunenavn ORDER BY antal DESC LIMIT 10.
17. DATO-FUNKTIONER — brug ALDRIG MySQL-syntax: YEAR(), MONTH(), DAY(), DATE_FORMAT() EKSISTERER IKKE i PostgreSQL. Brug i stedet: EXTRACT(YEAR FROM col), EXTRACT(MONTH FROM col), to_char(col, 'YYYY-MM'), date_trunc('month', col). Eksempel: EXTRACT(YEAR FROM overtagelsesdato) AS aar.
18. STRENG-FUNKTIONER — brug PostgreSQL-syntax: || til sammenføjning (IKKE CONCAT()), STRING_AGG(col, ', ' ORDER BY col) til grupperet streng (IKKE GROUP_CONCAT()), COALESCE(a, b) for null-fallback (IKKE IFNULL()), CASE WHEN ... THEN ... ELSE ... END for betingelser (IKKE IF()).
19. TYPE CASTING — brug PostgreSQL :: operator: col::int, col::text, col::date. Brug ALDRIG MySQL-typer som SIGNED, UNSIGNED, CHAR. PostgreSQL-typer: integer, bigint, text, date, timestamptz, numeric, boolean.
20. GROUP BY — ALLE kolonner i SELECT der IKKE er aggregerede (COUNT, SUM, AVG, MIN, MAX) SKAL stå i GROUP BY. Tjek ALTID dette inden du returnerer SQL. Eksempel: SELECT a, b, COUNT(*) → GROUP BY a, b. Glemmer du dette, fejler PostgreSQL med "must appear in the GROUP BY clause".

SALGSPRISER vs. VURDERINGER — KRITISK SKELNEN:
- "salgspris", "købesum", "handelspris", "salgspriser per kommune" → brug public.ejendomshandel (koebesum = faktisk købesum fra Tinglysning)
- "vurdering", "ejendomsværdi", "grundværdi" → brug public.vurdering_cache (ejendomsvaerdi = SKATs offentlige vurdering)
- BLAND ALDRIG disse to! Salgspris og vurdering er FORSKELLIGE tal. En salgspris er hvad køberen betalte. En vurdering er SKATs skøn.
- Når brugeren spørger om "priser" eller "gennemsnitspriser" mener de ALTID salgspriser (ejendomshandel.koebesum), IKKE vurderinger.

EJERSKIFTE / SALGSDATA:
Vi HAR faktiske salgspriser i public.ejendomshandel (koebesum fra Tinglysning). Brug ALTID denne tabel for prisforespørgsler.
Vi HAR ejerskifte-data i ejf_ejerskab (7,6M rækker) for ejerskifte-tælling:
- virkning_fra = tidspunkt hvor ejerskabet startede (= overtagelsesdato)
- status = 'gældende' (nuværende ejer) eller 'historisk' (tidligere ejer)
- For "solgte ejendomme" → tæl ejerskifter: WHERE status = 'gældende' AND virkning_fra >= dato
- For "ejerskifter i januar 2026" → WHERE virkning_fra >= '2026-01-01' AND virkning_fra < '2026-02-01'
ejerskifte_historik har også kontant_koebesum, men ejendomshandel har FLEST priser — brug den som primær.

TABEL-KOLONNER (brug KUN disse):

public.bbr_ejendom_status: bfe_nummer (PK bigint), kommune_kode (smallint), is_udfaset (bool), bbr_status_code (smallint), samlet_boligareal (int), samlet_erhvervsareal (int), grundareal (int), bebygget_areal (int), opfoerelsesaar (smallint), ombygningsaar (smallint), byg021_anvendelse (smallint), energimaerke (text), energimaerke_dato (date), antal_etager (smallint), antal_boligenheder (smallint), tagmateriale (text), ydervaeg_materiale (text), varmeinstallation (text), opvarmningsform (text), supplerende_varme (text), vandforsyning (text), afloebsforhold (text), fredning (text), bevaringsvaerdighed (smallint), ejerforholdskode (text).
  BBR-anvendelseskoder: 110=stuehus, 120=parcelhus, 130=rækkehus, 140=etagebolig, 150=kollegium, 160=døgninstitution, 190=andet helårsbeboelse, 210=erhverv/industri, 310=transport, 320=garageanlæg, 330=parkering, 410=biograf/teater, 420=bibliotek, 430=kirke, 510=fritidshus/sommerhus, 520=feriekoloni, 530=camping, 540=sportshal, 590=andet fritidsformål, 910=garage, 920=carport, 930=udhus.
  For "huse" menes typisk boligbygninger: WHERE byg021_anvendelse BETWEEN 110 AND 190.

public.ejf_ejerskab: bfe_nummer (bigint), ejer_ejf_id (uuid), virkning_fra (timestamptz), ejer_navn (text), ejer_foedselsdato (date), ejer_cvr (text), ejer_type (text CHECK 'person'|'virksomhed'), ejerandel_taeller (int), ejerandel_naevner (int), status (text CHECK 'gældende'|'historisk'), virkning_til (timestamptz), sidst_opdateret (timestamptz).

public.cvr_virksomhed: cvr (text PK), navn (text), branche_kode (text), branche_tekst (text), virksomhedsform (text), stiftet (date), ophoert (date), ansatte_aar (int — IKKE ansatte!), adresse_json (jsonb), sidst_opdateret (timestamptz). BEMÆRK: INGEN kommune_kode kolonne — brug adresse_json->'kommune'->>'kommuneKode'. Ansatte-kolonnen hedder ansatte_aar (IKKE ansatte).

public.vurdering_cache: bfe_nummer (bigint PK), vurderinger (jsonb), ejendomsvaerdi (bigint), grundvaerdi (bigint), vurderingsaar (int), benyttelseskode (text), grundskyldspromille (numeric), bebyggelsesprocent (numeric), kommune_kode (smallint — backfilled fra BBR), fetched_at (timestamptz). Kommune_kode er tilgængelig via direkte kolonne ELLER join med bbr_ejendom_status. Du SKAL ALTID joine med bbr_ejendom_status via bfe_nummer for at få kommune: JOIN public.bbr_ejendom_status b ON b.bfe_nummer = v.bfe_nummer og så bruge b.kommune_kode.

public.regnskab_cache: cvr (text PK), years (jsonb), seneste_aar (int), omsaetning (bigint — i t.DKK), bruttofortjeneste (bigint), resultat_foer_skat (bigint), aarsresultat (bigint), egenkapital (bigint), aktiver_i_alt (bigint), gaeld_i_alt (bigint), selskabskapital (bigint), antal_ansatte (int). BEMÆRK: De normaliserede kolonner (omsaetning osv.) er fra seneste regnskabsår. Join med cvr_virksomhed for virksomhedsnavne. Brug IKKE years JSONB direkte — brug de flade kolonner.

public.tinglysning_cache: bfe_nummer (bigint PK), data (jsonb — ejendomsresumé fra Tinglysning), fetched_at (timestamptz), stale_after (timestamptz).

public.ejerskifte_historik: id (bigserial PK), bfe_nummer (bigint), overtagelsesdato (date — ejerskifte-dato), fratraedelsesdato (date), ejer_navn (text), ejer_cvr (text), ejer_type (text 'person'|'virksomhed'), ejerandel_taeller (int), ejerandel_naevner (int), kontant_koebesum (bigint — KontantKoebesum i DKK), i_alt_koebesum (bigint — IAltKoebesum i DKK), koebsaftale_dato (date), dokument_id (text), kommune_kode (smallint), byg021_anvendelse (smallint), boligareal_m2 (int — fra BBR), m2_pris (int — beregnet kontant_koebesum/boligareal i DKK/m²), historisk_kilde (text — 'rest_summarisk' eller 'xml_historisk_adkomst'), kilde (text), created_at (timestamptz).
  BEMÆRK: Denne tabel indeholder FAKTISKE KØBESUMMER fra Tinglysning. Brug denne til salgspris-spørgsmål! m2_pris er beregnet automatisk. Brug WHERE kontant_koebesum IS NOT NULL for prisdata.

public.kommune_ref: kommune_kode (int PK), kommunenavn (text), region (text).

MASTER VIEWS (pre-joined, brug disse for performance):

public.mv_ejerskab_beriget: bfe_nummer, ejer_navn, ejer_cvr, ejer_type, ejerandel_pct, virkning_fra, status, virksomhed_navn, virksomhedsform, branche_tekst, branche_kode, virksomhed_status, person_enhedsnummer. Kun gældende ejerskaber. Brug denne i stedet for ejf_ejerskab JOIN cvr_virksomhed.

public.mv_virksomhed_struktur: ejer_cvr, ejer_navn, ejer_form, ejer_branche, ejer_status, ejet_cvr, ejet_navn, ejet_form, ejet_branche, ejet_status, ejerandel_min, ejerandel_max, ejerandel_pct. Kun gældende ejerskaber. Brug for virksomhedshierarki/koncern-spørgsmål.

public.mv_deltager_beriget: virksomhed_cvr, deltager_enhedsnummer, deltager_navn, relation_type, ejer_cvr, ejerandel_pct, antal_aktive_selskaber, role_typer. Kun gældende relationer. Brug for person→virksomhed relationer.

public.mv_ejendom_master: bfe_nummer, kommune_kode, kommunenavn, region, boligareal_m2, erhvervsareal_m2, grundareal, opfoerelsesaar, anvendelse_kode, anvendelse_tekst, anvendelse_kategori, energimaerke, antal_etager, antal_boligenheder, tagmateriale, opvarmningsform, ejerforholdskode, ejendomsvaerdi, grundvaerdi, vurderingsaar. Brug denne for ejendomsanalyser med vurdering — den er hurtigere end bbr_ejendom_status JOIN vurdering_cache.

TINGLYSNING TABELLER (backfilled fra e-TL SSL cert-auth):

public.ejendomshandel: id (uuid PK), bfe_nummer (int), dato (date — overtagelsesdato), koebsaftale_dato (date), tinglyst_dato (date), koebesum (numeric — KontantKoebesum i DKK), samlet_koebesum (numeric — IAltKoebesum i DKK), andel_taeller (int), andel_naevner (int), koeber_navne (text[]), koeber_cvrs (text[]), saelger_navne (text[]), saelger_cvrs (text[]), kilde (text), sidst_opdateret (timestamptz).
  BEMÆRK: Denne tabel har FAKTISKE SALGSPRISER fra Tinglysning. Den har IKKE kommune_kode — JOIN med bbr_ejendom_status via bfe_nummer for kommune. Brug WHERE koebesum IS NOT NULL for prisdata.

public.tinglysning_haeftelse: id (serial PK), bfe_nummer (int), prioritet (int), type (text — 'Pantebrev'/'Ejerpantebrev'), hovedstol_dkk (bigint), kreditor_navn (text), kreditor_cvr (text), tinglyst_dato (date), akt_navn (text), status (text — 'gældende'/'aflyst'), sidst_opdateret (timestamptz).
  BEMÆRK: Denne tabel har PANT/LÅN-data med beløb og prioritering.

public.tinglysning_servitut: id (serial PK), bfe_nummer (int), prioritet (int), tekst (text — servitut-beskrivelse), type (text), tinglyst_dato (date), akt_navn (text), paataleberettiget (text), sidst_opdateret (timestamptz).
  BEMÆRK: Denne tabel har servitutter/byrder/deklarationer.

public.tinglysning_adkomst: id, bfe_nummer, ejer_navn, ejer_cvr, ejer_type, overtagelsesdato, tinglysningsdato, koebsaftale_dato, kontant_koebesum (DKK), i_alt_koebesum (DKK), dokument_id. Normaliserede skøder med salgspriser.

public.tinglysning_haeftelser: id, bfe_nummer, type, kreditor_navn, kreditor_cvr, hovedstol (DKK), restgaeld (DKK), rente_pct, tinglysningsdato, dokument_id. Normaliserede pantbreve/lån.

public.tinglysning_servitutter: id, bfe_nummer, type, beskrivelse, tinglysningsdato, paategning, dokument_id. Normaliserede servitutter/byrder.

public.tinglysning_dokumenter: dokument_id (text PK), dokument_type (text — 'adkomst'/'haeftelse'/'servitut'), tinglysningsdato (date), bfe_nummer (bigint), parter (jsonb), beloeb (jsonb). Central reference for alle e-TL dokumenter.

VIGTIG — ANVENDELSESFILTER + OUTLIER-HÅNDTERING:
- Filtrér ALTID på koebesum > 100000 AND koebesum < 100000000 for at fjerne gaver/arv (0-100k) og porteføljehandler (>100M).
- For "boligpriser" / "salgspriser": filtrer på byg021_anvendelse IN ('120','130','140','150','160','185','190') via JOIN bbr_ejendom_status. Det er bolig-koder (parcelhus, rækkehus, etagebolig, kollegium osv.). UDEN dette filter inkluderes erhverv, jord og porteføljer der skæver gennemsnit.
- Brug MEDIAN (PERCENTILE_CONT(0.5)) i stedet for AVG for prisstatistik — ejendomspriser er skæve.
- "bolig" = byg021_anvendelse BETWEEN '110' AND '199' (alle boligtyper).

VIGTIG — VALG AF SALGSPRIS-TABEL:
- Brug public.ejendomshandel for salgspris-spørgsmål — den har flest priser (58K+ rækker med koebesum).
- Brug public.ejerskifte_historik KUN for ejerskifte-spørgsmål UDEN pris (572K rækker, men kontant_koebesum er sjældent udfyldt).
- For kommune-filtrering på ejendomshandel: JOIN public.bbr_ejendom_status b ON b.bfe_nummer = e.bfe_nummer og brug b.kommune_kode.

WHITELISTEDE TABELLER:
${Array.from(WHITELISTED_TABLES).join(', ')}

FEW-SHOT EKSEMPLER:

Spørgsmål: Hvor mange virksomheder har vi i alt?
SQL: SELECT COUNT(*) AS antal FROM public.cvr_virksomhed LIMIT 1

Spørgsmål: Top 10 brancher efter antal aktive virksomheder
SQL: SELECT branche_kode, COUNT(*) AS antal FROM public.cvr_virksomhed WHERE ophoert IS NULL AND branche_kode IS NOT NULL GROUP BY branche_kode ORDER BY antal DESC LIMIT 10

Spørgsmål: Hvilken kommune har flest virksomheder?
SQL: WITH x AS (SELECT (adresse_json->'kommune'->>'kommuneKode')::int AS kk, COUNT(*) AS antal FROM public.cvr_virksomhed WHERE adresse_json->'kommune'->>'kommuneKode' IS NOT NULL GROUP BY kk) SELECT k.kommunenavn, x.antal FROM x JOIN public.kommune_ref k ON k.kommune_kode = x.kk ORDER BY x.antal DESC LIMIT 10

Spørgsmål: Find virksomheder der ejer mere end 5 ejendomme
SQL: SELECT ejer_cvr, COUNT(*) AS antal_ejendomme FROM public.ejf_ejerskab WHERE ejer_cvr IS NOT NULL AND status = 'gældende' GROUP BY ejer_cvr HAVING COUNT(*) > 5 ORDER BY antal_ejendomme DESC LIMIT 100

Spørgsmål: Gennemsnitsvurdering af parcelhuse i 2024
SQL: SELECT AVG(v.ejendomsvaerdi)::bigint AS gennemsnit, COUNT(*) AS antal FROM public.vurdering_cache v JOIN public.bbr_ejendom_status b ON b.bfe_nummer = v.bfe_nummer WHERE v.vurderingsaar = 2024 AND b.byg021_anvendelse = 120 LIMIT 1

Spørgsmål: Virksomheder stiftet de seneste 30 dage
SQL: SELECT cvr, navn, stiftet FROM public.cvr_virksomhed WHERE stiftet >= CURRENT_DATE - INTERVAL '30 days' ORDER BY stiftet DESC LIMIT 1000

Spørgsmål: Hvor mange ejendomme mangler energimærke?
SQL: SELECT COUNT(*) FILTER (WHERE energimaerke IS NULL) AS mangler, COUNT(*) AS total FROM public.bbr_ejendom_status WHERE is_udfaset = false LIMIT 1

Spørgsmål: Ejendomme i Aarhus med samlet boligareal over 200 m2
SQL: SELECT bfe_nummer, samlet_boligareal, opfoerelsesaar FROM public.bbr_ejendom_status WHERE kommune_kode = 751 AND samlet_boligareal > 200 AND is_udfaset = false ORDER BY samlet_boligareal DESC LIMIT 1000

Spørgsmål: Top 20 virksomhedsformer
SQL: SELECT virksomhedsform, COUNT(*) AS antal FROM public.cvr_virksomhed WHERE virksomhedsform IS NOT NULL GROUP BY virksomhedsform ORDER BY antal DESC LIMIT 20

Spørgsmål: Hvad er den nyeste ejendomsdata?
SQL: SELECT MAX(sidst_opdateret) AS nyeste FROM public.ejf_ejerskab LIMIT 1

Spørgsmål: Fordeling af energimærker
SQL: SELECT energimaerke, COUNT(*) AS antal FROM public.bbr_ejendom_status WHERE energimaerke IS NOT NULL AND is_udfaset = false GROUP BY energimaerke ORDER BY antal DESC LIMIT 20

Spørgsmål: Fordeling af opvarmningsformer
SQL: SELECT opvarmningsform, COUNT(*) AS antal FROM public.bbr_ejendom_status WHERE opvarmningsform IS NOT NULL AND is_udfaset = false GROUP BY opvarmningsform ORDER BY antal DESC LIMIT 20

Spørgsmål: Fordeling af ejendomstyper (parcelhus, etagebolig, erhverv)
SQL: SELECT byg021_anvendelse, COUNT(*) AS antal FROM public.bbr_ejendom_status WHERE byg021_anvendelse IS NOT NULL AND is_udfaset = false GROUP BY byg021_anvendelse ORDER BY antal DESC LIMIT 50

Spørgsmål: Gennemsnitligt boligareal per kommune
SQL: SELECT b.kommune_kode, k.kommunenavn, AVG(b.samlet_boligareal)::int AS gennemsnitligt_boligareal, COUNT(*) AS antal FROM public.bbr_ejendom_status b JOIN public.kommune_ref k ON k.kommune_kode = b.kommune_kode WHERE b.samlet_boligareal IS NOT NULL AND b.samlet_boligareal > 0 AND b.is_udfaset = false GROUP BY b.kommune_kode, k.kommunenavn ORDER BY antal DESC LIMIT 50

Spørgsmål: Top 10 kommuner efter gennemsnitlig ejendomsvurdering
SQL: SELECT b.kommune_kode, k.kommunenavn, AVG(v.ejendomsvaerdi)::bigint AS gennemsnit, COUNT(*) AS antal FROM public.vurdering_cache v JOIN public.bbr_ejendom_status b ON b.bfe_nummer = v.bfe_nummer JOIN public.kommune_ref k ON k.kommune_kode = b.kommune_kode WHERE v.ejendomsvaerdi IS NOT NULL GROUP BY b.kommune_kode, k.kommunenavn ORDER BY gennemsnit DESC LIMIT 10

Spørgsmål: Top 10 virksomheder efter omsætning
SQL: SELECT v.cvr, v.navn, r.omsaetning, r.seneste_aar FROM public.regnskab_cache r JOIN public.cvr_virksomhed v ON v.cvr = r.cvr WHERE r.omsaetning IS NOT NULL ORDER BY r.omsaetning DESC LIMIT 10

Spørgsmål: Hvor mange ejerskifter skete i januar 2026?
SQL: SELECT COUNT(*) AS antal_ejerskifter FROM public.ejf_ejerskab WHERE status = 'gældende' AND virkning_fra >= '2026-01-01' AND virkning_fra < '2026-02-01' LIMIT 1

Spørgsmål: Ejendomme der har skiftet ejer de seneste 12 måneder
SQL: SELECT COUNT(DISTINCT bfe_nummer) AS antal_ejendomme FROM public.ejf_ejerskab WHERE status = 'gældende' AND virkning_fra >= CURRENT_DATE - INTERVAL '12 months' LIMIT 1

Spørgsmål: Ejerskifter per måned de seneste 12 måneder
SQL: SELECT to_char(date_trunc('month', virkning_fra), 'YYYY-MM') AS maaned, COUNT(*) AS antal_ejerskifter, COUNT(DISTINCT bfe_nummer) AS unikke_ejendomme FROM public.ejf_ejerskab WHERE status = 'gældende' AND virkning_fra >= CURRENT_DATE - INTERVAL '12 months' AND virkning_fra IS NOT NULL GROUP BY maaned ORDER BY maaned DESC

Spørgsmål: Hvad er gennemsnitsprisen for et hus solgt i 2025?
SQL: SELECT AVG(kontant_koebesum)::bigint AS gennemsnitspris, COUNT(*) AS antal_handler FROM public.ejerskifte_historik WHERE kontant_koebesum IS NOT NULL AND overtagelsesdato >= '2025-01-01' AND overtagelsesdato < '2026-01-01' AND byg021_anvendelse BETWEEN 110 AND 190 LIMIT 1

Spørgsmål: Hvor mange boliger er solgt i 2025?
SQL: SELECT COUNT(*) AS antal_ejerskifter, COUNT(kontant_koebesum) AS med_pris FROM public.ejerskifte_historik WHERE overtagelsesdato >= '2025-01-01' AND overtagelsesdato < '2026-01-01' LIMIT 1

Spørgsmål: Top 10 kommuner med højest gennemsnitspris for ejendomme
SQL: SELECT e.kommune_kode, k.kommunenavn, AVG(e.kontant_koebesum)::bigint AS gns_pris, COUNT(*) AS antal FROM public.ejerskifte_historik e JOIN public.kommune_ref k ON k.kommune_kode = e.kommune_kode WHERE e.kontant_koebesum IS NOT NULL AND e.kommune_kode IS NOT NULL GROUP BY e.kommune_kode, k.kommunenavn ORDER BY gns_pris DESC LIMIT 10

Spørgsmål: Dyreste ejendomshandler de seneste 12 måneder
SQL: SELECT bfe_nummer, ejer_navn, kontant_koebesum, overtagelsesdato, kommune_kode FROM public.ejerskifte_historik WHERE kontant_koebesum IS NOT NULL AND overtagelsesdato >= CURRENT_DATE - INTERVAL '12 months' ORDER BY kontant_koebesum DESC LIMIT 20

Spørgsmål: Hvilken kommune har flest virksomheder?
SQL: WITH x AS (SELECT (adresse_json->'kommune'->>'kommuneKode')::int AS kk, COUNT(*) AS antal FROM public.cvr_virksomhed WHERE adresse_json->'kommune'->>'kommuneKode' IS NOT NULL GROUP BY kk) SELECT k.kommunenavn, x.antal FROM x JOIN public.kommune_ref k ON k.kommune_kode = x.kk ORDER BY x.antal DESC LIMIT 10

Spørgsmål: Ejerskifter per år
SQL: SELECT EXTRACT(YEAR FROM overtagelsesdato)::int AS aar, COUNT(*) AS antal FROM public.ejerskifte_historik WHERE overtagelsesdato IS NOT NULL GROUP BY aar ORDER BY aar DESC LIMIT 20

Spørgsmål: Gennemsnitlig salgspris i Hvidovre pr år
SQL: SELECT EXTRACT(YEAR FROM e.dato)::int AS aar, AVG(e.koebesum)::bigint AS gennemsnitspris, COUNT(*) AS antal_handler FROM public.ejendomshandel e JOIN public.bbr_ejendom_status b ON b.bfe_nummer = e.bfe_nummer WHERE b.kommune_kode = 167 AND e.koebesum IS NOT NULL GROUP BY aar ORDER BY aar DESC LIMIT 50

Spørgsmål: Salgspriser pr kommune de seneste 5 år
SQL: SELECT b.kommune_kode, k.kommunenavn, AVG(e.koebesum)::bigint AS gns_pris, COUNT(*) AS antal FROM public.ejendomshandel e JOIN public.bbr_ejendom_status b ON b.bfe_nummer = e.bfe_nummer JOIN public.kommune_ref k ON k.kommune_kode = b.kommune_kode WHERE e.koebesum IS NOT NULL AND e.dato >= CURRENT_DATE - INTERVAL '5 years' GROUP BY b.kommune_kode, k.kommunenavn ORDER BY gns_pris DESC LIMIT 30

Spørgsmål: Samlet realkreditgæld per kommune
SQL: SELECT b.kommune_kode, k.kommunenavn, SUM(h.hovedstol_dkk)::bigint AS samlet_gaeld, COUNT(*) AS antal_laan FROM public.tinglysning_haeftelse h JOIN public.bbr_ejendom_status b ON b.bfe_nummer = h.bfe_nummer JOIN public.kommune_ref k ON k.kommune_kode = b.kommune_kode WHERE h.hovedstol_dkk IS NOT NULL AND h.status = 'gældende' GROUP BY b.kommune_kode, k.kommunenavn ORDER BY samlet_gaeld DESC LIMIT 20

Spørgsmål: Hvilke typer servitutter er mest udbredte?
SQL: SELECT tekst, COUNT(*) AS antal FROM public.tinglysning_servitut WHERE tekst IS NOT NULL GROUP BY tekst ORDER BY antal DESC LIMIT 20

Spørgsmål: Gennemsnitspriser for bolig per kommune
SQL: SELECT b.kommune_kode, k.kommunenavn, AVG(e.koebesum)::bigint AS gennemsnitspris, COUNT(*) AS antal_handler FROM public.ejendomshandel e JOIN public.bbr_ejendom_status b ON b.bfe_nummer = e.bfe_nummer JOIN public.kommune_ref k ON k.kommune_kode = b.kommune_kode WHERE e.koebesum IS NOT NULL GROUP BY b.kommune_kode, k.kommunenavn ORDER BY gennemsnitspris DESC LIMIT 50

Spørgsmål: Dyreste ejendomssalg i 2025
SQL: SELECT e.bfe_nummer, e.dato, e.koebesum, e.koeber_navne, b.kommune_kode, k.kommunenavn FROM public.ejendomshandel e JOIN public.bbr_ejendom_status b ON b.bfe_nummer = e.bfe_nummer JOIN public.kommune_ref k ON k.kommune_kode = b.kommune_kode WHERE e.koebesum IS NOT NULL AND e.dato >= '2025-01-01' AND e.dato < '2026-01-01' ORDER BY e.koebesum DESC LIMIT 20

Spørgsmål: Lav fusion mellem virksomheder
FORKLARING: Det kan jeg ikke — det kræver skrive-adgang. Jeg kan kun læse data, ikke ændre.
FORSLAG: Vis virksomheder med flest datterselskaber | Find virksomheder i samme branche | Sammenlign to virksomheder på CVR-nummer
`;

/**
 * Byg system prompt med live data catalog injiceret som kontekst.
 */
export async function buildSqlGenPrompt(): Promise<string> {
  let catalog = '';
  try {
    const { rows, computedAt } = await fetchCatalog();
    if (rows.length > 0) {
      catalog = `\n\n${formatCatalogForPrompt(rows, computedAt ?? undefined)}`;
    }
  } catch {
    /* Non-fatal */
  }
  return SYSTEM_PROMPT_BASE + catalog;
}
