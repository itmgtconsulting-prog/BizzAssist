/**
 * Brave Search result cache — server-side only.
 *
 * Wraps Brave Search calls with a 24-hour Supabase cache to reduce API spend.
 * Cache key = SHA-256 of the query string + any variant params.
 * Stored in public.search_cache (see migration 017_search_cache.sql).
 *
 * Usage:
 *   import { withBraveCache } from '@/app/lib/searchCache';
 *   const results = await withBraveCache(`articles|${companyName}|${cvr}`, () =>
 *     searchBraveArticles(key, companyName)
 *   );
 */

import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

/** Cache TTL in hours */
const CACHE_TTL_HOURS = 24;

/**
 * Returns a short SHA-256 hex digest of the input string.
 *
 * @param input - String to hash
 * @returns 32-char hex string
 */
function hashKey(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

/**
 * Fetches a cached search result for the given key.
 * Returns null if not found, expired, or Supabase is unavailable.
 *
 * @param cacheKey - Human-readable key (will be hashed internally)
 * @returns Cached result (any JSON value), or null on miss
 */
async function getCached(cacheKey: string): Promise<unknown | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const cutoff = new Date(Date.now() - CACHE_TTL_HOURS * 3_600_000).toISOString();
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
 * Saves search results to the cache. Fire-and-forget — failures are silently ignored.
 *
 * @param cacheKey - Human-readable key (will be hashed internally)
 * @param results  - Value to cache (array or object)
 */
async function saveCache(cacheKey: string, results: unknown): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    await client.from('search_cache').upsert({
      query_hash: hashKey(cacheKey),
      results,
      created_at: new Date().toISOString(),
    });
  } catch {
    // Cache write failures are non-fatal — Brave API will be called next time
  }
}

/**
 * Wraps a Brave Search call with a 24-hour Supabase cache.
 *
 * Checks the cache before calling Brave. On a miss, runs `fetchFn`, stores
 * the result, and returns it. Cache write is fire-and-forget.
 *
 * @param cacheKey - Unique key for this search (e.g. `articles|Acme A/S|12345678`)
 * @param fetchFn  - Async function that performs the actual Brave search
 * @returns Cached or freshly fetched results
 */
export async function withBraveCache<T>(cacheKey: string, fetchFn: () => Promise<T>): Promise<T> {
  const cached = await getCached(cacheKey);
  if (cached !== null) return cached as T;

  const results = await fetchFn();
  // Fire-and-forget — do not await so it doesn't block the response
  saveCache(cacheKey, results).catch(() => {});
  return results;
}
