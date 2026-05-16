/**
 * Semantic layer types — MetricDefinition + DimensionDefinition (BIZZ-1562).
 *
 * Cube-inspireret syntaks i TypeScript per ADR-0010. Hver metric defineres som
 * et SQL-aggregat over en primær fact-tabel; dimensions er sql-udtryk der
 * grupperer eller filtrerer. SQL-compileren (BIZZ-1564) bruger disse til at
 * generere deterministisk PostgreSQL fra en QueryPlan.
 *
 * @module app/lib/dataIntelligence/semantic/types
 */

/** Aggregat-type for metrics */
export type MetricType =
  | 'count'
  | 'count_distinct'
  | 'sum'
  | 'avg'
  | 'median'
  | 'min'
  | 'max'
  | 'ratio';

/** Output-format — driver chart-rendering + tal-formatering */
export type MetricFormat = 'integer' | 'decimal' | 'currency_dkk' | 'percent' | 'm2' | 'years';

/** Definition af én metric */
export interface MetricDefinition {
  /** Snake-case unique navn, fx 'count_handler' */
  name: string;
  /** Dansk display-label */
  displayName: string;
  /** AI-beskrivelse — bruges af L2.2 routing til at vælge denne metric */
  description: string;
  /** Aggregat-type */
  type: MetricType;
  /** Aggregat-udtryk uden FROM/GROUP BY (fx 'COUNT(*)' eller 'AVG(kontant_koebesum)') */
  sql: string;
  /** Primær fact-tabel (uden schema-prefix) */
  table: string;
  /** Default-filtre der altid anvendes (WHERE-clauses) */
  filters?: string[];
  /** Output-format */
  format: MetricFormat;
  /** Tekstuel enhed til labels */
  unit?: string;
  /** 2-3 naturlige sprog-eksempler */
  examples: string[];
}

/** Dimension-type */
export type DimensionType = 'string' | 'integer' | 'date' | 'boolean' | 'enum';

/** Bucket-range for numeriske dimensions */
export interface BucketRange {
  /** Display-label, fx '1-5 mio' */
  label: string;
  /** Min-værdi (inkl.). Undladt = ingen nedre grænse */
  min?: number;
  /** Max-værdi (eksl.). Undladt = ingen øvre grænse */
  max?: number;
}

/** Definition af én dimension */
export interface DimensionDefinition {
  /** Snake-case unique navn */
  name: string;
  /** Dansk display-label */
  displayName: string;
  /** AI-beskrivelse */
  description: string;
  /** Type */
  type: DimensionType;
  /** SQL-udtryk — kan være kolonne, CASE eller bucket-expression */
  sql: string;
  /** Primær tabel */
  table: string;
  /** Værdier for enum-type */
  enumValues?: string[];
  /** Bucket-konfiguration for numeriske dimensions */
  bucketize?: { ranges: BucketRange[] };
  /** 2-3 naturlige sprog-eksempler */
  examples: string[];
}

/** Join-spec mellem to tabeller — bruges af joinGraph */
export interface JoinSpec {
  /** Venstre tabel */
  fromTable: string;
  /** Højre tabel */
  toTable: string;
  /** SQL ON-clause uden ON-prefix */
  on: string;
  /** Hvis true: LATERAL JOIN (typisk for "nyeste record"-pattern) */
  lateral?: boolean;
}
