/**
 * analyseQueryWhitelist — tilladte tabeller og kolonner for AI Query Builder.
 *
 * BIZZ-1038: AI-genereret SQL valideres mod denne whitelist.
 * Kun de specificerede tabeller og kolonner kan forespørges.
 * Alle queries scopes via RLS (service role for public cache tables).
 *
 * @module app/lib/analyseQueryWhitelist
 */

/** Definition af en tilgængelig tabel i query builder */
export interface WhitelistedTable {
  /** Fuldt kvalificeret tabelnavn (schema.table) */
  table: string;
  /** Dansk beskrivelse til Claude's system prompt */
  description: string;
  /** Tilladte kolonner med typer og beskrivelser */
  columns: Record<string, { type: string; description: string }>;
}

/**
 * Whitelist af tabeller og kolonner der kan bruges i AI Query Builder.
 *
 * SIKKERHED: AI-genereret SQL valideres mod denne liste.
 * Tilføj aldrig tabeller med PII (brugerdata, sessions, auth).
 */
export const WHITELISTED_TABLES: WhitelistedTable[] = [
  {
    table: 'public.bbr_ejendom_status',
    description:
      'BBR ejendomsstatus — én række per BFE (ejendom). 2,5M+ rækker. Indeholder bygningsdata, kommunekode, areal og status. BEMÆRK: kommune_kode, energimaerke og samlet_boligareal kan være NULL — filtrer altid med IS NOT NULL ved aggregering.',
    columns: {
      bfe_nummer: { type: 'bigint', description: 'BFE-nummer (primærnøgle)' },
      kommune_kode: {
        type: 'smallint',
        description: 'Kommunekode (4-cifret, kan være NULL — filtrer med IS NOT NULL)',
      },
      is_udfaset: { type: 'boolean', description: 'True hvis ejendommen er udfaset/nedrevet' },
      bbr_status_code: { type: 'smallint', description: 'BBR statuskode' },
      samlet_boligareal: {
        type: 'integer',
        description: 'Samlet boligareal i m² (kan være NULL)',
      },
      opfoerelsesaar: { type: 'integer', description: 'Bygningens opførelsesår (kan være NULL)' },
      energimaerke: {
        type: 'text',
        description: 'Energimærkeklasse (A2015, B2015, C2015... eller A, B, C... kan være NULL)',
      },
      byg021_anvendelse: { type: 'text', description: 'BBR anvendelseskode' },
      status_last_checked_at: { type: 'timestamptz', description: 'Seneste statuscheck' },
    },
  },
  {
    table: 'public.cvr_virksomhed',
    description:
      'CVR-registrerede virksomheder — 2,1M+ rækker. Indeholder grunddata, branche, ansatte, status og stiftelsesdato.',
    columns: {
      cvr: { type: 'text', description: 'CVR-nummer (primærnøgle, 8 cifre)' },
      navn: { type: 'text', description: 'Virksomhedens navn' },
      status: {
        type: 'text',
        description: 'Status: NORMAL, OPHØRT, UNDER_KONKURS, TVANGSOPLØST, etc.',
      },
      branche_kode: { type: 'text', description: 'DB07 branchekode (6 cifre)' },
      branche_tekst: { type: 'text', description: 'Branchebeskrivelse på dansk' },
      virksomhedsform: {
        type: 'text',
        description: 'Selskabsform: APS, AS, IVS, ENK, PMV, SOV, etc.',
      },
      stiftet: { type: 'date', description: 'Stiftelsesdato' },
      ophoert: { type: 'date', description: 'Ophørsdato (NULL hvis aktiv)' },
      ansatte_aar: { type: 'integer', description: 'Antal årsansatte (kan være NULL)' },
      sidst_opdateret: { type: 'timestamptz', description: 'Senest opdateret fra CVR' },
    },
  },
  {
    table: 'public.cvr_virksomhed_ejerskab',
    description:
      'Ejerskabsrelationer — 333K+ rækker. Hvem ejer hvilke virksomheder (CVR→CVR og person→CVR).',
    columns: {
      cvr: { type: 'text', description: 'Ejet virksomheds CVR-nummer' },
      ejer_cvr: { type: 'text', description: 'Ejer-virksomheds CVR (NULL ved person-ejer)' },
      ejer_enheds_nummer: {
        type: 'bigint',
        description: 'Ejer-persons enhedsNummer (NULL ved virksomheds-ejer)',
      },
      ejer_navn: { type: 'text', description: 'Ejers navn' },
      andel_pct: { type: 'numeric', description: 'Ejerandel i procent (kan være NULL)' },
      sidst_opdateret: { type: 'timestamptz', description: 'Senest opdateret' },
    },
  },
  {
    table: 'public.ejf_ejerskab',
    description: 'Ejendomsejerskab fra EJF — 7,6M+ rækker. Hvem ejer hvilke ejendomme (BFE).',
    columns: {
      bfe_nummer: { type: 'bigint', description: 'BFE-nummer (ejendom)' },
      ejer_navn: { type: 'text', description: 'Ejers navn' },
      ejer_cvr: { type: 'text', description: 'Ejers CVR-nummer (NULL ved person-ejer)' },
      ejer_type: {
        type: 'text',
        description: 'Ejertype: Personligt ejet, Selskab, Kommune, Region, Stat, etc.',
      },
      ejerandel_taeller: { type: 'integer', description: 'Ejerandel tæller (fx 1 af 2)' },
      ejerandel_naevner: { type: 'integer', description: 'Ejerandel nævner (fx 2)' },
      status: { type: 'text', description: 'Status: Aktiv, Historisk' },
      virkning_fra: { type: 'timestamptz', description: 'Ejerskab gældende fra' },
      sidst_opdateret: { type: 'timestamptz', description: 'Senest opdateret fra EJF' },
    },
  },
  {
    table: 'public.regnskab_cache',
    description:
      'Cached XBRL regnskabsdata per CVR-nummer — 143 rækker. Kolonnen "years" er JSONB med array af årsregnskaber.',
    columns: {
      cvr: { type: 'text', description: 'CVR-nummer (primærnøgle)' },
      years: {
        type: 'jsonb',
        description: 'Array af regnskabsår med brutto, netto, egenkapital, ansatte m.fl.',
      },
      fetched_at: { type: 'timestamptz', description: 'Hvornår data sidst blev hentet' },
    },
  },
  {
    table: 'public.mv_analyse_ejendom',
    description:
      'Unified ejendomsanalyse-view — ~46K aktive ejendomme. Joiner BBR + ejer + virksomhed + kommune + anvendelse i én flad tabel. Refreshes nightly. Brug til geografi, areal, ejertype og anvendelsesanalyser.',
    columns: {
      bfe_nummer: { type: 'bigint', description: 'BFE-nummer (primærnøgle)' },
      boligareal_m2: { type: 'integer', description: 'Samlet boligareal i m²' },
      opfoerelsesaar: { type: 'smallint', description: 'Bygningens opførelsesår' },
      energimaerke: { type: 'text', description: 'Energimærkeklasse (A2015, B, C, D...)' },
      anvendelse_kode: { type: 'smallint', description: 'BBR byg021 anvendelseskode' },
      anvendelse_tekst: {
        type: 'text',
        description: 'Anvendelsestype på dansk (fx "Parcelhus", "Lejlighed")',
      },
      anvendelse_kategori: {
        type: 'text',
        description: 'Kategori: bolig, erhverv, institution, andet',
      },
      kommune_kode: { type: 'smallint', description: 'Kommunekode (4-cifret)' },
      kommunenavn: { type: 'text', description: 'Kommunenavn (fx "Hvidovre", "Aarhus")' },
      region: {
        type: 'text',
        description: 'Region (Hovedstaden, Sjælland, Syddanmark, Midtjylland, Nordjylland)',
      },
      ejer_navn: { type: 'text', description: 'Ejers navn' },
      ejer_type: { type: 'text', description: 'Ejertype: Personligt ejet, Selskab, Kommune, Stat' },
      ejer_cvr: { type: 'text', description: 'Ejers CVR-nummer (NULL for privatpersoner)' },
      ejerandel_pct: { type: 'numeric', description: 'Ejerandel i procent' },
      virksomhed_navn: { type: 'text', description: 'Virksomhedsejerens navn' },
      virksomhed_branche: { type: 'text', description: 'Virksomhedsejerens branche' },
      virksomhed_form: { type: 'text', description: 'Virksomhedsform (APS, AS, etc.)' },
      virksomhed_ansatte: { type: 'integer', description: 'Antal ansatte i ejervirksomheden' },
    },
  },
  {
    table: 'public.mv_analyse_virksomhed',
    description:
      'Unified virksomhedsanalyse-view — 2,1M+ virksomheder med antal ejede ejendomme. Refreshes nightly. Brug til branche, selskabsform og ejendomsportefølje-analyser.',
    columns: {
      cvr: { type: 'text', description: 'CVR-nummer (primærnøgle)' },
      navn: { type: 'text', description: 'Virksomhedens navn' },
      branche_kode: { type: 'text', description: 'DB07 branchekode (6 cifre)' },
      branche_tekst: { type: 'text', description: 'Branchebeskrivelse på dansk' },
      virksomhedsform: { type: 'text', description: 'Selskabsform: APS, AS, IVS, ENK, etc.' },
      status: { type: 'text', description: 'Status: NORMAL, OPHØRT, UNDER_KONKURS, etc.' },
      stiftet: { type: 'date', description: 'Stiftelsesdato' },
      ophoert: { type: 'date', description: 'Ophørsdato (NULL hvis aktiv)' },
      ansatte: { type: 'integer', description: 'Antal årsansatte' },
      antal_ejendomme: { type: 'integer', description: 'Antal ejede ejendomme (fra EJF)' },
    },
  },
  {
    table: 'public.vurdering_cache',
    description:
      'Ejendomsvurderinger — cached fra Datafordeler VUR. Normaliserede kolonner for ejendomsværdi, grundværdi, vurderingsår. BIZZ-1274.',
    columns: {
      bfe_nummer: { type: 'bigint', description: 'BFE-nummer (primærnøgle)' },
      ejendomsvaerdi: { type: 'bigint', description: 'Offentlig ejendomsværdi i DKK' },
      grundvaerdi: { type: 'bigint', description: 'Grundværdi i DKK' },
      vurderingsaar: { type: 'integer', description: 'Vurderingsår (fx 2024)' },
      benyttelseskode: { type: 'text', description: 'Benyttelseskode' },
      grundskyldspromille: { type: 'numeric', description: 'Grundskyldspromille (‰)' },
      bebyggelsesprocent: { type: 'numeric', description: 'Bebyggelsesprocent (0-100)' },
    },
  },
  {
    table: 'public.cvr_historik',
    description:
      'CVR ændringshistorik — alle ændringer for virksomheder (navn, adresse, status, branche, form, fusion, spaltning). BIZZ-1277.',
    columns: {
      cvr: { type: 'text', description: 'CVR-nummer' },
      felt: {
        type: 'text',
        description: 'Felt: navn, adresse, status, branche, form, fusion, spaltning',
      },
      vaerdi_fra: { type: 'text', description: 'Gammel værdi' },
      vaerdi_til: { type: 'text', description: 'Ny værdi' },
      gyldig_fra: { type: 'date', description: 'Ændring gyldig fra dato' },
      gyldig_til: { type: 'date', description: 'Ændring gyldig til dato (NULL = aktuel)' },
    },
  },
  {
    table: 'public.kommune_ref',
    description:
      'Kommune-lookup — 98 kommuner med kode, navn og region. Brug til at oversætte kommunekoder til navne.',
    columns: {
      kommune_kode: { type: 'smallint', description: 'Kommunekode (primærnøgle, 4 cifre)' },
      kommunenavn: { type: 'text', description: 'Kommunenavn' },
      region: {
        type: 'text',
        description: 'Region (Hovedstaden, Sjælland, Syddanmark, Midtjylland, Nordjylland)',
      },
    },
  },
];

