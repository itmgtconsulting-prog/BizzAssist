/**
 * SQL-compiler for Data Intelligence semantic layer (BIZZ-1564).
 *
 * Tager en valideret QueryPlan (fra L2.2 router) og producerer
 * deterministisk, safe PostgreSQL via pure TypeScript — ingen AI, ingen
 * mulighed for SQL injection eller hallucinerede kolonner.
 *
 * Pipeline:
 *   1. Identificér påkrævede tabeller (fra metrics + dimensions + filters + sort + timeRange)
 *   2. Vælg base-tabel (primær fact-tabel for første metric)
 *   3. Find join-stier via joinGraph (BFS)
 *   4. Generér SELECT (metric + dimension expressions med aliaser)
 *   5. Generér FROM/JOIN (base + alle nødvendige joins)
 *   6. Generér WHERE (metric default-filtre + bruger-filtre + timeRange)
 *   7. Generér GROUP BY (alle dimensions hvis vi har aggregater)
 *   8. Generér ORDER BY + LIMIT
 *
 * Værdier escapes via {@link escapeSqlLiteral} (Management API understøtter
 * ikke parameteriserede queries, så vi escaper selv). All escape-logik er
 * type-strict og afviser ugyldige input fail-fast.
 *
 * @module app/lib/dataIntelligence/semantic/sqlCompiler
 */

import { getMetric } from './metrics';
import { getDimension } from './dimensions';
import { findJoinPath } from './joinGraph';
import {
  resolvePreset,
  validateQueryPlan,
  type Filter,
  type QueryPlan,
  type TimeRange,
} from './queryPlan';
import type { JoinSpec, MetricFormat, DimensionDefinition } from './types';

/** Schema for alle Data Intelligence fact/dim-tabeller */
const SCHEMA = 'public';

/** Max LIMIT for sikkerheds-clamp */
const MAX_LIMIT = 10_000;
/** Default LIMIT hvis plan ikke angiver */
const DEFAULT_LIMIT = 100;

/** Kolonne-info til UI-rendering */
export interface CompiledColumn {
  /** Alias brugt i SELECT (snake_case) */
  alias: string;
  /** Dansk display-label */
  displayName: string;
  /** Kilde: metric eller dimension */
  source: 'metric' | 'dimension';
  /** Format-hint (kun for metrics) */
  format?: MetricFormat;
  /** Enhed (kun for metrics) */
  unit?: string;
  /** Reference til katalog-navn (metric/dimension navn) */
  catalogName: string;
}

/** Output fra compiler */
export interface CompiledQuery {
  /** Komplet SQL — eksekverbar direkte */
  sql: string;
  /** Base-tabel valgt af compileren */
  baseTable: string;
  /** Alle joinede tabeller (uden base) */
  joinedTables: string[];
  /** Kolonne-rækkefølge svarende til SELECT */
  columns: CompiledColumn[];
  /** Effektivt LIMIT brugt (efter clamping) */
  limit: number;
  /** Advarsler — fx clampet limit eller fallback-strategier */
  warnings: string[];
}

/** Compile-resultat (success eller fejl) */
export type CompileResult =
  | { ok: true; query: CompiledQuery }
  | { ok: false; reason: string; field?: string };

/**
 * Escape SQL literal-værdier til safe inline-brug.
 *
 * @param v - String, number, boolean, eller null
 * @returns SQL-formatteret literal (med quotes for string/date)
 * @throws Error hvis værdi-type ikke understøttes
 */
export function escapeSqlLiteral(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Non-finite number i SQL literal');
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') {
    // Doble single quotes, fjern NUL-bytes (PG kan ikke håndtere)
    const cleaned = v.replace(/\0/g, '');
    return `'${cleaned.replace(/'/g, "''")}'`;
  }
  throw new Error(`Ugyldig SQL literal type: ${typeof v}`);
}

/**
 * Snake-case + lowercase et display-navn til brug som SQL-alias.
 * Fjerner ikke-alfanumeriske tegn for at undgå quote-problemer.
 */
function toAlias(s: string): string {
  return s
    .toLowerCase()
    .replace(/[æå]/g, 'a')
    .replace(/ø/g, 'o')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 60);
}

/**
 * Saml alle påkrævede tabeller fra plan.
 * Returnerer set af tabel-navne (uden schema).
 */
