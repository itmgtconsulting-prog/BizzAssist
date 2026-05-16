/**
 * QueryPlan — struktureret repræsentation af et bruger-spørgsmål oversat til
 * metric+dim+filter+timeRange (BIZZ-1563).
 *
 * QueryPlan'en er det canonical mellemformat mellem L2.2 routing (NL → plan)
 * og L2.3 SQL-compiler (plan → SQL). Den er typesikker og kan valideres mod
 * metric/dimension-katalogerne fra L2.1 (BIZZ-1562) inden eksekvering.
 *
 * @module app/lib/dataIntelligence/semantic/queryPlan
 */

import { getMetric } from './metrics';
import { getDimension } from './dimensions';

/** Filter-operator typer */
export type FilterOp =
  | 'eq'
  | 'ne'
  | 'in'
  | 'not_in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'like'
  | 'ilike'
  | 'is_null'
  | 'is_not_null';

/** Filter — bruges i WHERE-clause */
export interface Filter {
  /** Dimension-navn fra katalog */
  dimension: string;
  /** Operator */
  op: FilterOp;
  /** Værdi — type afhænger af op */
  value?: string | number | boolean | (string | number)[] | [number, number];
}

/** Tids-preset til human-readable time-ranges */
export type TimePreset =
  | 'last_7_days'
  | 'last_30_days'
  | 'last_90_days'
  | 'last_12_months'
  | 'ytd'
  | 'qtd'
  | 'mtd'
  | 'last_year'
  | 'all_time';

/** Tid-granularitet til series-buckets */
export type TimeGrain = 'day' | 'month' | 'quarter' | 'year';

/** Tids-range filter */
export interface TimeRange {
  /** Dimension-navn at filtrere på (typisk 'dato', 'overtagelsesdato' etc.) */
  dimension: string;
  /** Forudvalgt range */
  preset?: TimePreset;
  /** Eksplicit fra-dato (ISO YYYY-MM-DD) */
  from?: string;
  /** Eksplicit til-dato (ISO YYYY-MM-DD) */
  to?: string;
  /** Optional granularitet for serie-buckets */
  grain?: TimeGrain;
}

/** Sort-spec */
export interface Sort {
  /** Metric- eller dimension-navn */
  by: string;
  /** Retning */
  direction: 'asc' | 'desc';
}

/** Chart-hint til UI-rendering */
export type ChartHint = 'line' | 'bar' | 'pie' | 'table' | 'scorecard';

/** Den canonical query-plan */
export interface QueryPlan {
  /** Metric-navne fra katalog (mindst én) */
  metrics: string[];
  /** Dimension-navne (kan være tom for total-aggregat) */
  dimensions: string[];
  /** Filtre */
  filters: Filter[];
  /** Time-range filter (separat fra filters for klarhed) */
  timeRange?: TimeRange;
  /** Sort-orden */
  sort?: Sort;
  /** LIMIT — default 100, max 10000 */
  limit?: number;
  /** Chart-hint */
  chartHint?: ChartHint;
}

/** Validations-resultat */
export type ValidationResult = { ok: true } | { ok: false; reason: string; field?: string };

/**
 * Validér en QueryPlan mod metric/dimension-katalogerne.
 *
 * Returnerer fail-fast ved første fejl med specific reason.
 *
 * @param plan - Plan at validere
 * @returns ValidationResult
 */
