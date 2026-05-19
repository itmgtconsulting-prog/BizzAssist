/**
 * Metric-katalog for Data Intelligence semantic layer (BIZZ-1562).
 *
 * 31 metrics fordelt på 3 fact-tabeller:
 * - cvr_virksomhed (count + breakdowns)
 * - ejerskifte_historik (handler + priser + m²-pris)
 * - bbr_ejendom_status (ejendomme + arealer + energimaerker)
 * - ejf_ejerskab (ejer-koncentration)
 * - vurdering_cache (offentlig vurdering)
 *
 * Hver metric har 2-3 NL-eksempler så L2.2 routing kan matche dem mod
 * bruger-spørgsmål.
 *
 * @module app/lib/dataIntelligence/semantic/metrics
 */

import type { MetricDefinition } from './types';

/** Alle metrics — eksporteres som flat array */
export const METRICS: MetricDefinition[] = [
  // ─── Virksomheder ─────────────────────────────────────────────────────
  {
    name: 'count_virksomheder',
    displayName: 'Antal virksomheder',
    description: 'Totalt antal CVR-registrerede virksomheder',
    type: 'count',
    sql: 'COUNT(*)',
    table: 'cvr_virksomhed',
    format: 'integer',
    unit: 'antal',
    examples: ['Hvor mange virksomheder er der i alt?', 'Antal virksomheder i Danmark'],
  },
  {
    name: 'count_virksomheder_aktive',
    displayName: 'Antal aktive virksomheder',
    description: 'Virksomheder uden ophørsdato',
    type: 'count',
    sql: 'COUNT(*)',
    table: 'cvr_virksomhed',
    filters: ['ophoert IS NULL'],
    format: 'integer',
    unit: 'antal',
    examples: ['Hvor mange aktive virksomheder er der?', 'Antal aktive selskaber'],
  },
  {
    name: 'count_virksomheder_ophoert',
    displayName: 'Antal ophørte virksomheder',
    description: 'Virksomheder med ophørsdato sat',
    type: 'count',
    sql: 'COUNT(*)',
    table: 'cvr_virksomhed',
    filters: ['ophoert IS NOT NULL'],
    format: 'integer',
    unit: 'antal',
    examples: ['Hvor mange virksomheder er ophørt?', 'Antal lukkede selskaber'],
  },

  // ─── Ejendomme ────────────────────────────────────────────────────────
  {
    name: 'count_ejendomme',
    displayName: 'Antal ejendomme',
    description: 'Antal aktive BBR-ejendomme (ekskl. udfasede)',
    type: 'count',
    sql: 'COUNT(*)',
    table: 'bbr_ejendom_status',
    filters: ['is_udfaset = false'],
    format: 'integer',
    unit: 'antal',
    examples: ['Hvor mange ejendomme er der i alt?', 'Antal BBR-ejendomme'],
  },
  {
    name: 'count_ejendomme_med_handel',
    displayName: 'Antal ejendomme med handel',
    description: 'Distinkt antal BFE-numre der har mindst én registreret handel',
    type: 'count_distinct',
    sql: 'COUNT(DISTINCT bfe_nummer)',
    table: 'ejerskifte_historik',
    format: 'integer',
    unit: 'antal',
    examples: [
      'Hvor mange ejendomme har skiftet ejer?',
      'Antal ejendomme med transaktionshistorik',
    ],
  },

  // ─── Handler / ejerskifter ────────────────────────────────────────────
  {
    name: 'count_handler',
    displayName: 'Antal handler',
    description: 'Totalt antal registrerede ejerskifter',
    type: 'count',
    sql: 'COUNT(*)',
    table: 'ejerskifte_historik',
    format: 'integer',
    unit: 'antal',
    examples: [
      'Hvor mange handler er der?',
      'Antal ejerskifter i 2025',
      'Hvor mange boliger blev solgt?',
    ],
  },
  {
    name: 'count_handler_med_pris',
    displayName: 'Antal handler med pris',
    description: 'Handler hvor kontant_koebesum er beriget fra Tinglysning',
    type: 'count',
    sql: 'COUNT(*)',
    table: 'ejerskifte_historik',
    filters: ['kontant_koebesum IS NOT NULL'],
    format: 'integer',
    unit: 'antal',
    examples: ['Hvor mange handler har vi pris-data for?', 'Antal handler med kendt salgspris'],
  },
  {
    name: 'sum_koebesum',
    displayName: 'Samlet købesum',
    description: 'Sum af kontante købesummer på registrerede handler',
    type: 'sum',
    sql: 'SUM(kontant_koebesum)',
    table: 'ejerskifte_historik',
    filters: ['kontant_koebesum IS NOT NULL'],
    format: 'currency_dkk',
    unit: 'DKK',
    examples: ['Samlet handelsværdi i 2025', 'Total købesum for handler i Hvidovre'],
  },
  {
    name: 'avg_koebesum',
    displayName: 'Gennemsnitlig købesum',
    // BIZZ-1682: Filtrerer gaver/arv (koebesum < 100k) og porteføljehandler
    // (> 100M). Brug median_koebesum for mere retvisende central-værdi.
    description:
      'Gennemsnit af kontante købesummer (filtreret: ekskluderer gaver under 100.000 og porteføljehandler over 100M). VIGTIGT: Brug median_koebesum i stedet — aritmetisk gennemsnit er misvisende for ejendomspriser pga. skæv fordeling.',
    type: 'avg',
    sql: 'AVG(kontant_koebesum)',
    table: 'ejerskifte_historik',
    filters: [
      'kontant_koebesum IS NOT NULL',
      'kontant_koebesum > 100000',
      'kontant_koebesum < 100000000',
    ],
    format: 'currency_dkk',
    unit: 'DKK',
    examples: [
      'Hvad er gennemsnitsprisen for et hus solgt i 2025?',
      'Gennemsnitlig salgspris i København',
    ],
  },
  {
    name: 'median_koebesum',
    displayName: 'Median købesum (anbefalet)',
    description:
      'Median af kontante købesummer (50. percentil) — den mest retvisende central-værdi for ejendomspriser. Foretrækkes over avg_koebesum.',
    type: 'median',
    sql: 'PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY kontant_koebesum)',
    table: 'ejerskifte_historik',
    filters: [
      'kontant_koebesum IS NOT NULL',
      'kontant_koebesum > 100000',
      'kontant_koebesum < 100000000',
    ],
    format: 'currency_dkk',
    unit: 'DKK',
    examples: ['Medianpris for boliger i 2025', 'Median købesum per kommune'],
  },
  {
    name: 'max_koebesum',
    displayName: 'Højeste købesum',
    description: 'Maximum af registrerede købesummer',
    type: 'max',
    sql: 'MAX(kontant_koebesum)',
    table: 'ejerskifte_historik',
    filters: ['kontant_koebesum IS NOT NULL'],
    format: 'currency_dkk',
    unit: 'DKK',
    examples: ['Hvad er den dyreste handel i 2025?', 'Højeste salgspris i området'],
  },
  {
    name: 'avg_m2_pris',
    displayName: 'Gennemsnitlig m²-pris',
    description: 'Gennemsnitlig kvadratmeterpris (kontant_koebesum / boligareal)',
    type: 'avg',
    sql: 'AVG(m2_pris)',
    table: 'ejerskifte_historik',
    filters: ['m2_pris IS NOT NULL', 'm2_pris > 0'],
    format: 'currency_dkk',
    unit: 'DKK/m²',
    examples: [
      'Hvad er gennemsnitlig m²-pris i Aarhus?',
      'Kvadratmeterpris for parcelhuse i Hvidovre',
    ],
  },
  {
    name: 'median_m2_pris',
    displayName: 'Median m²-pris',
    description: 'Median kvadratmeterpris',
    type: 'median',
    sql: 'PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY m2_pris)',
    table: 'ejerskifte_historik',
    filters: ['m2_pris IS NOT NULL', 'm2_pris > 0'],
    format: 'currency_dkk',
    unit: 'DKK/m²',
    examples: ['Median m²-pris per kommune', 'Mid-marked-pris pr. m²'],
  },
  {
    name: 'ratio_handler_med_pris',
    displayName: 'Andel handler med kendt pris',
    description: 'Procentdel af handler hvor kontant_koebesum er sat',
    type: 'ratio',
    sql: '(COUNT(*) FILTER (WHERE kontant_koebesum IS NOT NULL))::float / NULLIF(COUNT(*), 0)',
    table: 'ejerskifte_historik',
    format: 'percent',
    unit: '%',
    examples: ['Hvor stor en andel af handler har kendt pris?', 'Pris-dækning per kommune'],
  },

  // ─── Vurdering ────────────────────────────────────────────────────────
  {
    name: 'sum_ejendomsvaerdi',
    displayName: 'Samlet ejendomsværdi',
    description: 'Sum af offentlig ejendomsværdi',
    type: 'sum',
    sql: 'SUM(ejendomsvaerdi)',
    table: 'vurdering_cache',
    filters: ['ejendomsvaerdi IS NOT NULL'],
    format: 'currency_dkk',
    unit: 'DKK',
    examples: ['Samlet ejendomsværdi i Aarhus', 'Total vurdering for ejendomsportefølje'],
  },
  {
    name: 'avg_ejendomsvaerdi',
    displayName: 'Gennemsnitlig ejendomsværdi',
    description: 'Gennemsnit af offentlig ejendomsværdi',
    type: 'avg',
    sql: 'AVG(ejendomsvaerdi)',
    table: 'vurdering_cache',
    filters: ['ejendomsvaerdi IS NOT NULL'],
    format: 'currency_dkk',
    unit: 'DKK',
    examples: ['Gennemsnitsvurdering for parcelhuse i 2024', 'Gns. ejendomsværdi per kommune'],
  },
  {
    name: 'sum_grundvaerdi',
    displayName: 'Samlet grundværdi',
    description: 'Sum af offentlig grundværdi',
    type: 'sum',
    sql: 'SUM(grundvaerdi)',
    table: 'vurdering_cache',
    filters: ['grundvaerdi IS NOT NULL'],
    format: 'currency_dkk',
    unit: 'DKK',
    examples: ['Samlet grundværdi i en kommune', 'Total grundvurdering'],
  },

  // ─── Ejer-koncentration ──────────────────────────────────────────────
  {
    name: 'count_unique_ejere',
    displayName: 'Antal unikke ejere',
    description: 'Distinkt antal ejere (person + virksomhed) i gældende ejerskaber',
    type: 'count_distinct',
    sql: 'COUNT(DISTINCT COALESCE(ejer_cvr, ejer_navn))',
    table: 'ejf_ejerskab',
    filters: ["status = 'gældende'"],
    format: 'integer',
    unit: 'antal',
    examples: ['Hvor mange unikke ejendomsejere er der?', 'Antal ejere af ejendomme'],
  },
  {
    name: 'count_unique_ejere_personer',
    displayName: 'Antal unikke person-ejere',
    description: 'Distinkt antal person-ejere',
    type: 'count_distinct',
    sql: 'COUNT(DISTINCT ejer_navn)',
    table: 'ejf_ejerskab',
    filters: ["status = 'gældende'", "ejer_type = 'person'"],
    format: 'integer',
    unit: 'antal',
    examples: ['Hvor mange personer ejer ejendomme?', 'Antal private ejere'],
  },
  {
    name: 'count_unique_ejere_virksomheder',
    displayName: 'Antal unikke virksomheds-ejere',
    description: 'Distinkt antal virksomheds-CVR der ejer ejendomme',
    type: 'count_distinct',
    sql: 'COUNT(DISTINCT ejer_cvr)',
    table: 'ejf_ejerskab',
    filters: ["status = 'gældende'", "ejer_type = 'virksomhed'", 'ejer_cvr IS NOT NULL'],
    format: 'integer',
    unit: 'antal',
    examples: ['Hvor mange virksomheder ejer ejendomme?', 'Antal selskabs-ejede ejendomme'],
  },
  {
    name: 'avg_antal_ejendomme_per_ejer',
    displayName: 'Gns. antal ejendomme per ejer',
    description: 'Gennemsnitlig portefølje-størrelse per ejer',
    type: 'avg',
    sql: 'AVG(antal_ejendomme)',
    table: 'ejf_ejerskab',
    filters: ["status = 'gældende'", 'ejer_cvr IS NOT NULL'],
    format: 'decimal',
    unit: 'ejendomme/ejer',
    examples: ['Hvad ejer en gennemsnitlig virksomhed?', 'Gns. portefølje-størrelse'],
  },
  {
    name: 'max_antal_ejendomme_per_ejer',
    displayName: 'Største ejer-portefølje',
    description: 'Højeste antal ejendomme ejet af én enhed',
    type: 'max',
    sql: 'MAX(antal_ejendomme)',
    table: 'ejf_ejerskab',
    filters: ["status = 'gældende'", 'ejer_cvr IS NOT NULL'],
    format: 'integer',
    unit: 'ejendomme',
    examples: ['Største ejendomsejer i Danmark', 'Hvem ejer flest ejendomme?'],
  },

  // ─── Areal / BBR ──────────────────────────────────────────────────────
  {
    name: 'sum_areal_bolig',
    displayName: 'Samlet boligareal',
    description: 'Sum af samlet boligareal',
    type: 'sum',
    sql: 'SUM(samlet_boligareal)',
    table: 'bbr_ejendom_status',
    filters: ['is_udfaset = false', 'samlet_boligareal IS NOT NULL'],
    format: 'm2',
    unit: 'm²',
    examples: ['Samlet boligareal i Danmark', 'Total boligkvadratmeter per kommune'],
  },
  {
    name: 'sum_areal_erhverv',
    displayName: 'Samlet erhvervsareal',
    description: 'Sum af samlet erhvervsareal',
    type: 'sum',
    sql: 'SUM(samlet_erhvervsareal)',
    table: 'bbr_ejendom_status',
    filters: ['is_udfaset = false', 'samlet_erhvervsareal IS NOT NULL'],
    format: 'm2',
    unit: 'm²',
    examples: ['Samlet erhvervsareal i Aarhus', 'Total kontorareal'],
  },
  {
    name: 'sum_areal_total',
    displayName: 'Samlet bygningsareal',
    description: 'Sum af bolig- + erhvervsareal',
    type: 'sum',
    sql: 'SUM(COALESCE(samlet_boligareal, 0) + COALESCE(samlet_erhvervsareal, 0))',
    table: 'bbr_ejendom_status',
    filters: ['is_udfaset = false'],
    format: 'm2',
    unit: 'm²',
    examples: ['Total bygningsareal per region', 'Samlet etageareal'],
  },
  {
    name: 'avg_opfoerelsesaar',
    displayName: 'Gennemsnitligt opførelsesår',
    description: 'Gennemsnit af opførelsesår — viser bygningsalders-profil',
    type: 'avg',
    sql: 'AVG(opfoerelsesaar)',
    table: 'bbr_ejendom_status',
    filters: ['is_udfaset = false', 'opfoerelsesaar IS NOT NULL'],
    format: 'integer',
    unit: 'år',
    examples: ['Hvad er gennemsnits-alderen på ejendomme?', 'Ældste boligmasse per kommune'],
  },
  {
    name: 'count_bygninger_foer_1980',
    displayName: 'Bygninger opført før 1980',
    description: 'Antal ejendomme opført før 1980 (energi-renoverings-leads)',
    type: 'count',
    sql: 'COUNT(*)',
    table: 'bbr_ejendom_status',
    filters: ['is_udfaset = false', 'opfoerelsesaar < 1980'],
    format: 'integer',
    unit: 'antal',
    examples: ['Hvor mange ejendomme er bygget før 1980?', 'Antal ældre bygninger per kommune'],
  },
  {
    name: 'count_bygninger_efter_2000',
    displayName: 'Bygninger opført efter 2000',
    description: 'Antal ejendomme opført efter 2000 (nybyggeri-segment)',
    type: 'count',
    sql: 'COUNT(*)',
    table: 'bbr_ejendom_status',
    filters: ['is_udfaset = false', 'opfoerelsesaar >= 2000'],
    format: 'integer',
    unit: 'antal',
    examples: ['Hvor mange nybyggerier er der?', 'Antal moderne ejendomme'],
  },
  {
    name: 'count_per_energimaerke',
    displayName: 'Antal per energimærke',
    description: 'Fordeling af ejendomme på energimærker A-G (kræver group by energimaerke)',
    type: 'count',
    sql: 'COUNT(*)',
    table: 'bbr_ejendom_status',
    filters: ['is_udfaset = false', 'energimaerke IS NOT NULL'],
    format: 'integer',
    unit: 'antal',
    examples: ['Fordeling af energimærker', 'Hvor mange ejendomme har energimærke G?'],
  },
  {
    name: 'count_ejendomme_uden_energimaerke',
    displayName: 'Ejendomme uden energimærke',
    description: 'Antal aktive ejendomme uden energimærke registreret',
    type: 'count',
    sql: 'COUNT(*)',
    table: 'bbr_ejendom_status',
    filters: ['is_udfaset = false', 'energimaerke IS NULL'],
    format: 'integer',
    unit: 'antal',
    examples: ['Hvor mange ejendomme mangler energimærke?', 'Antal ejendomme uden energimærkning'],
  },

  // ─── Regnskab ─────────────────────────────────────────────────────────
  {
    name: 'sum_omsaetning',
    displayName: 'Samlet omsætning',
    description: 'Sum af omsætning fra seneste registrerede regnskabsår',
    type: 'sum',
    sql: 'SUM(omsaetning)',
    table: 'regnskab_cache',
    filters: ['omsaetning IS NOT NULL'],
    format: 'currency_dkk',
    unit: 'DKK',
    examples: ['Samlet omsætning i branche X', 'Total omsætning per kommune'],
  },
];

/**
 * Find metric efter navn.
 *
 * @param name - Metric-navn (snake-case)
 * @returns MetricDefinition eller undefined
 */
export function getMetric(name: string): MetricDefinition | undefined {
  return METRICS.find((m) => m.name === name);
}

/**
 * Find metrics der refererer til en specifik tabel.
 *
 * @param table - Tabel-navn (uden schema)
 * @returns Liste af metrics
 */
export function getMetricsByTable(table: string): MetricDefinition[] {
  return METRICS.filter((m) => m.table === table);
}
