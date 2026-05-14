/**
 * Data Catalog Builder — BIZZ-1407 (Fase 1, Lag 1)
 *
 * Populerer dataintel.data_catalog med metadata om whitelistede tabeller.
 * Bruger PostgreSQL's egne `pg_stats` system-stats hvor muligt (genereret
 * af ANALYZE) for at undgå dyre TABLESAMPLE-scans på 2,5M+ rækker tabeller.
 *
 * Datakilder:
 *   - pg_class.reltuples → row_count estimat (instant)
 *   - pg_stats.null_frac → null_count beregnet via reltuples
 *   - pg_stats.n_distinct → distinct_count (estimat)
 *   - pg_stats.most_common_vals + most_common_freqs → top_values
 *   - pg_stats.histogram_bounds → min/max approximation
 *
 * For PII-kolonner skippes top_values.
 *
 * SQL eksekveres via Supabase Management API (SUPABASE_ACCESS_TOKEN), så
 * builder kører ens på dev/test/prod uden særlige connection-strings.
 * PROJECT_REF udledes fra NEXT_PUBLIC_SUPABASE_URL.
 *
 * @module app/lib/dataIntelligence/buildCatalog
 */

import { logger } from '@/app/lib/logger';

/** En catalog-række klar til UPSERT i dataintel.data_catalog. */
export interface CatalogRow {
  table_schema: string;
  table_name: string;
  /** '' for tabel-niveau row med row_count. Ellers kolonne-niveau. */
  column_name: string;
  data_type: string | null;
  row_count: number | null;
  null_count: number | null;
  distinct_count: number | null;
  top_values: Array<{ value: string; freq: number }> | null;
  min_value: string | null;
  max_value: string | null;
  semantic_label: string | null;
  pii_flag: boolean;
}

/** Tabelliste til catalog-build — udvalg fra analyseQueryWhitelist. */
export const CATALOG_TABLES: Array<{
  schema: string;
  table: string;
  /** Kolonner der skal cataloges. */
  columns: string[];
  /** Kolonner der indeholder PII — top_values genereres ikke. */
  piiColumns: string[];
  /** Semantiske labels for udvalgte kolonner. */
  semanticLabels?: Record<string, string>;
}> = [
  {
    schema: 'public',
    table: 'cvr_virksomhed',
    columns: [
      'status',
      'kommune_kode',
      'branche_kode',
      'virksomhedsform',
      'stiftet',
      'ophoert',
      'ansatte_aar',
      'hvidvask_omfattet',
      'revision_fravalgt',
    ],
    piiColumns: ['navn', 'formaal', 'branche_tekst', 'bibranche1_tekst'],
    semanticLabels: {
      kommune_kode: 'kommunekode',
      branche_kode: 'DB07-branchekode',
    },
  },
  {
    schema: 'public',
    table: 'bbr_ejendom_status',
    columns: [
      'kommune_kode',
      'is_udfaset',
      'bbr_status_code',
      'samlet_boligareal',
      'opfoerelsesaar',
      'energimaerke',
      'byg021_anvendelse',
      'antal_etager',
      'antal_boligenheder',
      'tagmateriale',
      'ydervaeg_materiale',
      'varmeinstallation',
      'opvarmningsform',
      'ejerforholdskode',
    ],
    piiColumns: [],
    semanticLabels: {
      kommune_kode: 'kommunekode',
      byg021_anvendelse: 'BBR-anvendelseskode',
    },
  },
  {
    schema: 'public',
    table: 'cvr_virksomhed_ejerskab',
    columns: ['cvr', 'ejer_cvr', 'andel_pct'],
    piiColumns: ['ejer_navn'],
  },
  {
    schema: 'public',
    table: 'ejf_ejerskab',
    columns: ['ejer_type', 'status', 'ejerandel_taeller', 'ejerandel_naevner', 'virkning_fra'],
    piiColumns: ['ejer_navn'],
  },
  {
    schema: 'public',
    table: 'vurdering_cache',
    columns: [
      'ejendomsvaerdi',
      'grundvaerdi',
      'vurderingsaar',
      'benyttelseskode',
      'grundskyldspromille',
      'bebyggelsesprocent',
    ],
    piiColumns: [],
  },
  {
    schema: 'public',
    table: 'cvr_historik',
    columns: ['felt', 'gyldig_fra', 'gyldig_til'],
    piiColumns: ['vaerdi_fra', 'vaerdi_til'],
  },
  {
    schema: 'public',
    table: 'kommune_ref',
    columns: ['kommune_kode', 'kommunenavn', 'region'],
    piiColumns: [],
  },
  {
    schema: 'public',
    table: 'mv_analyse_ejendom',
    columns: [
      'kommune_kode',
      'kommunenavn',
      'region',
      'anvendelse_kategori',
      'anvendelse_kode',
      'opfoerelsesaar',
      'energimaerke',
      'ejer_type',
      'virksomhed_form',
    ],
    piiColumns: ['ejer_navn', 'virksomhed_navn'],
  },
  {
    schema: 'public',
    table: 'mv_analyse_virksomhed',
    columns: ['branche_kode', 'virksomhedsform', 'status', 'stiftet', 'ophoert'],
    piiColumns: ['navn'],
  },
];