function collectRequiredTables(plan: QueryPlan): string[] {
  const tables = new Set<string>();
  for (const name of plan.metrics) {
    const m = getMetric(name);
    if (m) tables.add(m.table);
  }
  for (const name of plan.dimensions) {
    const d = getDimension(name);
    if (d) tables.add(d.table);
  }
  for (const f of plan.filters) {
    const d = getDimension(f.dimension);
    if (d) tables.add(d.table);
  }
  if (plan.timeRange) {
    const d = getDimension(plan.timeRange.dimension);
    if (d) tables.add(d.table);
  }
  if (plan.sort) {
    const m = getMetric(plan.sort.by);
    if (m) tables.add(m.table);
    const d = getDimension(plan.sort.by);
    if (d) tables.add(d.table);
  }
  return Array.from(tables);
}

/**
 * Vælg base-tabel = primær fact-tabel for første metric. Denne tabel bliver
 * FROM-clausens udgangspunkt og alle joins relaterer til den (eller til en
 * tidligere joined tabel).
 */
function pickBaseTable(plan: QueryPlan): string {
  const first = getMetric(plan.metrics[0]);
  if (!first) throw new Error('pickBaseTable: ingen metric fundet');
  return first.table;
}

/**
 * Find join-stier fra base til alle andre påkrævede tabeller.
 * Returnerer dedupliceret liste af JoinSpec i den rækkefølge de skal
 * anvendes (afhængigheder først).
 */
function planJoins(base: string, required: string[]): { joins: JoinSpec[]; missing: string[] } {
  const joined = new Set<string>([base]);
  const result: JoinSpec[] = [];
  const missing: string[] = [];

  for (const target of required) {
    if (joined.has(target)) continue;
    const path = findJoinPath(base, target);
    if (!path || path.length === 0) {
      missing.push(target);
      continue;
    }
    for (const j of path) {
      // Deduplikér: hvis joinet allerede er anvendt, spring over
      const alreadyAdded = result.some(
        (r) =>
          (r.fromTable === j.fromTable && r.toTable === j.toTable) ||
          (r.fromTable === j.toTable && r.toTable === j.fromTable)
      );
      if (!alreadyAdded) result.push(j);
      joined.add(j.fromTable);
      joined.add(j.toTable);
    }
  }
  return { joins: result, missing };
}

/**
 * Render én filter-clause som SQL-string.
 *
 * @param filter - Filter-spec
 * @param dim - Dimension-definition (allerede looked up)
 * @returns SQL-fragment (uden WHERE/AND)
 * @throws Error ved ugyldig value-shape
 */
function renderFilter(filter: Filter, dim: DimensionDefinition): string {
  const col = dim.sql;
  switch (filter.op) {
    case 'is_null':
      return `${col} IS NULL`;
    case 'is_not_null':
      return `${col} IS NOT NULL`;
    case 'eq':
      return `${col} = ${renderValue(filter.value)}`;
    case 'ne':
      return `${col} <> ${renderValue(filter.value)}`;
    case 'gt':
      return `${col} > ${renderValue(filter.value)}`;
    case 'gte':
      return `${col} >= ${renderValue(filter.value)}`;
    case 'lt':
      return `${col} < ${renderValue(filter.value)}`;
    case 'lte':
      return `${col} <= ${renderValue(filter.value)}`;
    case 'in':
    case 'not_in': {
      if (!Array.isArray(filter.value)) {
        throw new Error(`Filter '${filter.op}' kræver array-værdi`);
      }
      const list = filter.value.map((v) => renderValue(v)).join(', ');
      return `${col} ${filter.op === 'in' ? 'IN' : 'NOT IN'} (${list})`;
    }
    case 'between': {
      if (!Array.isArray(filter.value) || filter.value.length !== 2) {
        throw new Error(`Filter 'between' kræver [min, max]`);
      }
      const [lo, hi] = filter.value;
      return `${col} BETWEEN ${renderValue(lo)} AND ${renderValue(hi)}`;
    }
    case 'like':
      return `${col} LIKE ${renderValue(filter.value)}`;
    case 'ilike':
      return `${col} ILIKE ${renderValue(filter.value)}`;
  }
}

/** Helper — escape én enkelt value */
function renderValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return escapeSqlLiteral(v);
  }
  throw new Error(`Ugyldig filter-værdi type: ${typeof v}`);
}

