import https from 'node:https';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', 'BizzAssist', '.env.local') });

const { JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY } = process.env;
const auth = Buffer.from(JIRA_EMAIL + ':' + JIRA_API_TOKEN).toString('base64');

function createTicket(fields) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ fields });
    const req = https.request({
      hostname: JIRA_HOST.replace('https://', ''),
      path: '/rest/api/3/issue',
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error('HTTP ' + res.statusCode + ': ' + data));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function desc(lines) {
  return {
    type: 'doc',
    version: 1,
    content: lines.map(line => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [{ type: 'text', text: ' ' }]
    }))
  };
}

async function main() {
  // ═══════════════════════════════════════════════
  // EPIC
  // ═══════════════════════════════════════════════
  console.log('Creating epic...');
  const epic = await createTicket({
    project: { key: JIRA_PROJECT_KEY },
    summary: 'Data Linking & Master Views — normaliser og link alle datakilder',
    issuetype: { id: '10001' },
    description: desc([
      'Mål: Normaliser, link og pre-join alle datakilder i BizzAssist så data kan krydses på tværs af ejendomme, virksomheder, ejerskab, vurdering, tinglysning og adresser.',
      '',
      'Nuværende problemer:',
      '• diagram/expand laver 15-30 separate DB queries per bruger-klik',
      '• vurdering_cache mangler kommune_kode (kan ikke aggregeres geografisk)',
      '• cache_dar (824K adresser) er ikke linket til bbr_ejendom_status',
      '• regnskab_cache er JSONB — kan ikke aggregeres via PostgREST',
      '• bbr_ejendom_status mangler kommune_kode for 500K ejendomme',
      '• Tinglysningsdata (adkomst, hæftelser, servitutter) gemmes ikke lokalt',
      '',
      'Faser:',
      'Fase 1 — Berig eksisterende tabeller (backfill + normalisering)',
      'Fase 2 — Pre-joined master views (MV med nightly refresh)',
      'Fase 3 — Opdater forbrugere (API routes, AI prompt, diagrams)',
      'Fase 4 — Tinglysning lokalt (allerede i BIZZ-1455)',
      '',
      'Gevinster:',
      '• diagram/expand: 15-30 queries → 3-5 queries (80% reduktion)',
      '• ejendomme-by-owner: eliminerer N+1 pattern',
      '• AI query builder: kan besvare kryds-spørgsmål (vurdering × kommune, ejerskifte × pris)',
      '• ejendom_master view: ét API-kald giver BBR + adresse + vurdering + ejer + virksomhed',
      '• Porteføljeanalyse: samlet pant, LTV, ejerskabskæder, m²-pris'
    ])
  });
  console.log('✅ Epic:', epic.key);

  const stories = [
    // ═══════════════════════════════════════════════
    // FASE 1: BERIG EKSISTERENDE TABELLER
    // ═══════════════════════════════════════════════
    {
      summary: 'DBA: Backfill kommune_kode i bbr_ejendom_status via DAWA (500K manglende)',
      type: '10004',
      lines: [
        'Problem:',
        'bbr_ejendom_status har 2.566.956 rækker, men kun 2.070.145 har kommune_kode (496.811 mangler). Disse er ejendomme i BFE-range under 700.000 som ikke har fået beriget kommune-data. mv_analyse_ejendom, AI queries og vurdering_cache afhænger alle af kommune_kode.',
        '',
        'Løsning:',
        'Opret scripts/backfill-bbr-kommune.mjs:',
        '1. Find alle bfe_nummer WHERE kommune_kode IS NULL',
        '2. For hvert BFE: kald DAWA /bfe/{bfe} endpoint for at hente kommunekode',
        '3. Batch UPDATE bbr_ejendom_status SET kommune_kode = X WHERE bfe_nummer = Y',
        '4. Rate limit: max 50 concurrent DAWA-kald, 100ms delay',
        '5. Resumable: skip BFE med allerede udfyldt kommune_kode',
        '6. Progress log til stdout + fejl-log til fil',
        '',
        'Alternativ: Brug DAR GraphQL til batch-opslag på adgangsadresse_id → kommunekode (hurtigere end DAWA REST per BFE).',
        '',
        'Berørte forbrugere efter fix:',
        '• mv_analyse_ejendom — 500K flere rækker med kommune_kode',
        '• AI query builder — "huse i X kommune" virker for alle ejendomme',
        '• vurdering_cache.kommune_kode backfill (afhænger af denne)',
        '',
        'Estimat: 2-3 timer (script) + 4-8 timer (kørsel afhængig af rate limits)',
        'Kilde-pattern: Se scripts/backfill-bbr-cache.mjs'
      ]
    },
    {
      summary: 'DBA: Link cache_dar adresser til bbr_ejendom_status via adgangsadresse_id',
      type: '10004',
      lines: [
        'Problem:',
        'cache_dar har 824K adresser med postnummer, vejnavn, kommunekode. bbr_ejendom_status har adgangsadresse_id. Men der er ingen FK eller index der kobler dem effektivt. Geografiske analyser (fx "ejendomme på X vej") kræver live DAWA-kald.',
        '',
        'Løsning:',
        '1. Migration: Tilføj index på bbr_ejendom_status(adgangsadresse_id) hvis mangler',
        '2. Migration: Tilføj index på cache_dar(adgangsadresse_id) eller (id) afhængig af PK',
        '3. Verificér at BFE-numre i cache_dar matcher bbr_ejendom_status',
        '4. Tilføj postnummer + vejnavn kolonner til bbr_ejendom_status (backfill fra cache_dar)',
        '5. Alternativt: Lad mv_ejendom_master håndtere join (Fase 2)',
        '',
        'Berørte forbrugere:',
        '• Adresse-autocomplete (app/lib/bbrEjendomStatus.ts) — allerede bruger adgangsadresse_id',
        '• AI chat tool dawa_adresse_detaljer — kunne slå BBR-data op direkte',
        '• SEO-sider /ejendom/[slug]/[bfe] — adresse-resolution',
        '',
        'Afhængighed: Kræver at cache_dar er populeret (824K rows i prod)',
        'Estimat: 3-4 timer'
      ]
    },
    {
      summary: 'DBA: Normaliser regnskab_cache JSONB til flade kolonner for AI queries',
      type: '10004',
      lines: [
        'Problem:',
        'regnskab_cache.years er JSONB array med årsregnskaber. PostgREST (og AI query builder) kan ikke aggregere JSONB — "top 10 virksomheder efter omsætning" fejler. Kun 143 rækker, men vigtig for virksomhedsanalyse.',
        '',
        'Løsning:',
        'Migration: Tilføj normaliserede kolonner til regnskab_cache:',
        '• seneste_aar (integer) — seneste regnskabsår',
        '• omsaetning (bigint) — seneste årsresultat.omsaetning',
        '• bruttofortjeneste (bigint)',
        '• aarets_resultat (bigint)',
        '• egenkapital (bigint)',
        '• aktiver_i_alt (bigint)',
        '• ansatte (integer)',
        '• soliditetsgrad (numeric)',
        '• afkastningsgrad (numeric)',
        '• likviditetsgrad (numeric)',
        '',
        'Backfill fra years->0 (seneste regnskab):',
        'UPDATE regnskab_cache SET omsaetning = (years->0->\'resultat\'->>\'omsaetning\')::bigint, ...',
        '',
        'Opdater analyseQueryWhitelist.ts med nye kolonner.',
        'Opdater buildSystemPrompt() med regnskabs-eksempler.',
        '',
        'Berørte forbrugere:',
        '• AI query builder — "top 10 efter omsætning" virker',
        '• AI chat — kan svare på "hvad er X\'s omsætning?"',
        '• Analyse-dashboard — regnskabsdata tilgængelig for pivot',
        '',
        'Estimat: 2-3 timer'
      ]
    },
    {
      summary: 'DBA: Backfill vurdering_cache.kommune_kode fra beriget bbr_ejendom_status',
      type: '10004',
      lines: [
        'Problem:',
        'vurdering_cache (15K) har kommune_kode kolonne (tilføjet BIZZ-1450, migration 107), men alle er NULL fordi bbr_ejendom_status mangler kommune_kode for de relevante BFE-numre (range 200.000-215.000).',
        '',
        'Afhængighed: Kræver at "Backfill kommune_kode i bbr_ejendom_status via DAWA" er færdig først.',
        '',
        'Løsning:',
        '1. Kør UPDATE vurdering_cache v SET kommune_kode = b.kommune_kode FROM bbr_ejendom_status b WHERE v.bfe_nummer = b.bfe_nummer AND v.kommune_kode IS NULL AND b.kommune_kode IS NOT NULL',
        '2. Verificér dækning: SELECT count(*), count(kommune_kode) FROM vurdering_cache',
        '3. Tilføj backfill-logik til scripts/backfill-vur-cache.mjs',
        '',
        'Berørte forbrugere:',
        '• AI query builder — "gennemsnitsvurdering per kommune" virker',
        '• mv_ejendom_master (Fase 2) — vurdering linket til geografi',
        '',
        'Estimat: 1 time (efter afhængighed er klar)'
      ]
    },

    // ═══════════════════════════════════════════════
    // FASE 2: PRE-JOINED MASTER VIEWS
    // ═══════════════════════════════════════════════
    {
      summary: 'DBA: Opret mv_ejerskab_beriget — ejf_ejerskab + cvr_virksomhed + cvr_deltager',
      type: '10004',
      lines: [
        'Formål:',
        'Eliminér N+1 query-pattern i diagram/expand og ejendomme-by-owner. I dag: 1 ejf_ejerskab query + N separate cvr_virksomhed lookups per co-owner. Med MV: 1 query returnerer alt.',
        '',
        'Definition:',
        'CREATE MATERIALIZED VIEW mv_ejerskab_beriget AS',
        'SELECT',
        '  ej.bfe_nummer,',
        '  ej.ejer_navn,',
        '  ej.ejer_cvr,',
        '  ej.ejer_type,',
        '  ej.ejerandel_taeller,',
        '  ej.ejerandel_naevner,',
        '  ej.status,',
        '  ej.virkning_fra,',
        '  -- CVR-beriget (virksomhedsejere)',
        '  cv.navn AS virksomhed_navn,',
        '  cv.virksomhedsform,',
        '  cv.branche_tekst,',
        '  cv.status AS virksomhed_status,',
        '  cv.ophoert AS virksomhed_ophoert,',
        '  cv.ansatte_aar AS virksomhed_ansatte,',
        '  -- Person-beriget (personejere)',
        '  cd.enhedsnummer AS person_enhedsnummer',
        'FROM ejf_ejerskab ej',
        'LEFT JOIN cvr_virksomhed cv ON cv.cvr = ej.ejer_cvr',
        'LEFT JOIN cvr_deltager cd ON cd.navn = ej.ejer_navn AND ej.ejer_type IN (\'person\', \'Personligt ejet\')',
        'WHERE ej.status = \'gældende\';',
        '',
        'Indexes: (bfe_nummer), (ejer_cvr), (person_enhedsnummer)',
        'Refresh: Nightly via cron (tilføj til VIEWS array i refresh-materialized-views)',
        'Refresh whitelist: Tilføj til refresh_materialized_view() RPC',
        '',
        'Forbrugere der skal opdateres (Fase 3):',
        '• app/api/diagram/expand/route.ts — linje 78-149, 542-597',
        '• app/api/ejendomme-by-owner/route.ts — linje 860-970',
        '• app/api/ejerskab/route.ts — linje 340-403',
        '',
        'Performance-gevinst: diagram/expand reduceres fra 10-15 → 2-3 queries for ejerskabs-del.',
        'Estimat: 3-4 timer'
      ]
    },
    {
      summary: 'DBA: Opret mv_virksomhed_struktur — cvr_virksomhed_ejerskab + cvr_virksomhed begge sider',
      type: '10004',
      lines: [
        'Formål:',
        'Eliminér N+1 pattern i diagram/expand for virksomhedshierarki. I dag: 1 ejerskab-query + N cvr_virksomhed lookups for parent + child navne. Med MV: 1 query returnerer fuld hierarki.',
        '',
        'Definition:',
        'CREATE MATERIALIZED VIEW mv_virksomhed_struktur AS',
        'SELECT',
        '  rel.ejer_cvr,',
        '  ejer.navn AS ejer_navn,',
        '  ejer.virksomhedsform AS ejer_form,',
        '  ejer.branche_tekst AS ejer_branche,',
        '  ejer.status AS ejer_status,',
        '  rel.ejet_cvr,',
        '  ejet.navn AS ejet_navn,',
        '  ejet.virksomhedsform AS ejet_form,',
        '  ejet.branche_tekst AS ejet_branche,',
        '  ejet.status AS ejet_status,',
        '  rel.ejerandel_min,',
        '  rel.ejerandel_max,',
        '  rel.gyldig_fra,',
        '  rel.gyldig_til',
        'FROM cvr_virksomhed_ejerskab rel',
        'LEFT JOIN cvr_virksomhed ejer ON ejer.cvr = rel.ejer_cvr',
        'LEFT JOIN cvr_virksomhed ejet ON ejet.cvr = rel.ejet_cvr',
        'WHERE rel.gyldig_til IS NULL;',
        '',
        'Indexes: (ejer_cvr), (ejet_cvr)',
        'Refresh: Nightly',
        '',
        'Forbrugere der skal opdateres (Fase 3):',
        '• app/api/diagram/expand/route.ts — linje 257-322 (opad), 350-397 (nedad), 478-527 (2nd-degree)',
        '',
        'Performance-gevinst: diagram/expand reduceres fra 7-12 → 2 queries for virksomhedshierarki.',
        'Estimat: 2-3 timer'
      ]
    },
    {
      summary: 'DBA: Opret mv_deltager_beriget — cvr_deltagerrelation + cvr_deltager i én view',
      type: '10004',
      lines: [
        'Formål:',
        'Eliminér person-name-lookup pattern i diagram/expand. I dag: 1 deltagerrelation query + N cvr_deltager lookups for person-navne. Med MV: 1 query returnerer alt.',
        '',
        'Definition:',
        'CREATE MATERIALIZED VIEW mv_deltager_beriget AS',
        'SELECT',
        '  dr.virksomhed_cvr,',
        '  dr.deltager_enhedsnummer,',
        '  cd.navn AS deltager_navn,',
        '  dr.type AS relation_type,',
        '  dr.ejerandel_pct,',
        '  dr.gyldig_fra,',
        '  dr.gyldig_til',
        'FROM cvr_deltagerrelation dr',
        'LEFT JOIN cvr_deltager cd ON cd.enhedsnummer = dr.deltager_enhedsnummer',
        'WHERE dr.gyldig_til IS NULL;',
        '',
        'Indexes: (virksomhed_cvr), (deltager_enhedsnummer)',
        'Refresh: Nightly',
        '',
        'Forbrugere der skal opdateres (Fase 3):',
        '• app/api/diagram/expand/route.ts — linje 405-470 (person-ejere), 609-631 (expand count), 705-750',
        '• app/api/person/netvaerk/route.ts — person-netværk',
        '',
        'Performance-gevinst: 2-5 queries → 1 query per person-node expansion.',
        'Estimat: 2-3 timer'
      ]
    },
    {
      summary: 'DBA: Opret mv_ejendom_master — BBR + DAR + VUR + EJF + CVR i én flad tabel',
      type: '10004',
      lines: [
        'Formål:',
        'Ultimativ ejendoms-view der samler alt tilgængeligt data i én flad tabel. Erstatter mv_analyse_ejendom med en rigere version og muliggør kryds-analyser.',
        '',
        'Definition:',
        'CREATE MATERIALIZED VIEW mv_ejendom_master AS',
        'SELECT',
        '  -- BBR',
        '  bbr.bfe_nummer,',
        '  bbr.kommune_kode,',
        '  bbr.samlet_boligareal AS boligareal_m2,',
        '  bbr.opfoerelsesaar,',
        '  bbr.energimaerke,',
        '  bbr.byg021_anvendelse AS anvendelse_kode,',
        '  anv.anvendelse_tekst,',
        '  anv.kategori AS anvendelse_kategori,',
        '  -- Geografi',
        '  kr.kommunenavn,',
        '  kr.region,',
        '  -- Vurdering',
        '  vur.ejendomsvaerdi,',
        '  vur.grundvaerdi,',
        '  vur.vurderingsaar,',
        '  -- Ejer (seneste gældende)',
        '  ej.ejer_navn,',
        '  ej.ejer_cvr,',
        '  ej.ejer_type,',
        '  ej.ejerandel_taeller,',
        '  ej.ejerandel_naevner,',
        '  ej.virkning_fra AS ejer_fra,',
        '  -- Virksomhedsejer',
        '  cv.navn AS virksomhed_navn,',
        '  cv.branche_tekst AS virksomhed_branche,',
        '  cv.virksomhedsform AS virksomhed_form,',
        '  cv.ansatte_aar AS virksomhed_ansatte,',
        '  -- Beregnet',
        '  CASE WHEN bbr.samlet_boligareal > 0 AND vur.ejendomsvaerdi > 0',
        '    THEN ROUND(vur.ejendomsvaerdi::numeric / bbr.samlet_boligareal)',
        '    ELSE NULL END AS vurdering_pr_m2',
        'FROM bbr_ejendom_status bbr',
        'LEFT JOIN kommune_ref kr ON kr.kommune_kode = bbr.kommune_kode',
        'LEFT JOIN bbr_anvendelse_ref anv ON anv.anvendelse_kode = bbr.byg021_anvendelse',
        'LEFT JOIN vurdering_cache vur ON vur.bfe_nummer = bbr.bfe_nummer',
        'LEFT JOIN LATERAL (',
        '  SELECT ejer_navn, ejer_cvr, ejer_type, ejerandel_taeller, ejerandel_naevner, virkning_fra',
        '  FROM ejf_ejerskab WHERE bfe_nummer = bbr.bfe_nummer AND status = \'gældende\'',
        '  ORDER BY virkning_fra DESC NULLS LAST LIMIT 1',
        ') ej ON true',
        'LEFT JOIN cvr_virksomhed cv ON cv.cvr = ej.ejer_cvr',
        'WHERE bbr.is_udfaset = false;',
        '',
        'Indexes: (bfe_nummer) UNIQUE, (kommune_kode), (anvendelse_kode), (ejer_cvr), (vurderingsaar)',
        'Refresh: Nightly (efter mv_analyse_ejendom i cron-schedule)',
        '',
        'BEMÆRK: Denne view er en udvidelse af eksisterende mv_analyse_ejendom. mv_analyse_ejendom beholdes for backward-compat. mv_ejendom_master tilføjer vurdering + vurdering_pr_m2.',
        '',
        'Forbrugere:',
        '• AI query builder (analyseQueryWhitelist.ts) — tilføj til whitelist',
        '• Analyse-dashboard — erstatter multiple API-kald',
        '• AI chat tools — hent_bbr_data + hent_vurdering + hent_ejerskab i ét kald',
        '• Data Intelligence topics (BIZZ-1405) — krydsanalyser',
        '',
        'Estimat: 4-5 timer (inkl. performance-test på 2.5M rækker)'
      ]
    },

    // ═══════════════════════════════════════════════
    // FASE 3: OPDATER FORBRUGERE
    // ═══════════════════════════════════════════════
    {
      summary: 'Backend: Opdater diagram/expand til at bruge mv_ejerskab_beriget + mv_virksomhed_struktur',
      type: '10004',
      lines: [
        'Formål:',
        'Reducér 15-30 queries per diagram-expansion til 3-5 ved at bruge pre-joined MVs.',
        '',
        'Fil: app/api/diagram/expand/route.ts',
        '',
        'Ændring 1 — Ejerskab (linje 78-149):',
        'FØR: 1 ejf_ejerskab query + N cvr_virksomhed lookups',
        'EFTER: 1 mv_ejerskab_beriget query (returnerer ejer + virksomhedsnavn + form + branche)',
        '',
        'Ændring 2 — Virksomhedshierarki (linje 257-397):',
        'FØR: 2 cvr_virksomhed_ejerskab queries + N cvr_virksomhed lookups per retning',
        'EFTER: 2 mv_virksomhed_struktur queries (returnerer CVR + navn + form begge sider)',
        '',
        'Ændring 3 — Person-ejere (linje 405-470):',
        'FØR: 1 cvr_deltagerrelation query + N cvr_deltager lookups for navne',
        'EFTER: 1 mv_deltager_beriget query (returnerer enhedsnummer + navn + ejerandel)',
        '',
        'Ændring 4 — 2nd-degree edges (linje 478-527):',
        'FØR: Separate opad/nedad queries per ny node',
        'EFTER: Batch query mod mv_virksomhed_struktur med IN-clause',
        '',
        'Ændring 5 — Person-ejede ejendomme (linje 542-597):',
        'FØR: cvr_deltager name-lookup + ejf_ejerskab name-match',
        'EFTER: mv_ejerskab_beriget med person_enhedsnummer filter',
        '',
        'Performance-mål: P95 diagram-expansion < 500ms (fra nuværende ~3-5s)',
        'Test: Verificér med CVR 25313763 (KIRKBI, dybt hierarki) og person med 10+ virksomheder.',
        '',
        'Afhængigheder: mv_ejerskab_beriget, mv_virksomhed_struktur, mv_deltager_beriget',
        'Estimat: 6-8 timer (store fil, mange touch-points)'
      ]
    },
    {
      summary: 'Backend: Opdater ejendomme-by-owner til at bruge mv_ejerskab_beriget',
      type: '10004',
      lines: [
        'Fil: app/api/ejendomme-by-owner/route.ts',
        '',
        'Nuværende flow (linje 860-1040):',
        '1. Query ejf_ejerskab for CVR ejendomme (1 query)',
        '2. Per-BFE ownership verification via EJF GraphQL (N queries!)',
        '3. Person-lookup: cvr_deltager → ejf_ejerskab name-match (2 queries)',
        '',
        'Nyt flow:',
        '1. Query mv_ejerskab_beriget WHERE ejer_cvr = X (1 query — returnerer alt)',
        '2. For person: WHERE person_enhedsnummer = X (1 query)',
        '3. Drop per-BFE verification (MV er nightly fresh, acceptabel for portefølje-visning)',
        '',
        'Behold EJF GraphQL fallback KUN for real-time single-property ejerskab (/api/ejerskab).',
        '',
        'Performance-mål: Portefølje med 500 ejendomme < 1s (fra nuværende ~10-15s med N+1).',
        '',
        'Afhængighed: mv_ejerskab_beriget',
        'Estimat: 3-4 timer'
      ]
    },
    {
      summary: 'Backend: Tilføj mv_ejendom_master + mv_ejerskab_beriget til AI query whitelist',
      type: '10004',
      lines: [
        'Fil: app/lib/analyseQueryWhitelist.ts',
        '',
        'Tilføj 3 nye views til WHITELISTED_TABLES:',
        '',
        '1. mv_ejendom_master — alle kolonner (BBR + VUR + EJF + CVR + geografi)',
        '   Beskrivelse: "Komplet ejendomsview med BBR, vurdering, ejer og virksomhedsdata. 2.5M+ rækker."',
        '   Inkluder vurdering_pr_m2 kolonne i description',
        '',
        '2. mv_ejerskab_beriget — ejerskab med virksomhedsdata',
        '   Beskrivelse: "Ejerskab beriget med virksomhedsnavn, form og branche."',
        '',
        '3. mv_virksomhed_struktur — virksomhedshierarki',
        '   Beskrivelse: "Virksomhedsejerskab med ejer- og ejet-virksomhedsdata."',
        '',
        'Opdater buildSystemPrompt() i app/api/analyse/query/route.ts:',
        '• Tilføj eksempler der bruger mv_ejendom_master:',
        '  - "Gns. vurdering per kommune" → mv_ejendom_master med kommunenavn + avg(ejendomsvaerdi)',
        '  - "Dyreste ejendomme" → mv_ejendom_master med vurdering_pr_m2 ORDER DESC',
        '  - "Ejendomme ejet af selskaber i byggebranchen" → mv_ejendom_master med virksomhed_branche LIKE',
        '• Instruér AI at foretrække mv_ejendom_master over separate tabeller',
        '• Eksplicér at mv_ejendom_master HAR vurdering (modsat bbr_ejendom_status)',
        '',
        'Afhængighed: MV-tabellerne oprettet og populeret',
        'Estimat: 2-3 timer'
      ]
    },
    {
      summary: 'Backend: Opdater refresh-materialized-views cron med nye MVs + rækkefølge',
      type: '10004',
      lines: [
        'Fil: app/api/cron/refresh-materialized-views/route.ts',
        '',
        'Tilføj nye MVs til VIEWS array i korrekt rækkefølge (hurtigste først):',
        '1. mv_virksomhed_portefolje (~1s)',
        '2. mv_kommune_statistik (~2s)',
        '3. mv_deltager_beriget (~10-20s, 8.7M deltagerrelationer)',
        '4. mv_virksomhed_struktur (~5-10s, 333K ejerskabsrel)',
        '5. mv_ejerskab_beriget (~60-90s, 7.6M ejerskabsrel + joins)',
        '6. mv_analyse_virksomhed (~75s)',
        '7. mv_analyse_ejendom (~120-180s)',
        '8. mv_ejendom_master (~180-240s, 2.5M + 4 joins)',
        '',
        'Opdater refresh_materialized_view() RPC whitelist (migration):',
        'ALTER allowed_views array til at inkludere de 4 nye view-navne.',
        '',
        'maxDuration: Behold 300s — de store MVs (ejendom_master, analyse_ejendom) kan timeout.',
        'Overvej at splitte i 2 cron-jobs: "fast" (1-4) kl. 04:30, "slow" (5-8) kl. 05:00.',
        '',
        'Afhængighed: Alle 4 nye MVs oprettet',
        'Estimat: 2 timer'
      ]
    },
    {
      summary: 'Backend: Opdater AI chat tools til at bruge mv_ejendom_master',
      type: '10004',
      lines: [
        'Fil: app/api/ai/chat/route.ts',
        '',
        'Nuværende AI chat tools gør 3-4 separate API-kald for ejendomsdata:',
        '• hent_bbr_data → /api/bbr (BBR bygningsdata)',
        '• hent_vurdering → /api/vurdering (vurderingsdata)',
        '• hent_ejerskab → /api/ejerskab (ejerskab)',
        '• hent_energimaerke → separat BBR-kald',
        '',
        'Nyt tool: hent_ejendom_komplet',
        '• 1 Supabase query mod mv_ejendom_master WHERE bfe_nummer = X',
        '• Returnerer alt i ét kald: BBR + vurdering + ejer + virksomhed + kommune',
        '• Behold de individuelle tools som fallback for real-time data',
        '',
        'Opdater system prompt:',
        '• Instruér Claude at bruge hent_ejendom_komplet som førstevalg',
        '• Fald back til individuelle tools kun for data der ikke er i MV (tinglysning, plandata, jordforurening)',
        '',
        'Gevinst: AI-chat ejendomsopslag fra 3 tool-calls → 1 tool-call, sparer tokens + latency.',
        '',
        'Afhængighed: mv_ejendom_master oprettet og populeret',
        'Estimat: 4-5 timer'
      ]
    },
    {
      summary: 'Backend: Konsolider Data Intelligence topics til at bruge master views',
      type: '10004',
      lines: [
        'Kontekst: BIZZ-1405 (Data Intelligence epic) har topic-builders der skal populere analytics_knowledge. Flere af disse builders kan forenkles væsentligt med master views.',
        '',
        'Topics der skal opdateres (under BIZZ-1405):',
        '',
        '• BIZZ-1415 propertyByType + propertyByMunicipality:',
        '  FØR: Query bbr_ejendom_status + manual kommune_ref join',
        '  EFTER: Query mv_ejendom_master GROUP BY kommunenavn (direkte)',
        '',
        '• BIZZ-1416 avgValuationByType:',
        '  FØR: Join vurdering_cache + bbr_ejendom_status + kommune_ref',
        '  EFTER: Query mv_ejendom_master WHERE ejendomsvaerdi IS NOT NULL GROUP BY anvendelse_kategori',
        '',
        '• BIZZ-1417 dataCoverage:',
        '  FØR: Separate COUNT queries mod 3 tabeller',
        '  EFTER: Query mv_ejendom_master — count(ejendomsvaerdi) vs count(*) giver VUR-dækning direkte',
        '',
        '• BIZZ-1418 ownershipDistribution:',
        '  FØR: Query ejf_ejerskab + manual type-aggregering',
        '  EFTER: Query mv_ejendom_master GROUP BY ejer_type',
        '',
        'Anbefaling: Opdater disse BIZZ-1405 stories til at referere mv_ejendom_master i acceptance criteria.',
        '',
        'Estimat: 2 timer (koordinering + story-updates, ikke implementering)'
      ]
    },

    // ═══════════════════════════════════════════════
    // FASE 3b: PERFORMANCE + OBSERVABILITY
    // ═══════════════════════════════════════════════
    {
      summary: 'DBA: Tilføj foreign keys og referentiel integritet mellem kernetabeller',
      type: '10004',
      lines: [
        'Problem:',
        'Ingen af kernetabellerne har deklarerede foreign keys. Linking er kun implicit via kolonnenavne. Det giver:',
        '• Ingen referentiel integritet — orphan records mulige',
        '• Postgres query planner kan ikke optimere joins baseret på FK',
        '• Ingen automatisk kaskade-delete (GDPR)',
        '',
        'Løsning (migration):',
        'Tilføj FK constraints med ON DELETE SET NULL (ikke CASCADE — undgår kaskade-uheld):',
        '',
        '1. ejf_ejerskab.bfe_nummer → bbr_ejendom_status.bfe_nummer',
        '   (DEFERRABLE — tillader bulk ingest uden ordering)',
        '',
        '2. vurdering_cache.bfe_nummer → bbr_ejendom_status.bfe_nummer',
        '',
        '3. tinglysning_cache.bfe_nummer → bbr_ejendom_status.bfe_nummer',
        '',
        '4. cvr_virksomhed_ejerskab.ejer_cvr → cvr_virksomhed.cvr',
        '   cvr_virksomhed_ejerskab.ejet_cvr → cvr_virksomhed.cvr',
        '',
        '5. regnskab_cache.cvr → cvr_virksomhed.cvr',
        '',
        'VIGTIGT: Kør som VALIDATE CONSTRAINT (ikke NOT VALID) kun efter data-cleanup.',
        'Test: Tjek for orphan records INDEN FK tilføjes:',
        'SELECT count(*) FROM ejf_ejerskab e WHERE NOT EXISTS (SELECT 1 FROM bbr_ejendom_status b WHERE b.bfe_nummer = e.bfe_nummer)',
        '',
        'Estimat: 3-4 timer (inkl. orphan-analyse + migration + test)'
      ]
    },
    {
      summary: 'DBA: Opret data_quality_dashboard view med dækningsstatistik per tabel',
      type: '10004',
      lines: [
        'Formål:',
        'Monitoring-view der viser datakvalitet: dækning, NULL-%, orphan records, staleness.',
        '',
        'CREATE VIEW v_data_quality AS',
        'SELECT',
        '  \'bbr_ejendom_status\' AS tabel,',
        '  count(*) AS total,',
        '  count(kommune_kode) AS has_kommune,',
        '  count(energimaerke) AS has_energi,',
        '  count(samlet_boligareal) AS has_areal,',
        '  max(status_last_checked_at) AS freshest',
        'FROM bbr_ejendom_status',
        'UNION ALL ...',
        '',
        'Tabeller:',
        '• bbr_ejendom_status: total, has_kommune, has_energi, has_areal, freshest',
        '• ejf_ejerskab: total, gaeldende, historisk, has_cvr, has_person',
        '• cvr_virksomhed: total, aktive, ophoert',
        '• vurdering_cache: total, has_kommune, has_vurdering, stale count',
        '• tinglysning_cache: total, stale count',
        '• regnskab_cache: total, has_omsaetning (efter normalisering)',
        '• cache_dar: total',
        '',
        'Gevinst:',
        '• AI Data Intelligence kan bruge dette for dataCoverage topics',
        '• Admin-dashboard kan vise data-sundhed',
        '• Alerts ved kvalitetsfald (< 80% dækning)',
        '',
        'Estimat: 2 timer'
      ]
    }
  ];

  for (const story of stories) {
    console.log('Creating:', story.summary.slice(0, 70) + '...');
    const result = await createTicket({
      project: { key: JIRA_PROJECT_KEY },
      summary: story.summary,
      issuetype: { id: story.type },
      parent: { key: epic.key },
      description: desc(story.lines)
    });
    console.log('✅', result.key);
  }

  console.log('\nDone! All tickets under epic', epic.key);
}

main().catch(e => console.error('Error:', e.message));