/** SQL-eksekutor — kalder Supabase Management API. */
export type SqlRunner = (sql: string) => Promise<Array<Record<string, unknown>>>;

/**
 * Standard SQL-runner via Supabase Management API.
 * PROJECT_REF udledes fra NEXT_PUBLIC_SUPABASE_URL (https://{ref}.supabase.co).
 */
export function createDefaultSqlRunner(): SqlRunner {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const match = supabaseUrl.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/);
  const projectRef = match ? match[1] : '';
  if (!token || !projectRef) {
    throw new Error(
      'SUPABASE_ACCESS_TOKEN eller NEXT_PUBLIC_SUPABASE_URL ikke konfigureret — kan ikke køre catalog builder'
    );
  }
  return async (sql: string) => {
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
      // 75s timeout — længere end Vercel's per-request limit (60-90s) skal undgås,
      // men 60s var for kort for ejf_ejerskab joins (7.6M rækker).
      signal: AbortSignal.timeout(75_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SQL RPC failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    return Array.isArray(json) ? json : [];
  };
}

interface PgStatsRow {
  attname: string;
  null_frac: number | string;
  n_distinct: number | string;
  most_common_vals: string | null;
  most_common_freqs: string | null;
  histogram_bounds: string | null;
}

/**
 * Parse Postgres array-literal "{a,b,c}" til JS string-array.
 * Håndterer simple værdier (tal, enums); fjerner omgivende quotes.
 */
export function parsePgArray(input: string | null): string[] {
  if (!input || input === 'NULL') return [];
  const m = input.match(/^\{(.*)\}$/);
  if (!m) return [];
  const inner = m[1];
  if (inner === '') return [];
  return inner.split(',').map((s) => s.replace(/^"(.*)"$/, '$1').trim());
}

/** Escape single-quotes for SQL string-literals. */
function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Henter row-count estimat fra pg_class.reltuples (microsec).
 * Falder tilbage til 0 hvis tabellen ikke findes.
 */
async function fetchRowCount(rpc: SqlRunner, schema: string, table: string): Promise<number> {
  const rows = await rpc(
    `SELECT c.reltuples::bigint AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${sqlEscape(schema)}' AND c.relname = '${sqlEscape(table)}' LIMIT 1`
  );
  const n = rows[0]?.n;
  return typeof n === 'number' ? n : Number(n ?? 0);
}

/** Henter pg_stats for udvalgte kolonner. */
async function fetchPgStats(
  rpc: SqlRunner,
  schema: string,
  table: string,
  columns: string[]
): Promise<Map<string, PgStatsRow>> {
  const colList = columns.map((c) => `'${sqlEscape(c)}'`).join(',');
  const sql = `SELECT attname, null_frac, n_distinct, most_common_vals::text AS most_common_vals, most_common_freqs::text AS most_common_freqs, histogram_bounds::text AS histogram_bounds FROM pg_stats WHERE schemaname = '${sqlEscape(schema)}' AND tablename = '${sqlEscape(table)}' AND attname IN (${colList})`;
  const rows = await rpc(sql);
  const m = new Map<string, PgStatsRow>();
  for (const r of rows) {
    m.set(String(r.attname), r as unknown as PgStatsRow);
  }
  return m;
}

