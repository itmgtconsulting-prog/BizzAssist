/**
 * Brave Search result cache — Redis-first, Supabase fallback.
 *
 * Wraps Brave Search calls with a 24-hour cache to reduce API spend.
 * Primary store: Upstash Redis (fast, ~1ms latency).
 * Fallback store: Supabase search_cache table (if Redis is unavailable).
 * Cache key = SHA-256 of the query string + any variant params.
 *
 * Usage:
 *   import { withBraveCache } from '@/app/lib/searchCache';
 *   const results = await withBraveCache(`articles|${companyName}|${cvr}`, () =>
 *     searchBraveArticles(key, companyName)
 *   );
 */

import { createHash } from 'crypto';
import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';

/** Cache TTL in seconds (24 hours) */
const CACHE_TTL_SECONDS = 86_400;

// ─── Redis client ────────────────────────────────────────────────────────────

let _redis: Redis | null = null;

/**
 * Returns a lazily-initialised Redis client.
 * Returns null if env vars are missing (e.g. during build time).
 */
function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns a short SHA-256 hex digest of the input string.
 *
 * @param input - String to hash
 * @returns 32-char hex string
 */
function hashKey(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

// ─── Redis cache ──────────────────────────────────────────────────────────────

/**
 * Fetch cached result from Redis.
 *
 * @param cacheKey - Human-readable key (will be hashed internally)
 * @returns Cached result or null on miss / error
 */
async function redisGet(cacheKey: string): Promise<unknown | null> {
  try {
    const redis = getRedis();
    if (!redis) return null;
    return await redis.get(`brave:${hashKey(cacheKey)}`);
  } catch {
    return null;
  }
}

/**
 * Save result to Redis with 24-hour TTL. Fire-and-forget.
 *
 * @param cacheKey - Human-readable key (will be hashed internally)
 * @param results  - Value to cache
 */
async function redisSet(cacheKey: string, results: unknown): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    await redis.set(`brave:${hashKey(cacheKey)}`, results, { ex: CACHE_TTL_SECONDS });
  } catch {
    // Cache write failures are non-fatal
  }
}

// ─── Supabase fallback cache ──────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

/**
 * Fetch cached result from Supabase (fallback when Redis is unavailable).
 *
 * @param cacheKey - Human-readable key (will be hashed internally)
 * @returns Cached result or null on miss / error
 */
async function supabaseGet(cacheKey: string): Promise<unknown | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const cutoff = new Date(Date.now() - CACHE_TTL_SECONDS * 1_000).toISOString();
    const { data } = await client
      .from('search_cache')
      .select('results')
      .eq('query_hash', hashKey(cacheKey))
      .gt('created_at', cutoff)
      .maybeSingle();
    if (data?.results !== undefined && data?.results !== null) return data.results as unknown;
    return null;
  } catch {
    return null;
  }
}

/**
 * Save result to Supabase cache. Fire-and-forget.
 *
 * @param cacheKey - Human-readable key (will be hashed internally)
 * @param results  - Value to cache
 */
async function supabaseSet(cacheKey: string, results: unknown): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    await client.from('search_cache').upsert({
      query_hash: hashKey(cacheKey),
      results,
      created_at: new Date().toISOString(),
    });
  } catch {
    // Non-fatal
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if a cached value is usable — i.e. non-null and not an empty array.
 * Empty arrays may have been written by an older version of this module before the
 * "don't cache empty results" guard was added. Treating them as a cache miss ensures
 * a fresh Brave fetch is attempted rather than serving stale empty data.
 *
 * @param v - Value read from the cache store
 */
function isUsableCacheValue(v: unknown): boolean {
  return v !== null && !(Array.isArray(v) && v.length === 0);
}

/**
 * Wraps a Brave Search call with a 24-hour cache.
 *
 * Check order: Redis → Supabase → fetch from Brave.
 * On a miss, runs `fetchFn`, stores result in Redis (primary) and
 * Supabase (fallback). Both writes are fire-and-forget.
 *
 * Empty arrays are treated as cache misses on both read and write:
 * an empty result may be a transient Brave outage, not a permanent state.
 *
 * @param cacheKey - Unique key for this search (e.g. `articles|Acme A/S|12345678`)
 * @param fetchFn  - Async function that performs the actual Brave search
 * @returns Cached or freshly fetched results
 */
export async function withBraveCache<T>(cacheKey: string, fetchFn: () => Promise<T>): Promise<T> {
  // 1. Try Redis first (fast path)
  const redisCached = await redisGet(cacheKey);
  if (isUsableCacheValue(redisCached)) return redisCached as T;

  // 2. Try Supabase fallback
  const supabaseCached = await supabaseGet(cacheKey);
  if (isUsableCacheValue(supabaseCached)) {
    // Backfill Redis for next time
    redisSet(cacheKey, supabaseCached).catch(() => {});
    return supabaseCached as T;
  }

  // 3. Fetch from Brave
  const results = await fetchFn();

  // Do not cache empty arrays — an empty result may be a transient Brave outage,
  // not a permanent "no articles exist" state. Caching it would lock users out for 24h.
  const isEmpty = Array.isArray(results) && results.length === 0;
  if (!isEmpty) {
    redisSet(cacheKey, results).catch(() => {});
    supabaseSet(cacheKey, results).catch(() => {});
  }

  return results;
}
