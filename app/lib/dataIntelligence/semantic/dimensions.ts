/**
 * Dimensions-katalog for Data Intelligence semantic layer (BIZZ-1562).
 *
 * 23 dimensions fordelt på:
 * - Tid (5): dato, maaned, kvartal, halvaar, aar
 * - Geo (5): kommune, region, postnummer, by, vejnavn
 * - Ejendom (6): ejendomstype, energimaerke, opfoerelsesaar_decennie,
 *   antal_etager_bucket, zone, bevaringsvaerdig
 * - Ejer (5): ejer_type, virksomhedsform, branche_kode_top, antal_ansatte_interval, ejer_land
 * - Pris/koncentration (2): koebesum_bucket, antal_ejendomme_bucket
 *
 * Bucketize giver routeren mulighed for at gruppere kontinuerte værdier i
 * meningsfulde intervaller uden Claude-hjælp.
 *
 * @module app/lib/dataIntelligence/semantic/dimensions
 */

import type { DimensionDefinition } from './types';

/** Alle dimensions */
export const DIMENSIONS: DimensionDefinition[] = [
  // ─── Tid ──────────────────────────────────────────────────────────────
  {
    name: 'dato',
    displayName: 'Dato',
    description: 'Dato-granularitet (én række per dag)',
    type: 'date',
    sql: 'overtagelsesdato',
    table: 'ejerskifte_historik',
    examples: ['Handler per dag i januar', 'Daglige ejerskifter'],
  },
  {
    name: 'maaned',
    displayName: 'Måned',
    description: 'Måneds-granularitet (YYYY-MM)',
    type: 'string',
    sql: "to_char(date_trunc('month', overtagelsesdato), 'YYYY-MM')",
    table: 'ejerskifte_historik',
    examples: ['Handler per måned', 'Salgsudvikling pr. måned'],
  },
  {
    name: 'kvartal',
    displayName: 'Kvartal',
    description: 'Kvartals-granularitet (YYYY-Q1..Q4)',
    type: 'string',
    sql: "to_char(overtagelsesdato, 'YYYY') || '-Q' || to_char(overtagelsesdato, 'Q')",
    table: 'ejerskifte_historik',
    examples: ['Handler per kvartal', 'Salgsvolumen Q3 2025'],
  },
  {
    name: 'halvaar',
    displayName: 'Halvår',
    description: 'Halvårs-granularitet (YYYY-H1/H2)',
    type: 'string',
    sql: "to_char(overtagelsesdato, 'YYYY') || CASE WHEN EXTRACT(MONTH FROM overtagelsesdato) <= 6 THEN '-H1' ELSE '-H2' END",
    table: 'ejerskifte_historik',
    examples: ['Handler per halvår', 'Sammenligning H1 vs H2'],
  },
  {
    name: 'aar',
    displayName: 'År',
    description: 'Års-granularitet',
    type: 'integer',
    sql: 'EXTRACT(YEAR FROM overtagelsesdato)::int',
    table: 'ejerskifte_historik',
    examples: ['Handler per år', 'Årlig udvikling i salgsvolumen'],
  },

  // ─── Geo ──────────────────────────────────────────────────────────────
  {
    name: 'kommune',
    displayName: 'Kommune',
    description: 'Kommunenavn (kræver join til kommune_ref)',
    type: 'string',
    sql: 'kommune_ref.kommunenavn',
    table: 'kommune_ref',
    examples: ['Top kommuner efter antal handler', 'Salgsvolumen per kommune'],
  },
  {
    name: 'kommune_kode',
    displayName: 'Kommunekode',
    description: 'Numerisk kommunekode',
    type: 'integer',
    sql: 'kommune_kode',
    table: 'bbr_ejendom_status',
    examples: ['Filter per kommunekode', 'Ejendomme i kommune 101'],
  },
  {
    name: 'region',
    displayName: 'Region',
    description: 'Region (kræver join til kommune_ref)',
    type: 'enum',
    sql: 'kommune_ref.region',
    table: 'kommune_ref',
    enumValues: [
      'Region Hovedstaden',
      'Region Sjælland',
      'Region Syddanmark',
      'Region Midtjylland',
      'Region Nordjylland',
    ],
    examples: ['Handler per region', 'Sammenligning af regioner'],
  },
  {
    name: 'postnummer',
    displayName: 'Postnummer',
    description: '4-cifret postnummer',
    type: 'integer',
    sql: 'postnummer',
    table: 'bbr_ejendom_status',
    examples: ['Handler i 2100', 'Top postnumre efter salgsvolumen'],
  },
  {
    name: 'by',
    displayName: 'By',
    description: 'Postnummer-by (fx "København Ø")',
    type: 'string',
    sql: 'postnummer_by',
    table: 'bbr_ejendom_status',
    examples: ['Salgspriser i Aarhus C', 'Handler i Hellerup'],
  },

  // ─── Ejendom ──────────────────────────────────────────────────────────
  {
    name: 'ejendomstype',
    displayName: 'Ejendomstype',
    description: 'Klassificering baseret på BBR-anvendelseskode',
    type: 'enum',
    sql: `CASE
      WHEN byg021_anvendelse BETWEEN 110 AND 130 THEN 'hus'
      WHEN byg021_anvendelse = 140 THEN 'lejlighed'
      WHEN byg021_anvendelse BETWEEN 510 AND 590 THEN 'sommerhus'
      WHEN byg021_anvendelse BETWEEN 210 AND 290 THEN 'erhverv'
      WHEN byg021_anvendelse BETWEEN 910 AND 990 THEN 'sekundær_bygning'
      ELSE 'andet'
    END`,
    table: 'bbr_ejendom_status',
    enumValues: ['hus', 'lejlighed', 'sommerhus', 'erhverv', 'sekundær_bygning', 'andet'],
    examples: ['Fordeling på ejendomstyper', 'Antal solgte lejligheder'],
  },
  {
    name: 'energimaerke',
    displayName: 'Energimærke',
    description: 'Energimærke A-G',
    type: 'enum',
    sql: 'energimaerke',
    table: 'bbr_ejendom_status',
    enumValues: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
    examples: ['Fordeling af energimærker', 'Ejendomme med dårligt energimærke (E/F/G)'],
  },
  {
    name: 'opfoerelsesaar_decennie',
    displayName: 'Opførelses-årti',
    description: 'Bucketized opførelsesår i historiske perioder',
    type: 'string',
    sql: `CASE
      WHEN opfoerelsesaar < 1900 THEN 'før 1900'
      WHEN opfoerelsesaar < 1950 THEN '1900-1949'
      WHEN opfoerelsesaar < 1980 THEN '1950-1979'
      WHEN opfoerelsesaar < 2000 THEN '1980-1999'
      WHEN opfoerelsesaar >= 2000 THEN '2000+'
      ELSE 'ukendt'
    END`,
    table: 'bbr_ejendom_status',
    enumValues: ['før 1900', '1900-1949', '1950-1979', '1980-1999', '2000+'],
    examples: [
      'Fordeling af ejendomme på opførelses-periode',
      'Hvor mange ejendomme er fra 1950-1979?',
    ],
  },
  {
    name: 'antal_etager_bucket',
    displayName: 'Antal etager (bucket)',
    description: 'Etager grupperet i bånd',
    type: 'string',
    sql: `CASE
      WHEN antal_etager = 1 THEN '1 etage'
      WHEN antal_etager = 2 THEN '2 etager'
      WHEN antal_etager BETWEEN 3 AND 5 THEN '3-5 etager'
      WHEN antal_etager >= 6 THEN '6+ etager'
      ELSE 'ukendt'
    END`,
    table: 'bbr_ejendom_status',
    enumValues: ['1 etage', '2 etager', '3-5 etager', '6+ etager'],
    examples: ['Højhuse vs lave ejendomme', 'Fordeling per etage-antal'],
  },
  {
    name: 'zone',
    displayName: 'Plan-zone',
    description:
      'Byzone/landzone/sommerhuszone (kræver join til plandata — pt. ikke fuldt tilgængeligt)',
    type: 'enum',
    sql: 'zone',
    table: 'bbr_ejendom_status',
    enumValues: ['byzone', 'landzone', 'sommerhuszone'],
    examples: ['Handler per zone', 'Ejendomme i landzone'],
  },
  {
    name: 'bevaringsvaerdig',
    displayName: 'Bevaringsværdig',
    description: 'Boolean — om ejendommen er klassificeret som bevaringsværdig',
    type: 'boolean',
    sql: 'bevaringsvaerdighed IS NOT NULL AND bevaringsvaerdighed <= 4',
    table: 'bbr_ejendom_status',
    examples: ['Hvor mange bevaringsværdige ejendomme?', 'Bevaringsværdige bygninger per kommune'],
  },

  // ─── Ejer ────────────────────────────────────────────────────────────
  {
    name: 'ejer_type',
    displayName: 'Ejertype',
    description: 'Person vs virksomhed',
    type: 'enum',
    sql: 'ejer_type',
    table: 'ejf_ejerskab',
    enumValues: ['person', 'virksomhed'],
    examples: ['Andel ejendomme ejet af virksomheder', 'Privat vs erhverv ejerskab'],
  },
  {
    name: 'virksomhedsform',
    displayName: 'Virksomhedsform',
    description: 'Selskabsform-kode (kun for ejer_type=virksomhed)',
    type: 'string',
    sql: 'cvr_virksomhed.virksomhedsform',
    table: 'cvr_virksomhed',
    examples: ['Fordeling på selskabsformer', 'Antal ApS vs A/S'],
  },
  {
    name: 'branche_kode_top',
    displayName: 'Branche (top-niveau)',
    description: 'Branchekode trunkeret til 2-cifret hovedgruppe',
    type: 'string',
    sql: 'LEFT(cvr_virksomhed.branche_kode, 2)',
    table: 'cvr_virksomhed',
    examples: ['Fordeling per branche-hovedgruppe', 'Ejendomsbranchen vs øvrige sektorer'],
  },
  {
    name: 'antal_ansatte_interval',
    displayName: 'Antal ansatte (bucket)',
    description: 'Ansatte grupperet i størrelses-bånd',
    type: 'string',
    sql: `CASE
      WHEN cvr_virksomhed.ansatte_aar = 0 THEN '0 ansatte'
      WHEN cvr_virksomhed.ansatte_aar BETWEEN 1 AND 9 THEN '1-9 ansatte'
      WHEN cvr_virksomhed.ansatte_aar BETWEEN 10 AND 49 THEN '10-49 ansatte'
      WHEN cvr_virksomhed.ansatte_aar BETWEEN 50 AND 249 THEN '50-249 ansatte'
      WHEN cvr_virksomhed.ansatte_aar >= 250 THEN '250+ ansatte'
      ELSE 'ukendt'
    END`,
    table: 'cvr_virksomhed',
    enumValues: ['0 ansatte', '1-9 ansatte', '10-49 ansatte', '50-249 ansatte', '250+ ansatte'],
    examples: ['Fordeling per virksomhedsstørrelse', 'Store vs små virksomheder'],
  },

  // ─── Pris / koncentration ────────────────────────────────────────────
  {
    name: 'koebesum_bucket',
    displayName: 'Købesum (bucket)',
    description: 'Handler grupperet i prisintervaller',
    type: 'string',
    sql: `CASE
      WHEN kontant_koebesum < 1000000 THEN '<1 mio'
      WHEN kontant_koebesum < 5000000 THEN '1-5 mio'
      WHEN kontant_koebesum < 10000000 THEN '5-10 mio'
      WHEN kontant_koebesum < 50000000 THEN '10-50 mio'
      WHEN kontant_koebesum >= 50000000 THEN '50+ mio'
      ELSE 'ukendt'
    END`,
    table: 'ejerskifte_historik',
    enumValues: ['<1 mio', '1-5 mio', '5-10 mio', '10-50 mio', '50+ mio'],
    bucketize: {
      ranges: [
        { label: '<1 mio', max: 1_000_000 },
        { label: '1-5 mio', min: 1_000_000, max: 5_000_000 },
        { label: '5-10 mio', min: 5_000_000, max: 10_000_000 },
        { label: '10-50 mio', min: 10_000_000, max: 50_000_000 },
        { label: '50+ mio', min: 50_000_000 },
      ],
    },
    examples: ['Fordeling af salgspriser', 'Hvor mange handler over 10 mio?'],
  },
  {
    name: 'antal_ejendomme_bucket',
    displayName: 'Porteføljestørrelse',
    description: 'Ejer grupperet efter antal ejede ejendomme',
    type: 'string',
    sql: `CASE
      WHEN antal_ejendomme = 1 THEN '1 ejendom'
      WHEN antal_ejendomme BETWEEN 2 AND 5 THEN '2-5 ejendomme'
      WHEN antal_ejendomme BETWEEN 6 AND 20 THEN '6-20 ejendomme'
      WHEN antal_ejendomme BETWEEN 21 AND 100 THEN '21-100 ejendomme'
      WHEN antal_ejendomme > 100 THEN '100+ ejendomme'
      ELSE '0 ejendomme'
    END`,
    table: 'ejf_ejerskab',
    enumValues: [
      '1 ejendom',
      '2-5 ejendomme',
      '6-20 ejendomme',
      '21-100 ejendomme',
      '100+ ejendomme',
    ],
    bucketize: {
      ranges: [
        { label: '1 ejendom', min: 1, max: 2 },
        { label: '2-5 ejendomme', min: 2, max: 6 },
        { label: '6-20 ejendomme', min: 6, max: 21 },
        { label: '21-100 ejendomme', min: 21, max: 101 },
        { label: '100+ ejendomme', min: 101 },
      ],
    },
    examples: ['Fordeling af ejere efter portefølje-størrelse', 'Antal storejere'],
  },
];

/**
 * Find dimension efter navn.
 */
export function getDimension(name: string): DimensionDefinition | undefined {
  return DIMENSIONS.find((d) => d.name === name);
}

/**
 * Find dimensions der tilhører en specifik tabel.
 */
export function getDimensionsByTable(table: string): DimensionDefinition[] {
  return DIMENSIONS.filter((d) => d.table === table);
}