/**
 * Genererer SQL schema-beskrivelse til Claude's system prompt.
 *
 * @returns Formateret tekstbeskrivelse af alle tilgængelige tabeller
 */
export function generateSchemaDescription(): string {
  return WHITELISTED_TABLES.map((t) => {
    const cols = Object.entries(t.columns)
      .map(([name, { type, description }]) => `  - ${name} (${type}): ${description}`)
      .join('\n');
    return `TABLE: ${t.table}\n  ${t.description}\n  Kolonner:\n${cols}`;
  }).join('\n\n');
}

/**
 * Validerer at en SQL-query kun bruger tilladte tabeller og kolonner.
 *
 * SIMPEL validering — tjekker at alle FROM/JOIN targets er whitelistede
 * og at der ikke er destruktive operationer.
 *
 * @param sql - SQL-query der skal valideres
 * @returns Fejlbesked eller null hvis valid
 */
export function validateQuery(sql: string): string | null {
  const upper = sql.toUpperCase().trim();

  /* Blokér destruktive operationer */
  const forbidden = [
    'INSERT',
    'UPDATE',
    'DELETE',
    'DROP',
    'ALTER',
    'CREATE',
    'TRUNCATE',
    'GRANT',
    'REVOKE',
  ];
  for (const kw of forbidden) {
    if (upper.startsWith(kw) || new RegExp(`\\b${kw}\\b`).test(upper)) {
      return `Forbudt operation: ${kw}. Kun SELECT er tilladt.`;
    }
  }

  if (!upper.startsWith('SELECT')) {
    return 'Kun SELECT-queries er tilladt.';
  }

  /* Tjek at alle refererede tabeller er whitelistede */
  const allowedTables = WHITELISTED_TABLES.map((t) => t.table.toLowerCase());
  const allowedTableNames = WHITELISTED_TABLES.map((t) => t.table.split('.')[1].toLowerCase());

  /* Simpel FROM/JOIN extraction */
  const tableRefs = sql.match(/(?:FROM|JOIN)\s+([a-zA-Z_.]+)/gi) ?? [];
  for (const ref of tableRefs) {
    const tableName = ref
      .replace(/^(?:FROM|JOIN)\s+/i, '')
      .toLowerCase()
      .trim();
    if (!allowedTables.includes(tableName) && !allowedTableNames.includes(tableName)) {
      return `Tabel "${tableName}" er ikke tilladt. Tilladte tabeller: ${allowedTables.join(', ')}`;
    }
  }

  return null;
}
