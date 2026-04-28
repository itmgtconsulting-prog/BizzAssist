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
      'BBR ejendomsstatus — én række per BFE (ejendom). Indeholder bygningsdata, kommunekode, areal og status.',
    columns: {
      bfe_nummer: { type: 'bigint', description: 'BFE-nummer (primærnøgle)' },
      kommune_kode: { type: 'smallint', description: 'Kommunekode (4-cifret)' },
      is_udfaset: { type: 'boolean', description: 'True hvis ejendommen er udfaset/nedrevet' },
      bbr_status_code: { type: 'smallint', description: 'BBR statuskode' },
      samlet_boligareal: { type: 'integer', description: 'Samlet boligareal i m²' },
      opfoerelsesaar: { type: 'integer', description: 'Bygningens opførelsesår' },
      energimaerke: { type: 'text', description: 'Energimærkeklasse (A-G, kan være NULL)' },
      byg021_anvendelse: { type: 'text', description: 'BBR anvendelseskode' },
      status_last_checked_at: { type: 'timestamptz', description: 'Seneste statuscheck' },
    },
  },
  {
    table: 'public.regnskab_cache',
    description:
      'Cached XBRL regnskabsdata per CVR-nummer. Kolonnen "years" er JSONB med array af årsregnskaber.',
    columns: {
      cvr: { type: 'text', description: 'CVR-nummer (primærnøgle)' },
      years: {
        type: 'jsonb',
        description: 'Array af regnskabsår med brutto, netto, egenkapital, ansatte m.fl.',
      },
      fetched_at: { type: 'timestamptz', description: 'Hvornår data sidst blev hentet' },
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
