/**
 * Cache-routing for Data Intelligence (BIZZ-1565, L3).
 *
 * Tjekker tre cache-lag før vi falder igennem til SQL-compiler (L2.3):
 *   1. intel_scorecard — pre-computed skalar svar (1 metric, 0 dims, ingen
 *      filtre). Refreshed nightly via cron.
 *   2. mvCatalog — pre-aggregeret materialized views der matcher plan-shape
 *      (kommune×måned osv). Pt. stub; tilføjes når MV'erne deployes.
 *   3. Redis fingerprint-cache — hash(plan) → cached result. TTL 1 time.
 *      Fanger gentagne queries på tværs af brugere.
 *
 * Hver lookup er fail-soft: returnér `null` ved fejl/miss, og lad caller
 * falde igennem til næste lag eller normal SQL-compile.
 *
 * @module app/lib/dataIntelligence/semantic/cacheRouter
 */

import { createHash } from 'crypto';
import { Redis } from '@upstash/redis';
import { logger } from '@/app/lib/logger';
import { getMetric } from './metrics';
import { resolvePreset, type QueryPlan } from './queryPlan';
import { findMatchingMv, type MvDefinition } from './mvCatalog';
import type { MetricFormat } from './types';

/** TTL for Redis fingerprint-cache (sekunder) — 1 time */
const REDIS_TTL_SECONDS = 3_600;
/** Kun cache queries der tager længere end denne tid (ms) */
const REDIS_CACHE_MIN_MS = 100;

/** Hvilket cache-lag svaret kom fra */
export type CacheLayer = 'scorecard' | 'mv' | 'redis';

/** Skalar-svar fra scorecard-lag */
export interface ScorecardResult {
  layer: 'scorecard';
  key: string;
  value: number | null;
  displayName: string;
  unit: string | null;
  format: MetricFormat;
  refreshedAt: string;
}

/** Tabulært resultat fra MV/redis-lag */
export interface TabularResult {
  layer: 'mv' | 'redis';
  rows: Array<Record<string, unknown>>;
  columns: Array<{ alias: string; displayName: string }>;
  /** SQL der blev kørt (kun for MV) eller null for Redis */
  sql: string | null;
  /** Eksekverings-tid i ms (0 for Redis hits) */
  durationMs: number;
}

export type CacheResult = ScorecardResult | TabularResult;

// ─── Redis-klient ──────────────────────────────────────────────────────────

let _redis: Redis | null = null;

/** Lazy Redis-klient (returnerer null hvis env mangler — fail-soft). */
function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Plan er en "scalar lookup" hvis den har præcis 1 metric, 0 dimensions,
 * ingen bruger-filtre og ingen tidsbegrænsning. Sådan en plan kan typisk
 * besvares fra intel_scorecard.
 */
export function isScalarLookup(plan: QueryPlan): boolean {
  return (
    plan.metrics.length === 1 &&
    plan.dimensions.length === 0 &&
    plan.filters.length === 0 &&
    !plan.timeRange
  );
}

/**
 * Map plan til scorecard-key. Default = metric-navnet selv ("count_handler")
 * eller "<metric>_<preset>" hvis plan har en preset-tid (ikke aktiv pt.
 * fordi isScalarLookup kræver ingen timeRange).
 *
 * Returnerer null hvis plan ikke kan mappes.
 */
export function buildScorecardKey(plan: QueryPlan): string | null {
  if (!isScalarLookup(plan)) return null;
  const m = getMetric(plan.metrics[0]);
  if (!m) return null;
  // Mappér nogle metric-navne til scorecard-keys hvor de adskiller sig
  // (fx ratio'er der ikke caches direkte).
  const remap: Record<string, string> = {
    count_handler: 'count_handler',
    count_handler_med_pris: 'count_handler_med_pris',
    sum_koebesum: 'sum_koebesum_alle',
    avg_koebesum: 'avg_koebesum_alle',
    median_koebesum: 'median_koebesum_alle',
    max_koebesum: 'max_koebesum_alle',
    avg_m2_pris: 'avg_m2_pris_alle',
    median_m2_pris: 'median_m2_pris_alle',
  };
  return remap[m.name] ?? m.name;
}

/**
 * Deterministisk hash af plan til Redis-key. Inkluderer alle felter der
 * påvirker resultatet — preset normaliseres til konkret from/to så samme
 * spørgsmål på samme dag rammer samme bucket.
 */
export function hashPlanForCache(plan: QueryPlan, now: Date = new Date()): string {
  const normalized = {
    metrics: [...plan.metrics].sort(),
    dimensions: [...plan.dimensions].sort(),
    filters: [...plan.filters]
      .map((f) => ({
        dimension: f.dimension,
        op: f.op,
        value: Array.isArray(f.value) ? [...f.value].sort() : (f.value ?? null),
      }))
      .sort((a, b) => (a.dimension + a.op).localeCompare(b.dimension + b.op)),
    timeRange: plan.timeRange
      ? {
          dimension: plan.timeRange.dimension,
          ...(plan.timeRange.preset ? resolvePreset(plan.timeRange.preset, now) : {}),
          ...(plan.timeRange.from ? { from: plan.timeRange.from } : {}),
          ...(plan.timeRange.to ? { to: plan.timeRange.to } : {}),
          ...(plan.timeRange.grain ? { grain: plan.timeRange.grain } : {}),
        }
      : null,
    sort: plan.sort ?? null,
    limit: plan.limit ?? null,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 32);
}

