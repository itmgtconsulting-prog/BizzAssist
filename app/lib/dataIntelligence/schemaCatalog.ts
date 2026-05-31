/**
 * schemaCatalog — Struktureret katalog over Data Intelligence-tabeller (BIZZ-1559).
 *
 * Erstatter den inline TABEL-KOLONNER-sektion i sqlGenPrompt med en typed datamodel
 * der kan iterereres over, vises i UI, og bruges af test/validering.
 *
 * Hver tabel-entry inkluderer:
 * - kolonner med type, nullable, beskrivelse og 2-3 sample-værdier
 * - typiske join-mønstre med formål
 * - PII-flag (ekskluderes fra svar når sat)
 * - approx row count til performance-rationalisering
 *
 * @module app/lib/dataIntelligence/schemaCatalog
 */

/** PostgreSQL kolonne-type — subset relevant for Data Intelligence */
export type ColumnType =
  | 'text'
  | 'integer'
  | 'bigint'
  | 'smallint'
  | 'numeric'
  | 'boolean'
  | 'date'
  | 'timestamptz'
  | 'jsonb'
  | 'uuid';

/** Metadata for én kolonne */
export interface ColumnMeta {
  /** Kolonne-navn (snake_case, som i DB) */
  name: string;
  /** PostgreSQL-type */
  type: ColumnType;
  /** Kan være NULL? */
  nullable: boolean;
  /** Menneskelig forklaring — bruges i AI-prompt */
  description: string;
  /** 2-3 reelle sample-værdier til kontekstualisering */
  sampleValues: (string | number | boolean | null)[];
  /** Hvis true: PII — maskeres i aggregater, må ikke returneres direkte */
  isPii?: boolean;
  /** Foreign key reference til anden tabel/kolonne */
  fk?: { table: string; column: string };
}

/** Typisk join-mønster mellem to tabeller */
export interface JoinPattern {
  /** Mål-tabel for joinet */
  targetTable: string;
  /** SQL ON-clause (uden ON-prefix) */
  on: string;
  /** Beskrivelse af hvornår joinet bruges */
  purpose: string;
}

/** Metadata for én tabel */
export interface TableMeta {
  /** Tabel-navn (uden schema-prefix) */
  name: string;
  /** Schema (typisk 'public') */
  schema: string;
  /** Menneskelig beskrivelse til AI-prompt */
  description: string;
  /** Cirka antal rækker — bruges til query-omkostnings-vurdering */
  rowCountApprox: number;
  /** Primary key-kolonner */
  primaryKey: string[];
  /** Alle kolonner relevante for Data Intelligence */
  columns: ColumnMeta[];
  /** Kuraterede join-stier */
  commonJoins: JoinPattern[];
}

/**
 * Det fulde schema-katalog for Data Intelligence.
 *
 * Subset af BizzAssist's data-univers — kun tabeller der er meningsfulde for
 * NL → SQL queries. Tenant-tabeller, auth, logs og PII-only-tabeller er
 * ekskluderet bevidst.
 */
