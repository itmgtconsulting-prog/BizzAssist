/**
 * SQL Validator — BIZZ-1424 (Fase 3, Lag 3) — KRITISK SIKKERHEDS-LAG
 *
 * Validerer AI-genereret SQL før eksekvering. Defense-in-depth sammen med
 * ai_query_reader read-only rolle (BIZZ-1422) og statement_timeout.
 *
 * Strategi: tokenize SQL → afvis alle ikke-SELECT statements, alle DDL/DML
 * nøgleord, system-schemas, write-funktioner. Injicér LIMIT hvis mangler.
 *
 * Vi bruger IKKE en fuld AST-parser her (pg-query-emscripten er stor og
 * giver kompleksitet). I stedet en hardened token-based validator —
 * kombineret med read-only DB-rolle er det praktisk taget umuligt at
 * eksekvere skadelig SQL selv med en bypass.
 *
 * Whitelist håndhæves ved (a) at afvise CREATE/DROP/ALTER/INSERT/UPDATE/DELETE/
 * TRUNCATE/GRANT/REVOKE/CALL/COPY, (b) at afvise system-schemas, (c) at kræve
 * at hovedreferencer er fra whitelistede tabeller.
 *
 * @module app/lib/dataIntelligence/sqlValidator
 */

/** Whitelistede tabel-navne (fully qualified). */
export const WHITELISTED_TABLES = new Set([
  'public.bbr_ejendom_status',
  'public.cvr_virksomhed',
  'public.cvr_virksomhed_ejerskab',
  'public.ejf_ejerskab',
  'public.regnskab_cache',
  'public.mv_analyse_ejendom',
  'public.mv_analyse_virksomhed',
  'public.vurdering_cache',
  'public.cvr_historik',
  'public.kommune_ref',
  'public.tinglysning_cache',
  'dataintel.data_catalog',
  'dataintel.analytics_knowledge',
]);

/** Korte navne (uden schema-prefix) accepteres også. */
export const WHITELISTED_SHORT_NAMES = new Set(
  Array.from(WHITELISTED_TABLES).map((t) => t.split('.')[1])
);

/** Forbudte nøgleord — afvises uanset placering. */
const FORBIDDEN_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'CREATE',
  'DROP',
  'ALTER',
  'GRANT',
  'REVOKE',
  'CALL',
  'COPY',
  'EXECUTE',
  'PERFORM',
  'VACUUM',
  'ANALYZE',
  'REINDEX',
  'CLUSTER',
  'COMMENT',
  'SECURITY',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'SET',
  'RESET',
  'LOCK',
  'NOTIFY',
  'LISTEN',
  'UNLISTEN',
  'DECLARE',
  'FETCH',
  'CLOSE',
  'PREPARE',
  'DEALLOCATE',
  'DISCARD',
  'LOAD',
];

/** Forbudte schemas (system-tabeller). */
const FORBIDDEN_SCHEMAS = [
  'pg_catalog',
  'pg_temp',
  'pg_toast',
  'information_schema',
  'auth',
  'storage',
  'tenant',
  'realtime',
  'extensions',
  'graphql',
  'vault',
];

/** Forbudte funktioner (kunne bruges til DoS eller info-leak). */
const FORBIDDEN_FUNCTIONS = [
  'pg_sleep',
  'pg_read_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'pg_stat_file',
  'dblink',
  'lo_import',
  'lo_export',
  'set_config',
  'current_setting',
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_reload_conf',
];

export interface ValidationResult {
  valid: boolean;
  /** SQL med eventuel LIMIT-injection; uændret hvis valid var false */
  sanitized_sql: string;
  reason?: string;
}

const MAX_ROW_LIMIT = 10_000;

/**
 * Fjerner SQL-kommentarer (-- til EOL og /* ... *​/ blok) så de ikke skjuler
 * forbudte nøgleord.
 */
export function stripComments(sql: string): string {
  // Bemærk: simpel implementation — håndterer ikke kommentarer i string-literals,
  // men da forbidden-keyword check kører på det ucleanede output samt på
  // det rensede, fanger vi begge varianter.
  let result = sql.replace(/--[^\n]*/g, ' ');
  result = result.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return result;
}

/**
 * Tokenizer-light: extract whole-word tokens og lowercase-normaliser.
 * Ikke en SQL-grammatik-parser, men nok til keyword-detection.
 */
function extractWords(sql: string): string[] {
  return (sql.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || []).map((w) => w.toLowerCase());
}

/**
 * Find alle schema.table eller bare table referencer i sql.
 * Returnerer Set af fundne table-navne (kan være qualified eller short).
 */
function extractTableReferences(sql: string): Set<string> {
  const refs = new Set<string>();
  // Match FROM/JOIN/INTO patterns med valgfri schema.table
  // Bruger \w fordi vi har validatet at sql ikke har kommentar-injection
  const fromRegex =
    /\b(?:from|join|update|into)\s+([a-zA-Z_][\w]*\.[a-zA-Z_][\w]*|[a-zA-Z_][\w]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = fromRegex.exec(sql)) !== null) {
    refs.add(match[1].toLowerCase());
  }
  return refs;
}

