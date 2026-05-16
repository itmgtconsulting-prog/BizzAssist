/**
 * Server-side cache for ejerskab-chain responses (BIZZ-1582).
 *
 * Wraps en computation med Supabase-backed lookup: cache-hit returnerer
 * payload uden eksterne API-kald (Tinglysning XML + CVR ES + EJF kæder
 * tager 1.5-5s; cache-hit < 50ms). Cache-miss kører computation og
 * persisterer resultatet til genbrug.
 *
 * Default TTL 6 timer — egnet for ejerskabsdata der ændrer sig i
 * timeskalaen "dage" (typiske tinglysninger). Invalideres mere agressivt
 * af nightly pull-tinglysning-aendringer cron når en BFE har nye
 * hændelser (planlagt i follow-up).
 *
 * @module app/lib/ejerskab/cache
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/app/lib/logger';

/** Default TTL i minutter (6 timer) */
const DEFAULT_TTL_MINUTES = 360;

/** Service-role client — lazy init */
let _client: SupabaseClient | null = null;

/** Reset cached client (kun til tests) */
export function _resetClientForTests(): void {
  _client = null;
}

function getServiceClient(): SupabaseClient | null {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

/** Cache-entry shape som det er gemt i DB */
interface CacheRow {
  cache_key: string;
  payload: unknown;
  fetched_at: string;
  ttl_minutes: number;
  hit_count: number;
}

/**
 * Læs en cache-entry hvis den findes og er frisk (inden for TTL).
 *
 * @param cacheKey - Fuld cache-key (fx 'ejerskab-chain:bfe:12345:type:hus')
 * @returns Payload typed som T, eller null ved miss/stale/fejl
 */
export async function getCached<T>(cacheKey: string): Promise<T | null> {
  const client = getServiceClient();
  if (!client) return null;
  try {
    const { data, error } = await client
      .from('ejerskab_cache')
      .select('payload, fetched_at, ttl_minutes')
      .eq('cache_key', cacheKey)
      .maybeSingle<Pick<CacheRow, 'payload' | 'fetched_at' | 'ttl_minutes'>>();

    if (error || !data) return null;

    const ageMs = Date.now() - new Date(data.fetched_at).getTime();
    const ttlMs = data.ttl_minutes * 60 * 1000;
    if (ageMs > ttlMs) return null;

    // Fire-and-forget hit-count bump (undgår blokering af læsning)
    void bumpHitCount(client, cacheKey);

    return data.payload as T;
  } catch (err) {
    logger.warn('[ejerskab/cache] getCached fejl:', err);
    return null;
  }
}

/**
 * Bump last_hit_at — fail-soft. hit_count incrementeres ikke pt (kræver
 * RPC for atomic counter; postgrest update tillader ikke col = col + 1
 * uden RPC). Mest værdifulde signal er last_hit_at — bruges af
 * prewarm-cron til at vælge top-N at refreshe.
 */
async function bumpHitCount(client: SupabaseClient, cacheKey: string): Promise<void> {
  try {
    await client
      .from('ejerskab_cache')
      .update({ last_hit_at: new Date().toISOString() })
      .eq('cache_key', cacheKey);
  } catch {
    // ignore — read-pathen fortsætter
  }
}

/**
 * Skriv payload til cache. Upsert — overskriver eksisterende entry og
 * nulstiller hit_count.
 *
 * @param cacheKey - Cache-key
 * @param payload - Værdi at cache (skal være JSON-serialiserbar)
 * @param bfeNummer - Optional BFE for at kunne invalidere per ejendom
 * @param ttlMinutes - TTL (default 360 = 6t)
 */
export async function setCached(
  cacheKey: string,
  payload: unknown,
  options: { bfeNummer?: number; ttlMinutes?: number } = {}
): Promise<void> {
  const client = getServiceClient();
  if (!client) return;
  try {
    await client.from('ejerskab_cache').upsert(
      {
        cache_key: cacheKey,
        bfe_nummer: options.bfeNummer ?? null,
        payload: payload as unknown as object,
        fetched_at: new Date().toISOString(),
        ttl_minutes: options.ttlMinutes ?? DEFAULT_TTL_MINUTES,
        hit_count: 0,
        last_hit_at: null,
      },
      { onConflict: 'cache_key' }
    );
  } catch (err) {
    logger.warn('[ejerskab/cache] setCached fejl:', err);
  }
}

/**
 * Slet alle cache-entries for én BFE — kaldes af tinglysning-aendringer
 * cron når en hændelse registreres på BFE'en.
 *
 * @param bfeNummer - BFE at invalidere
 * @returns Antal slettede rows
 */
export async function invalidateByBfe(bfeNummer: number): Promise<number> {
  const client = getServiceClient();
  if (!client) return 0;
  try {
    const { count, error } = await client
      .from('ejerskab_cache')
      .delete({ count: 'exact' })
      .eq('bfe_nummer', bfeNummer);
    if (error) throw error;
    return count ?? 0;
  } catch (err) {
    logger.warn('[ejerskab/cache] invalidateByBfe fejl:', err);
    return 0;
  }
}

/**
 * Convenience wrapper: hvis cached, returnér; ellers kør computation,
 * cache resultatet, og returnér det. Brug dette pattern i route-handlers.
 *
 * @param cacheKey - Cache-key
 * @param compute - Async funktion der producerer payload ved cache-miss
 * @param options - { bfeNummer, ttlMinutes }
 * @returns Payload (cached eller fresh)
 */
export async function withCache<T>(
  cacheKey: string,
  compute: () => Promise<T>,
  options: { bfeNummer?: number; ttlMinutes?: number } = {}
): Promise<{ payload: T; cached: boolean }> {
  const cached = await getCached<T>(cacheKey);
  if (cached !== null) {
    return { payload: cached, cached: true };
  }
  const fresh = await compute();
  // Fire-and-forget write — ingen grund til at lade brugeren vente på
  // cache-skrivning
  void setCached(cacheKey, fresh, options);
  return { payload: fresh, cached: false };
}

/**
 * Byg standard cache-key for ejerskab-chain responses.
 *
 * @param bfe - BFE-nummer
 * @param type - Ejendomstype-hint (typisk 'ejerlejlighed' eller blank)
 */
export function buildChainCacheKey(bfe: string | number, type: string = ''): string {
  const normalizedType = type.toLowerCase().includes('ejerlejlighed') ? 'lejlighed' : 'fuld';
  return `ejerskab-chain:bfe:${bfe}:type:${normalizedType}`;
}