export const SCHEMA_CATALOG: TableMeta[] = [
  {
    name: 'cvr_virksomhed',
    schema: 'public',
    description:
      "CVR-registrerede virksomheder. Master-tabel for selskabsdata. Note: INGEN kommune_kode-kolonne — kommune ligger i adresse_json->'kommune'->>'kommuneKode'.",
    rowCountApprox: 2_200_000,
    primaryKey: ['cvr'],
    columns: [
      {
        name: 'cvr',
        type: 'text',
        nullable: false,
        description: '8-cifret CVR-nummer (TEXT — ikke bigint, brug aldrig cast)',
        sampleValues: ['12345678', '24301117', '41092807'],
      },
      {
        name: 'navn',
        type: 'text',
        nullable: true,
        description: 'Virksomhedens registrerede navn',
        sampleValues: ['BizzAssist ApS', 'Belvedere Ejendomme A/S', 'WISCH ApS'],
      },
      {
        name: 'virksomhedsform',
        type: 'text',
        nullable: true,
        description: 'Selskabsform-kode/navn',
        sampleValues: ['Anpartsselskab', 'Aktieselskab', 'Enkeltmandsvirksomhed'],
      },
      {
        name: 'branche_kode',
        type: 'text',
        nullable: true,
        description: 'DB07-branchekode',
        sampleValues: ['561010', '681020', '642010'],
      },
      {
        name: 'branche_tekst',
        type: 'text',
        nullable: true,
        description: 'Branchekode oversat til dansk tekst',
        sampleValues: ['Restaurant', 'Udlejning af erhvervsejendomme', 'Holdingvirksomhed'],
      },
      {
        name: 'stiftet',
        type: 'date',
        nullable: true,
        description: 'Stiftelsesdato',
        sampleValues: ['2020-01-15', '2018-06-30', null],
      },
      {
        name: 'ophoert',
        type: 'date',
        nullable: true,
        description: 'Ophørsdato. NULL = aktiv virksomhed',
        sampleValues: [null, '2024-03-20', null],
      },
      {
        name: 'ansatte_aar',
        type: 'integer',
        nullable: true,
        description:
          'Antal ansatte i seneste registreringsår (BEMÆRK: hedder ansatte_aar, IKKE ansatte)',
        sampleValues: [5, 25, 0],
      },
      {
        name: 'adresse_json',
        type: 'jsonb',
        nullable: true,
        description:
          "Adresse + kommune som JSONB. Adgang: adresse_json->'kommune'->>'kommuneKode'.",
        sampleValues: [
          '{"kommune":{"kommuneKode":"101"}}',
          null,
          '{"kommune":{"kommuneKode":"751"}}',
        ],
      },
    ],
    commonJoins: [
      {
        targetTable: 'public.ejf_ejerskab',
        on: 'cvr_virksomhed.cvr = ejf_ejerskab.ejer_cvr',
        purpose: 'Find ejendomme ejet af en virksomhed',
      },
      {
        targetTable: 'public.regnskab_cache',
        on: 'cvr_virksomhed.cvr = regnskab_cache.cvr',
        purpose: 'Berige med omsætning/resultat/egenkapital',
      },
      {
        targetTable: 'public.kommune_ref',
        on: "(cvr_virksomhed.adresse_json->'kommune'->>'kommuneKode')::int = kommune_ref.kommune_kode",
        purpose: 'Få kommunenavn (kræver JSONB-extract + cast)',
      },
    ],
  },
  {
    name: 'cvr_deltager',
    schema: 'public',
    description:
      'Personer registreret i CVR. PII — navn må ALDRIG returneres i aggregerede svar, kun i specifikke person-detalje-queries.',
    rowCountApprox: 1_800_000,
    primaryKey: ['enhedsnummer'],
    columns: [
      {
        name: 'enhedsnummer',
        type: 'integer',
        nullable: false,
        description: 'Erhvervsstyrelsen-unikt nummer pr. person/enhed',
        sampleValues: [4000115446, 4001768042, 4006181897],
      },
      {
        name: 'navn',
        type: 'text',
        nullable: true,
        description: 'Personens registrerede navn (PII — masker i aggregater)',
        sampleValues: ['Jakob Juul Rasmussen', 'Kamilla Kofoed Led', 'Ole Paul Petersen'],
        isPii: true,
      },
    ],
    commonJoins: [
      {
        targetTable: 'public.cvr_deltagerrelation',
        on: 'cvr_deltager.enhedsnummer = cvr_deltagerrelation.deltager_enhedsnummer',
        purpose: 'Find personens roller i virksomheder',
      },
    ],
  },
  {
    name: 'cvr_deltagerrelation',
    schema: 'public',
    description:
      'Mange-til-mange relation mellem personer og virksomheder med rolletype + ejerandel.',
    rowCountApprox: 8_400_000,
    primaryKey: ['id'],
    columns: [
      {
        name: 'deltager_enhedsnummer',
        type: 'integer',
        nullable: false,
        description: 'FK til cvr_deltager.enhedsnummer',
        sampleValues: [4000115446, 4001768042],
        fk: { table: 'cvr_deltager', column: 'enhedsnummer' },
      },
      {
        name: 'virksomhed_cvr',
        type: 'text',
        nullable: false,
        description: 'FK til cvr_virksomhed.cvr',
        sampleValues: ['12345678', '24301117'],
        fk: { table: 'cvr_virksomhed', column: 'cvr' },
      },
      {
        name: 'type',
        type: 'text',
        nullable: false,
        description: 'Rolletype',
        sampleValues: ['register', 'direktion', 'bestyrelse', 'stifter', 'interessenter'],
      },
      {
        name: 'ejerandel_pct',
        type: 'numeric',
        nullable: true,
        description: 'Ejerandel i procent (kun for type=register/interessenter/indehaver)',
        sampleValues: [100, 50.5, null],
      },
      {
        name: 'gyldig_til',
        type: 'timestamptz',
        nullable: true,
        description: 'Ophør af relationen. NULL = aktiv relation',
        sampleValues: [null, '2024-12-31T23:59:59+00:00'],
      },
    ],
    commonJoins: [],
  },
  {
    name: 'ejf_ejerskab',
    schema: 'public',
    description:
      'Autoritativ ejerskabsdata pr. ejendom (EJF). 7,6M rækker — undgå joins uden filter.',
    rowCountApprox: 7_600_000,
    primaryKey: ['bfe_nummer', 'ejer_ejf_id'],
    columns: [
      {
        name: 'bfe_nummer',
        type: 'bigint',
        nullable: false,
        description: 'Bestemt Fast Ejendomsnummer',
        sampleValues: [2081243, 226629, 237451],
      },
      {
        name: 'ejer_cvr',
        type: 'text',
        nullable: true,
        description: 'Ejer-CVR (TEXT — match direkte mod cvr_virksomhed.cvr)',
        sampleValues: ['24301117', '41092807', null],
        fk: { table: 'cvr_virksomhed', column: 'cvr' },
      },
      {
        name: 'ejer_type',
        type: 'text',
        nullable: false,
        description: 'Ejer-type',
        sampleValues: ['virksomhed', 'person'],
      },
      {
        name: 'ejerandel_taeller',
        type: 'integer',
        nullable: true,
        description: 'Tæller i ejerandels-brøk',
        sampleValues: [1, 50, 100],
      },
      {
        name: 'ejerandel_naevner',
        type: 'integer',
        nullable: true,
        description: 'Nævner i ejerandels-brøk',
        sampleValues: [1, 100, 100],
      },
      {
        name: 'status',
        type: 'text',
        nullable: false,
        description: 'Aktuel status',
        sampleValues: ['gældende', 'historisk'],
      },
      {
        name: 'virkning_fra',
        type: 'timestamptz',
        nullable: true,
        description: 'Hvornår ejerskabet startede (= overtagelsesdato / ejerskifte-dato)',
        sampleValues: ['2020-04-17T22:00:00+00:00', '2023-11-01T22:00:00+00:00'],
      },
    ],
    commonJoins: [
      {
        targetTable: 'public.bbr_ejendom_status',
        on: 'ejf_ejerskab.bfe_nummer = bbr_ejendom_status.bfe_nummer',
        purpose: 'Berige med BBR-data (kommune, areal, energimærke)',
      },
    ],
  },
  {
    name: 'bbr_ejendom_status',
    schema: 'public',
    description: 'BBR-data pr. ejendom — autoritativ for tekniske egenskaber.',
    rowCountApprox: 2_500_000,
    primaryKey: ['bfe_nummer'],
    columns: [
      {
        name: 'bfe_nummer',
        type: 'bigint',
        nullable: false,
        description: 'Bestemt Fast Ejendomsnummer',
        sampleValues: [2081243, 226629],
      },
      {
        name: 'kommune_kode',
        type: 'smallint',
        nullable: true,
        description: 'Kommunenummer (3-cifret)',
        sampleValues: [101, 167, 751],
        fk: { table: 'kommune_ref', column: 'kommune_kode' },
      },
      {
        name: 'is_udfaset',
        type: 'boolean',
        nullable: false,
        description: 'Hvis true: ejendommen er udfaset og bør filtreres væk',
        sampleValues: [false, true],
      },
      {
        name: 'samlet_boligareal',
        type: 'integer',
        nullable: true,
        description: 'Samlet boligareal i m²',
        sampleValues: [120, 250, null],
      },
      {
        name: 'byg021_anvendelse',
        type: 'smallint',
        nullable: true,
        description:
          'BBR-anvendelseskode. 110-190 = beboelse (110=stuehus, 120=parcelhus, 130=rækkehus, 140=etagebolig). 210=erhverv. 510=fritidshus.',
        sampleValues: [120, 140, 210],
      },
      {
        name: 'opfoerelsesaar',
        type: 'smallint',
        nullable: true,
        description: 'Opførelsesår',
        sampleValues: [1985, 2005, 1920],
      },
      {
        name: 'energimaerke',
        type: 'text',
        nullable: true,
        description: 'Energimærke A-G',
        sampleValues: ['A', 'C', 'G', null],
      },
    ],
    commonJoins: [
      {
        targetTable: 'public.kommune_ref',
        on: 'bbr_ejendom_status.kommune_kode = kommune_ref.kommune_kode',
        purpose: 'Få kommunenavn + region',
      },
      {
        targetTable: 'public.vurdering_cache',
        on: 'bbr_ejendom_status.bfe_nummer = vurdering_cache.bfe_nummer',
        purpose: 'Berige med ejendoms- og grundværdi',
      },
    ],
  },
  {
    name: 'ejerskifte_historik',
    schema: 'public',
    description:
      'Salgs-/handelshistorik beriget med Tinglysning-priser. Brug TIL salgspris-spørgsmål.',
    rowCountApprox: 500_000,
    primaryKey: ['id'],
    columns: [
      {
        name: 'bfe_nummer',
        type: 'bigint',
        nullable: false,
        description: 'BFE-nummer',
        sampleValues: [2081243, 226629],
      },
      {
        name: 'overtagelsesdato',
        type: 'date',
        nullable: true,
        description: 'Ejerskifte-dato',
        sampleValues: ['2024-05-15', '2023-11-01'],
      },
      {
        name: 'kontant_koebesum',
        type: 'bigint',
        nullable: true,
        description: 'Kontant købesum i DKK fra Tinglysning',
        sampleValues: [4_500_000, 7_200_000, null],
      },
      {
        name: 'm2_pris',
        type: 'integer',
        nullable: true,
        description: 'M²-pris = kontant_koebesum / boligareal',
        sampleValues: [35_000, 52_000, null],
      },
      {
        name: 'byg021_anvendelse',
        type: 'smallint',
        nullable: true,
        description: 'BBR-anvendelse for at filtrere på "huse" vs "lejligheder"',
        sampleValues: [120, 140],
      },
      {
        name: 'kommune_kode',
        type: 'smallint',
        nullable: true,
        description: 'Kommunenummer',
        sampleValues: [101, 167],
      },
    ],
    commonJoins: [
      {
        targetTable: 'public.kommune_ref',
        on: 'ejerskifte_historik.kommune_kode = kommune_ref.kommune_kode',
        purpose: 'Få kommunenavn',
      },
    ],
  },
  {
    name: 'vurdering_cache',
    schema: 'public',
    description: 'Offentlig ejendomsvurdering fra Vurderingsstyrelsen.',
    rowCountApprox: 2_400_000,
    primaryKey: ['bfe_nummer'],
    columns: [
      {
        name: 'bfe_nummer',
        type: 'bigint',
        nullable: false,
        description: 'BFE-nummer',
        sampleValues: [2081243, 226629],
      },
      {
        name: 'ejendomsvaerdi',
        type: 'bigint',
        nullable: true,
        description: 'Offentlig ejendomsværdi i DKK',
        sampleValues: [3_500_000, 12_000_000, null],
      },
      {
        name: 'grundvaerdi',
        type: 'bigint',
        nullable: true,
        description: 'Offentlig grundværdi i DKK',
        sampleValues: [800_000, 2_500_000, null],
      },
      {
        name: 'vurderingsaar',
        type: 'integer',
        nullable: true,
        description: 'Vurderingsår',
        sampleValues: [2020, 2024, 2025],
      },
    ],
    commonJoins: [
      {
        targetTable: 'public.bbr_ejendom_status',
        on: 'vurdering_cache.bfe_nummer = bbr_ejendom_status.bfe_nummer',
        purpose: 'Berige med kommune, anvendelse, areal',
      },
    ],
  },
  {
    name: 'regnskab_cache',
    schema: 'public',
    description:
      'Virksomhedsregnskab normaliseret fra seneste år. Brug flade kolonner — IKKE years JSONB direkte.',
    rowCountApprox: 300_000,
    primaryKey: ['cvr'],
    columns: [
      {
        name: 'cvr',
        type: 'text',
        nullable: false,
        description: 'CVR-nummer',
        sampleValues: ['24301117', '41092807'],
        fk: { table: 'cvr_virksomhed', column: 'cvr' },
      },
      {
        name: 'seneste_aar',
        type: 'integer',
        nullable: true,
        description: 'Seneste regnskabsår',
        sampleValues: [2024, 2023],
      },
      {
        name: 'omsaetning',
        type: 'bigint',
        nullable: true,
        description: 'Omsætning i seneste år (DKK)',
        sampleValues: [25_000_000, 1_200_000, null],
      },
      {
        name: 'aarsresultat',
        type: 'bigint',
        nullable: true,
        description: 'Årets resultat (DKK)',
        sampleValues: [3_500_000, -500_000, null],
      },
      {
        name: 'egenkapital',
        type: 'bigint',
        nullable: true,
        description: 'Egenkapital ved årets udgang (DKK)',
        sampleValues: [15_000_000, 250_000, null],
      },
    ],
    commonJoins: [
      {
        targetTable: 'public.cvr_virksomhed',
        on: 'regnskab_cache.cvr = cvr_virksomhed.cvr',
        purpose: 'Berige med virksomhedsnavn + branche',
      },
    ],
  },
  {
    name: 'kommune_ref',
    schema: 'public',
    description: 'Reference for kommunenavne og regioner.',
    rowCountApprox: 99,
    primaryKey: ['kommune_kode'],
    columns: [
      {
        name: 'kommune_kode',
        type: 'integer',
        nullable: false,
        description: 'Kommunenummer (3-cifret)',
        sampleValues: [101, 167, 751],
      },
      {
        name: 'kommunenavn',
        type: 'text',
        nullable: false,
        description: 'Kommunenavn',
        sampleValues: ['København', 'Hvidovre', 'Aarhus'],
      },
      {
        name: 'region',
        type: 'text',
        nullable: false,
        description: 'Region',
        sampleValues: ['Region Hovedstaden', 'Region Midtjylland'],
      },
    ],
    commonJoins: [],
  },

  // ── Virksomhedshandel M&A-radar (BIZZ-1930) ──
  {
    name: 'mv_virksomhedshandel_kandidater',
    schema: 'public',
    description:
      'Materialized view over ejerskabsændringer (entry/exit/increase/decrease) detekteret via window-functions på mv_deltager_beriget. Bruges til M&A-radar.',
    rowCountApprox: 609000,
    primaryKey: ['deltager_enhedsnummer', 'virksomhed_cvr', 'gyldig_fra'],
    columns: [
      {
        name: 'deltager_enhedsnummer',
        type: 'bigint',
        nullable: false,
        description: 'Enhedsnummer for deltager (person/virksomhed)',
        sampleValues: [4009876543, 4001234567],
      },
      {
        name: 'deltager_navn',
        type: 'text',
        nullable: true,
        description: 'Navn på deltager',
        sampleValues: ['Anders Jensen', 'Holding ApS'],
        isPii: true,
      },
      {
        name: 'virksomhed_cvr',
        type: 'text',
        nullable: false,
        description: 'CVR-nummer på target-virksomheden',
        sampleValues: ['12345678', '87654321'],
      },
      {
        name: 'relation_type',
        type: 'text',
        nullable: false,
        description: 'Relationstype: register, reel_ejer, eller interessenter',
        sampleValues: ['register', 'reel_ejer'],
      },
      {
        name: 'current_ejerandel_pct',
        type: 'numeric',
        nullable: true,
        description: 'Nuværende ejerandel i procent',
        sampleValues: [100, 50, 25],
      },
      {
        name: 'prev_ejerandel_pct',
        type: 'numeric',
        nullable: true,
        description: 'Tidligere ejerandel i procent (0 hvis ny ejer)',
        sampleValues: [0, 50, 75],
      },
      {
        name: 'gyldig_fra',
        type: 'timestamptz',
        nullable: true,
        description: 'Start-dato for ejerskabet',
        sampleValues: ['2025-03-15', '2024-01-01'],
      },
      {
        name: 'gyldig_til',
        type: 'timestamptz',
        nullable: true,
        description: 'Slut-dato (sat ved exit/fratræden)',
        sampleValues: [null, '2025-06-30'],
      },
      {
        name: 'signal_type',
        type: 'text',
        nullable: false,
        description: 'Type af ejerskabsændring: entry, exit, increase, decrease, unchanged',
        sampleValues: ['entry', 'exit', 'increase'],
      },
    ],
    commonJoins: [
      {
        targetTable: 'cvr_virksomhed',
        on: 'cvr_virksomhed.cvr = mv_virksomhedshandel_kandidater.virksomhed_cvr',
        purpose: 'Hent virksomhedsnavn, branche, status for target-virksomheden',
      },
      {
        targetTable: 'regnskab_cache',
        on: 'regnskab_cache.cvr = mv_virksomhedshandel_kandidater.virksomhed_cvr',
        purpose: 'Hent omsætning/årsresultat for værdiansættelse',
      },
    ],
  },
];

/**
 * Få tabel-metadata efter navn.
 *
 * @param name - Tabel-navn (uden schema-prefix)
 * @returns TableMeta eller undefined
 */
export function getTableMeta(name: string): TableMeta | undefined {
  return SCHEMA_CATALOG.find((t) => t.name === name);
}

/**
 * Generer en kort tekst-beskrivelse af kataloget til AI-prompt.
 * Inkluderer kun tabelnavne + beskrivelse + kolonnenavne+typer for kompakthed.
 *
 * @returns Markdown-formatteret oversigt
 */
export function formatCatalogShort(): string {
  return SCHEMA_CATALOG.map((t) => {
    const cols = t.columns
      .map((c) => `  - ${c.name} (${c.type}${c.nullable ? '?' : ''})${c.isPii ? ' [PII]' : ''}`)
      .join('\n');
    return `### ${t.schema}.${t.name} (~${t.rowCountApprox.toLocaleString('da-DK')} rækker)\n${t.description}\nKolonner:\n${cols}`;
  }).join('\n\n');
}