/**
 * Render time-range som WHERE-clause-fragment.
 */
function renderTimeRange(tr: TimeRange, now: Date): string {
  const dim = getDimension(tr.dimension);
  if (!dim) throw new Error(`Ukendt timeRange.dimension: ${tr.dimension}`);

  let from: string | undefined;
  let to: string | undefined;
  if (tr.preset) {
    const resolved = resolvePreset(tr.preset, now);
    from = resolved.from;
    to = resolved.to;
  }
  if (tr.from) from = tr.from;
  if (tr.to) to = tr.to;

  const parts: string[] = [];
  if (from) parts.push(`${dim.sql} >= ${escapeSqlLiteral(from)}`);
  if (to) parts.push(`${dim.sql} <= ${escapeSqlLiteral(to)}`);
  if (parts.length === 0) {
    throw new Error('timeRange skal have preset eller from/to');
  }
  return parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`;
}

/**
 * Compile QueryPlan → SQL.
 *
 * @param plan - QueryPlan (skal være valideret eller bliver det internt)
 * @param options - now (default = i dag) for deterministisk testing
 * @returns CompileResult — sql + meta, eller fejl-reason
 */
export function compileQueryPlan(plan: QueryPlan, options: { now?: Date } = {}): CompileResult {
  const now = options.now ?? new Date();
  const warnings: string[] = [];

  // 1) Validér først — fail-fast med specific reason
  const v = validateQueryPlan(plan);
  if (!v.ok) return { ok: false, reason: v.reason, field: v.field };

  // 2) Saml påkrævede tabeller + vælg base
  const required = collectRequiredTables(plan);
  if (required.length === 0) {
    return { ok: false, reason: 'Plan har ingen tabeller — mindst én metric kræves' };
  }
  let baseTable: string;
  try {
    baseTable = pickBaseTable(plan);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  // 3) Plan joins
  const { joins, missing } = planJoins(baseTable, required);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Kan ikke finde join-sti fra ${baseTable} til: ${missing.join(', ')}`,
    };
  }

  // 4) Build SELECT
  const columns: CompiledColumn[] = [];
  const selectParts: string[] = [];

  // Dimensions først (de er gruppe-nøgler)
  for (const dimName of plan.dimensions) {
    const d = getDimension(dimName)!;
    const alias = toAlias(d.name);
    selectParts.push(`${d.sql} AS ${alias}`);
    columns.push({
      alias,
      displayName: d.displayName,
      source: 'dimension',
      catalogName: d.name,
    });
  }
  // Så metrics
  for (const metricName of plan.metrics) {
    const m = getMetric(metricName)!;
    const alias = toAlias(m.name);
    selectParts.push(`${m.sql} AS ${alias}`);
    columns.push({
      alias,
      displayName: m.displayName,
      source: 'metric',
      format: m.format,
      unit: m.unit,
      catalogName: m.name,
    });
  }

  // 5) FROM + JOINs
  const fromClause = `${SCHEMA}.${baseTable}`;
  const joinClauses: string[] = [];
  for (const j of joins) {
    // Find hvilken side er "ny" (ikke baseTable og endnu ikke set)
    // Simpel approach: join til toTable, men hvis fromTable er den nye, swap
    // I praksis: joinGraphen gennemløber path BFS, så vi ved fromTable er kendt
    // Vi tager bare toTable som join-mål — hvis den allerede var i scope
    // skipper vi den (duplikat undgået i planJoins)
    const target =
      j.fromTable === baseTable || joinClauses.some((c) => c.includes(j.fromTable))
        ? j.toTable
        : j.fromTable;
    const isLateral = j.lateral === true;
    joinClauses.push(
      `${isLateral ? 'LEFT JOIN LATERAL' : 'LEFT JOIN'} ${SCHEMA}.${target} ON ${j.on}`
    );
  }

  // 6) WHERE
  const whereParts: string[] = [];
  // Default-filtre fra hver metric (de gælder uanset bruger-input)
  const seenDefaults = new Set<string>();
  for (const metricName of plan.metrics) {
    const m = getMetric(metricName)!;
    for (const f of m.filters ?? []) {
      if (!seenDefaults.has(f)) {
        whereParts.push(f);
        seenDefaults.add(f);
      }
    }
  }
  // Bruger-filtre
  for (const f of plan.filters) {
    const d = getDimension(f.dimension);
    if (!d) continue; // already validated, defensiv
    try {
      whereParts.push(renderFilter(f, d));
    } catch (err) {
      return { ok: false, reason: (err as Error).message, field: 'filters' };
    }
  }
  // TimeRange
  if (plan.timeRange) {
    try {
      whereParts.push(renderTimeRange(plan.timeRange, now));
    } catch (err) {
      return { ok: false, reason: (err as Error).message, field: 'timeRange' };
    }
  }

  // 7) GROUP BY (kun hvis vi har dimensions — metrics er altid aggregater)
  const groupByParts: string[] = [];
  if (plan.dimensions.length > 0) {
    // GROUP BY referencerer dimensions ved 1-baseret positions for at undgå
    // problemer med komplekse CASE-expressions
    for (let i = 0; i < plan.dimensions.length; i++) {
      groupByParts.push(String(i + 1));
    }
  }

  // 8) ORDER BY
  let orderByClause = '';
  if (plan.sort) {
    const alias = toAlias(plan.sort.by);
    const dir = plan.sort.direction === 'asc' ? 'ASC' : 'DESC';
    orderByClause = `ORDER BY ${alias} ${dir} NULLS LAST`;
  } else if (plan.metrics.length > 0 && plan.dimensions.length > 0) {
    // Default: sort på første metric DESC for top-N feel
    const alias = toAlias(plan.metrics[0]);
    orderByClause = `ORDER BY ${alias} DESC NULLS LAST`;
  }

  // 9) LIMIT — clamp til [1, MAX_LIMIT]
  let limit = plan.limit ?? DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) {
    warnings.push(`LIMIT ${limit} clampet til ${MAX_LIMIT}`);
    limit = MAX_LIMIT;
  }
  if (limit < 1) limit = 1;

  // Saml SQL
  const sqlLines: string[] = [];
  sqlLines.push(`SELECT ${selectParts.join(', ')}`);
  sqlLines.push(`FROM ${fromClause}`);
  for (const jc of joinClauses) sqlLines.push(jc);
  if (whereParts.length > 0) {
    sqlLines.push(`WHERE ${whereParts.join(' AND ')}`);
  }
  if (groupByParts.length > 0) {
    sqlLines.push(`GROUP BY ${groupByParts.join(', ')}`);
  }
  if (orderByClause) sqlLines.push(orderByClause);
  sqlLines.push(`LIMIT ${limit}`);

  return {
    ok: true,
    query: {
      sql: sqlLines.join('\n'),
      baseTable,
      joinedTables: Array.from(new Set(joins.flatMap((j) => [j.fromTable, j.toTable]))).filter(
        (t) => t !== baseTable
      ),
      columns,
      limit,
      warnings,
    },
  };
}