/** Henter kolonnetyper fra information_schema.columns. */
async function fetchColumnTypes(
  rpc: SqlRunner,
  schema: string,
  table: string
): Promise<Map<string, string>> {
  const rows = await rpc(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = '${sqlEscape(schema)}' AND table_name = '${sqlEscape(table)}'`
  );
  const m = new Map<string, string>();
  for (const r of rows) {
    m.set(String(r.column_name), String(r.data_type));
  }
  return m;
}

/**
 * Bygger catalog-rækker for én tabel: 1 tabel-niveau-række + 1 per kolonne.
 */
export async function buildCatalogForTable(
  rpc: SqlRunner,
  spec: (typeof CATALOG_TABLES)[number]
): Promise<CatalogRow[]> {
  const { schema, table, columns, piiColumns, semanticLabels } = spec;
  const rows: CatalogRow[] = [];

  // 1. ANALYZE for at sikre frisk pg_stats (skip på matview-fejl)
  try {
    await rpc(`ANALYZE ${schema}.${table}`);
  } catch (err) {
    logger.warn(`[buildCatalog] ANALYZE ${schema}.${table} failed (kan være matview):`, err);
  }

  // 2. Row count + tabel-niveau row
  const rowCount = await fetchRowCount(rpc, schema, table);
  rows.push({
    table_schema: schema,
    table_name: table,
    column_name: '',
    data_type: null,
    row_count: rowCount,
    null_count: null,
    distinct_count: null,
    top_values: null,
    min_value: null,
    max_value: null,
    semantic_label: null,
    pii_flag: false,
  });

  // 3. Kolonne-typer + pg_stats
  const [types, stats] = await Promise.all([
    fetchColumnTypes(rpc, schema, table),
    fetchPgStats(rpc, schema, table, columns),
  ]);

  // 4. Per-kolonne rækker
  for (const colName of columns) {
    const dataType = types.get(colName) ?? null;
    const s = stats.get(colName);
    const isPii = piiColumns.includes(colName);
    const semanticLabel = semanticLabels?.[colName] ?? null;

    let nullCount: number | null = null;
    let distinctCount: number | null = null;
    let topValues: Array<{ value: string; freq: number }> | null = null;
    let minValue: string | null = null;
    let maxValue: string | null = null;

    if (s) {
      const nullFrac = typeof s.null_frac === 'number' ? s.null_frac : Number(s.null_frac);
      if (!Number.isNaN(nullFrac) && rowCount > 0) {
        nullCount = Math.round(nullFrac * rowCount);
      }

      const nDist = typeof s.n_distinct === 'number' ? s.n_distinct : Number(s.n_distinct);
      if (!Number.isNaN(nDist)) {
        // pg_stats n_distinct: positiv = absolut, negativ = fraktion af row_count
        if (nDist >= 0) {
          distinctCount = Math.round(nDist);
        } else if (rowCount > 0) {
          distinctCount = Math.round(Math.abs(nDist) * rowCount);
        }
      }

      if (!isPii && s.most_common_vals && s.most_common_freqs) {
        const vals = parsePgArray(s.most_common_vals);
        const freqs = parsePgArray(s.most_common_freqs).map((f) => Number(f));
        const limit = Math.min(vals.length, freqs.length, 10);
        if (limit > 0) {
          topValues = [];
          for (let i = 0; i < limit; i++) {
            topValues.push({ value: vals[i], freq: freqs[i] });
          }
        }
      }

      const hist = parsePgArray(s.histogram_bounds);
      if (hist.length > 0) {
        minValue = hist[0];
        maxValue = hist[hist.length - 1];
      }
    }

    rows.push({
      table_schema: schema,
      table_name: table,
      column_name: colName,
      data_type: dataType,
      row_count: null,
      null_count: nullCount,
      distinct_count: distinctCount,
      top_values: topValues,
      min_value: minValue,
      max_value: maxValue,
      semantic_label: semanticLabel,
      pii_flag: isPii,
    });
  }

  return rows;
}

/** Format en JSON-værdi som SQL JSONB-literal (eller NULL). */
function jsonbLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  return `'${sqlEscape(JSON.stringify(v))}'::jsonb`;
}

/** Format en text-værdi som SQL string-literal (eller NULL). */
function textLiteral(v: string | null | undefined): string {
  if (v === null || v === undefined) return 'NULL';
  return `'${sqlEscape(v)}'`;
}

/** Format en numerisk værdi som SQL-literal (eller NULL). */
function numLiteral(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'NULL';
  return String(v);
}

/**
 * Bygger catalog for alle CATALOG_TABLES og upsert'er via Management API.
 * Fejl på én tabel stopper ikke andre.
 */
export async function buildAndUpsertCatalog(rpc?: SqlRunner): Promise<{
  results: Array<{ table: string; rows: number; durationMs: number; error?: string }>;
}> {
  const runner = rpc ?? createDefaultSqlRunner();
  const results: Array<{ table: string; rows: number; durationMs: number; error?: string }> = [];

  for (const spec of CATALOG_TABLES) {
    const start = Date.now();
    const fqName = `${spec.schema}.${spec.table}`;
    try {
      const rows = await buildCatalogForTable(runner, spec);

      // Slet eksisterende rækker for tabellen
      await runner(
        `DELETE FROM dataintel.data_catalog WHERE table_schema = '${sqlEscape(spec.schema)}' AND table_name = '${sqlEscape(spec.table)}'`
      );

      // Insert i én batch — typisk <15 rækker per tabel
      const values = rows
        .map(
          (r) =>
            `(${textLiteral(r.table_schema)}, ${textLiteral(r.table_name)}, ${textLiteral(r.column_name)}, ${textLiteral(r.data_type)}, ${numLiteral(r.row_count)}, ${numLiteral(r.null_count)}, ${numLiteral(r.distinct_count)}, ${jsonbLiteral(r.top_values)}, ${textLiteral(r.min_value)}, ${textLiteral(r.max_value)}, ${textLiteral(r.semantic_label)}, ${r.pii_flag}, now())`
        )
        .join(',\n');
      const insertSql = `INSERT INTO dataintel.data_catalog (table_schema, table_name, column_name, data_type, row_count, null_count, distinct_count, top_values, min_value, max_value, semantic_label, pii_flag, computed_at) VALUES ${values}`;
      await runner(insertSql);

      results.push({ table: fqName, rows: rows.length, durationMs: Date.now() - start });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[buildCatalog] ${fqName} failed:`, msg);
      results.push({ table: fqName, rows: 0, durationMs: Date.now() - start, error: msg });
    }
  }

  return { results };
}