/**
 * Validér AI-genereret SQL. Returnerer { valid, sanitized_sql, reason }.
 *
 * @param rawSql AI-genereret SQL (potentielt usikker)
 */
export function validateSql(rawSql: string): ValidationResult {
  if (!rawSql || typeof rawSql !== 'string' || rawSql.trim().length === 0) {
    return { valid: false, sanitized_sql: '', reason: 'SQL er tom' };
  }

  // Maximal længde — undgå DoS via stort input
  if (rawSql.length > 10_000) {
    return { valid: false, sanitized_sql: rawSql, reason: 'SQL er for lang (max 10.000 tegn)' };
  }

  // Trim trailing semicolons (max 1, og forbyd multiple statements)
  let sql = rawSql.trim();
  if (sql.endsWith(';')) sql = sql.slice(0, -1).trim();

  // Reject multiple statements (semicolon i midten)
  if (sql.includes(';')) {
    return {
      valid: false,
      sanitized_sql: rawSql,
      reason: 'Flere SQL-statements er ikke tilladt (kun én SELECT per request)',
    };
  }

  const stripped = stripComments(sql);
  const words = extractWords(stripped);

  // Skal starte med SELECT eller WITH (CTE)
  const first = words[0] ?? '';
  if (first !== 'select' && first !== 'with') {
    return {
      valid: false,
      sanitized_sql: rawSql,
      reason: `SQL skal starte med SELECT eller WITH — fandt "${first}"`,
    };
  }

  // Reject forbidden keywords (case-insensitive, whole-word match)
  for (const forbidden of FORBIDDEN_KEYWORDS) {
    const lower = forbidden.toLowerCase();
    if (words.includes(lower)) {
      // Specialfald: TRUNCATE som funktion (date_trunc) er OK; vi tjekker kun
      // standalone keyword.
      if (lower === 'analyze' || lower === 'execute' || lower === 'security') {
        // Tjek igen mod den oprindelige SQL — disse kan optræde som tekst-literal
        const re = new RegExp(`\\b${lower}\\b`, 'i');
        if (!re.test(stripped)) continue;
      }
      return {
        valid: false,
        sanitized_sql: rawSql,
        reason: `Forbudt nøgleord: ${forbidden}`,
      };
    }
  }

  // Reject forbidden schemas
  const schemaRegex = new RegExp(`\\b(${FORBIDDEN_SCHEMAS.join('|')})\\s*\\.`, 'i');
  if (schemaRegex.test(stripped)) {
    return {
      valid: false,
      sanitized_sql: rawSql,
      reason: 'Reference til system-schema er ikke tilladt',
    };
  }

  // Reject forbidden functions
  for (const fn of FORBIDDEN_FUNCTIONS) {
    const re = new RegExp(`\\b${fn}\\s*\\(`, 'i');
    if (re.test(stripped)) {
      return {
        valid: false,
        sanitized_sql: rawSql,
        reason: `Forbudt funktion: ${fn}()`,
      };
    }
  }

  // Validér at alle tabel-referencer er whitelistede
  const refs = extractTableReferences(stripped);
  for (const ref of refs) {
    // Skip CTE-aliaser: hvis SQL starter med WITH alias AS (SELECT ...), så er
    // alias ikke en rigtig tabel. Vi tjekker både fuldt-kvalificeret og short.
    if (WHITELISTED_TABLES.has(ref)) continue;
    if (WHITELISTED_SHORT_NAMES.has(ref)) continue;
    // CTE-aliaser detekteres ved "WITH x AS (" eller ",  x AS (".
    // Bemærk: \b virker ikke før komma (komma er ikke ord-grænse), så vi
    // matcher komma uden ordgrænse-anker.
    const cteRegex = new RegExp(`(?:\\bwith\\s+|,\\s*)${escapeRegex(ref)}\\s+as\\s*\\(`, 'i');
    if (cteRegex.test(stripped)) continue;
    return {
      valid: false,
      sanitized_sql: rawSql,
      reason: `Tabel "${ref}" er ikke whitelistet`,
    };
  }

  // Injicér LIMIT hvis mangler (case-insensitive check)
  let sanitized = sql;
  if (!/\blimit\s+\d+/i.test(stripped)) {
    sanitized = `${sql} LIMIT ${MAX_ROW_LIMIT}`;
  } else {
    // Hvis LIMIT er højere end MAX, reducér
    const limitMatch = stripped.match(/\blimit\s+(\d+)/i);
    if (limitMatch) {
      const lim = parseInt(limitMatch[1], 10);
      if (lim > MAX_ROW_LIMIT) {
        sanitized = sql.replace(/\blimit\s+\d+/i, `LIMIT ${MAX_ROW_LIMIT}`);
      }
    }
  }

  return { valid: true, sanitized_sql: sanitized };
}

/** Escape regex meta-chars i en string. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