/**
 * SQL-runner interface — kompatibel med createDefaultSqlRunner i buildCatalog.
 * Genbruger Management API-baseret runner.
 */
export type SqlRunner = (sql: string) => Promise<Array<Record<string, unknown>>>;

/** Resultat af eksekvering */
export interface ExecuteResult {
  /** Originale rækker fra DB */
  rows: Array<Record<string, unknown>>;
  /** Kolonne-meta fra compiler — bevares så UI kan rendere ordentligt */
  columns: CompiledColumn[];
  /** Eksekverings-tid i ms */
  durationMs: number;
  /** Effektiv SQL der blev kørt */
  sql: string;
}

/**
 * Compile + eksekver QueryPlan i én operation.
 *
 * @param plan - QueryPlan
 * @param runner - SqlRunner (typisk createDefaultSqlRunner())
 * @param options - { now } for deterministisk preset-resolution
 * @returns ExecuteResult med rows + metadata
 * @throws Error ved compile- eller eksekverings-fejl
 */
export async function executeQueryPlan(
  plan: QueryPlan,
  runner: SqlRunner,
  options: { now?: Date } = {}
): Promise<ExecuteResult> {
  const compiled = compileQueryPlan(plan, options);
  if (!compiled.ok) {
    throw new Error(`SQL compile fejl: ${compiled.reason}`);
  }
  const start = Date.now();
  const rows = await runner(compiled.query.sql);
  const durationMs = Date.now() - start;
  return {
    rows,
    columns: compiled.query.columns,
    durationMs,
    sql: compiled.query.sql,
  };
}