// ─── Scorecard-lag ─────────────────────────────────────────────────────────

/** Minimal Supabase-style klient interface — kun det vi bruger */
export interface ScorecardReader {
  fetchOne(key: string): Promise<{
    value_numeric: number | string | null;
    display_name: string;
    unit: string | null;
    format: MetricFormat;
    refreshed_at: string;
  } | null>;
}

/**
 * Slå plan op i scorecard-tabellen. Returnerer null ved miss.
 */
export async function tryScorecardLookup(
  plan: QueryPlan,
  reader: ScorecardReader
): Promise<ScorecardResult | null> {
  const key = buildScorecardKey(plan);
  if (!key) return null;

  try {
    const row = await reader.fetchOne(key);
    if (!row) return null;
    const value = row.value_numeric === null ? null : Number(row.value_numeric);
    return {
      layer: 'scorecard',
      key,
      value,
      displayName: row.display_name,
      unit: row.unit,
      format: row.format,
      refreshedAt: row.refreshed_at,
    };
  } catch (err) {
    logger.warn('[cacheRouter] scorecard lookup fejl:', err);
    return null;
  }
}

// ─── MV-lag ────────────────────────────────────────────────────────────────

/**
 * Find materialiseret view der matcher plan-shape (samme metrics + dims
 * eller subset). MV-implementeringen er pt. en stub — selve MV'erne
 * deployes i et follow-up når compiler-rewrite til MV-shape er testet.
 */
export function tryMvMatch(plan: QueryPlan): MvDefinition | null {
  return findMatchingMv(plan);
}

// ─── Redis-lag ──────────────────────────────────────────────────────────────

/**
 * Slå plan-fingerprint op i Redis. Returnerer cached TabularResult ved hit.
 */
export async function tryRedisLookup(
  plan: QueryPlan,
  now: Date = new Date()
): Promise<TabularResult | null> {
  const redis = getRedis();
  if (!redis) return null;
  const fp = hashPlanForCache(plan, now);
  try {
    const cached = await redis.get<TabularResult>(`intel:plan:${fp}`);
    if (!cached) return null;
    // Marker som redis-hit + 0 ms (oprindelig durationMs gemmes ikke)
    return { ...cached, layer: 'redis', durationMs: 0 };
  } catch (err) {
    logger.warn('[cacheRouter] redis lookup fejl:', err);
    return null;
  }
}

/**
 * Skriv resultat til Redis. Fire-and-forget — fejler stille.
 * Skipper queries hurtigere end REDIS_CACHE_MIN_MS (caching ville ikke
 * give performance-gevinst).
 */
export async function storeInRedis(
  plan: QueryPlan,
  result: TabularResult,
  now: Date = new Date()
): Promise<void> {
  if (result.durationMs < REDIS_CACHE_MIN_MS) return;
  const redis = getRedis();
  if (!redis) return;
  const fp = hashPlanForCache(plan, now);
  try {
    await redis.set(`intel:plan:${fp}`, result, { ex: REDIS_TTL_SECONDS });
  } catch (err) {
    logger.warn('[cacheRouter] redis write fejl:', err);
  }
}

// ─── Orchestration ─────────────────────────────────────────────────────────

/** Samlet input til cache-lookup */
export interface CacheLookupOptions {
  /** Supabase-reader for scorecard-tabellen */
  scorecardReader?: ScorecardReader;
  /** Reference-tid (default = i dag) — bruges til preset-resolution */
  now?: Date;
  /** Spring Redis over (fx i tests) */
  skipRedis?: boolean;
}

/**
 * Prøv alle cache-lag i rækkefølge. Returnér første hit eller null.
 *
 * Lag-rækkefølge er valgt for at maksimere performance og minimere kostnad:
 *   1. Scorecard (~1ms lookup, instant svar for top-questions)
 *   2. MV (~10-50ms, dækker top-N med dimensions)
 *   3. Redis (~5-10ms, fanger nylige gentagne queries)
 */
export async function tryCacheLayers(
  plan: QueryPlan,
  options: CacheLookupOptions = {}
): Promise<CacheResult | null> {
  // 1. Scorecard
  if (options.scorecardReader) {
    const sc = await tryScorecardLookup(plan, options.scorecardReader);
    if (sc) return sc;
  }
  // 2. MV — pt. altid null indtil MV'er deployes
  const mv = tryMvMatch(plan);
  if (mv) {
    // TODO(BIZZ-1565-followup): compile + execute MV-rewrite når MV'erne
    // er deployed. For nu logger vi og falder igennem.
    logger.log('[cacheRouter] MV match fundet men ikke implementeret:', mv.name);
  }
  // 3. Redis
  if (!options.skipRedis) {
    const rd = await tryRedisLookup(plan, options.now);
    if (rd) return rd;
  }
  return null;
}