export function validateQueryPlan(plan: QueryPlan): ValidationResult {
  if (!plan.metrics || plan.metrics.length === 0) {
    return { ok: false, reason: 'Plan skal indeholde mindst én metric' };
  }
  if (plan.metrics.length > 5) {
    return { ok: false, reason: 'Maks 5 metrics per plan' };
  }
  if (plan.dimensions.length > 4) {
    return { ok: false, reason: 'Maks 4 dimensions per plan' };
  }

  // Verificér at hver metric findes i katalog
  for (const m of plan.metrics) {
    if (!getMetric(m)) {
      return { ok: false, reason: `Ukendt metric: ${m}`, field: 'metrics' };
    }
  }

  // Verificér dimensions
  for (const d of plan.dimensions) {
    if (!getDimension(d)) {
      return { ok: false, reason: `Ukendt dimension: ${d}`, field: 'dimensions' };
    }
  }

  // Verificér filter-dimensions
  for (const f of plan.filters) {
    if (!getDimension(f.dimension)) {
      return {
        ok: false,
        reason: `Filter refererer til ukendt dimension: ${f.dimension}`,
        field: 'filters',
      };
    }
    // Validér value-shape per operator
    if (f.op === 'in' || f.op === 'not_in') {
      if (!Array.isArray(f.value)) {
        return { ok: false, reason: `Operator '${f.op}' kræver array-værdi`, field: 'filters' };
      }
    } else if (f.op === 'between') {
      if (!Array.isArray(f.value) || f.value.length !== 2) {
        return {
          ok: false,
          reason: `Operator 'between' kræver [min, max] tuple`,
          field: 'filters',
        };
      }
    } else if (f.op !== 'is_null' && f.op !== 'is_not_null' && f.value === undefined) {
      return { ok: false, reason: `Operator '${f.op}' kræver value`, field: 'filters' };
    }
  }

  // Time-range
  if (plan.timeRange) {
    if (!getDimension(plan.timeRange.dimension)) {
      return {
        ok: false,
        reason: `timeRange refererer til ukendt dimension: ${plan.timeRange.dimension}`,
        field: 'timeRange',
      };
    }
    if (!plan.timeRange.preset && !plan.timeRange.from && !plan.timeRange.to) {
      return {
        ok: false,
        reason: 'timeRange skal have enten preset eller from/to',
        field: 'timeRange',
      };
    }
  }

  // Sort
  if (plan.sort) {
    const isMetric = !!getMetric(plan.sort.by);
    const isDim = !!getDimension(plan.sort.by);
    if (!isMetric && !isDim) {
      return {
        ok: false,
        reason: `sort.by refererer til ukendt metric/dimension: ${plan.sort.by}`,
        field: 'sort',
      };
    }
  }

  // Limit
  if (plan.limit !== undefined && (plan.limit < 1 || plan.limit > 10000)) {
    return { ok: false, reason: 'limit skal være 1-10000', field: 'limit' };
  }

  return { ok: true };
}

/**
 * Konvertér time-preset til konkrete from/to ISO-datoer baseret på "now".
 *
 * @param preset - Time-preset
 * @param now - Reference-dato (default = i dag)
 * @returns { from, to } ISO-datoer
 */
export function resolvePreset(
  preset: TimePreset,
  now: Date = new Date()
): { from: string; to: string } {
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);

  switch (preset) {
    case 'last_7_days': {
      const from = new Date(today);
      from.setUTCDate(from.getUTCDate() - 7);
      return { from: toIso(from), to: toIso(today) };
    }
    case 'last_30_days': {
      const from = new Date(today);
      from.setUTCDate(from.getUTCDate() - 30);
      return { from: toIso(from), to: toIso(today) };
    }
    case 'last_90_days': {
      const from = new Date(today);
      from.setUTCDate(from.getUTCDate() - 90);
      return { from: toIso(from), to: toIso(today) };
    }
    case 'last_12_months': {
      const from = new Date(today);
      from.setUTCMonth(from.getUTCMonth() - 12);
      return { from: toIso(from), to: toIso(today) };
    }
    case 'ytd': {
      const from = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
      return { from: toIso(from), to: toIso(today) };
    }
    case 'qtd': {
      const q = Math.floor(today.getUTCMonth() / 3) * 3;
      const from = new Date(Date.UTC(today.getUTCFullYear(), q, 1));
      return { from: toIso(from), to: toIso(today) };
    }
    case 'mtd': {
      const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      return { from: toIso(from), to: toIso(today) };
    }
    case 'last_year': {
      const from = new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1));
      const to = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
      return { from: toIso(from), to: toIso(to) };
    }
    case 'all_time':
      return { from: '1900-01-01', to: toIso(today) };
  }
}
