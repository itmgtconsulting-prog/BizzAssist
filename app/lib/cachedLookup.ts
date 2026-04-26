/**
 * cachedLookup — cache-first data-hentning med live-fallback.
 *
 * BIZZ-913: Generisk pattern for at hente data fra lokal cache (Supabase)
 * med transparent fallback til live API ved cache miss eller stale data.
 *
 * Flow:
 *   1. Tjek cache (cache_bbr, cache_cvr, cache_dar, cache_vur)
 *   2. Hvis hit og ikke stale → returner cached data
 *   3. Hvis miss eller stale → kald live API → upsert til cache → returner
 *
 * Staleness threshold er konfigurerbar per datakilde:
 *   BBR: 7 dage, CVR: 1 dag, DAR: 30 dage, VUR: 30 dage
 *
 * @module app/lib/cachedLookup
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import crypto from 'crypto';

// ─── Config ──────────────────────────────────────────────────────────────────

/** Max alder i millisekunder før cache anses som stale. */
const STALE_THRESHOLDS: Record<string, number> = {
  bbr: 7 * 24 * 60 * 60 * 1000, // 7 dage
  cvr: 1 * 24 * 60 * 60 * 1000, // 1 dag
  dar: 30 * 24 * 60 * 60 * 1000, // 30 dage
  vur: 30 * 24 * 60 * 60 * 1000, // 30 dage
};

// ─── Generisk cache-lookup ───────────────────────────────────────────────────

interface CacheResult<T> {
  /** Data fra cache eller live API */
  data: T | null;
  /** Om data kom fra cache (true) eller live API (false) */
  fromCache: boolean;
  /** Om cache var stale og blev opdateret */
  refreshed: boolean;
}

/**
 * Generisk cache-lookup med fallback.
 *
 * @param table - Cache-tabelnavn (fx 'cache_bbr')
 * @param keyColumn - Primærnøgle-kolonne (fx 'bfe_nummer')
 * @param keyValue - Primærnøgle-værdi
 * @param source - Datakilde-navn for staleness (fx 'bbr')
 * @param liveFetcher - Asynkron funktion der henter live data
 * @returns CacheResult med data + metadata
 */
export async function cachedLookup<T>(
  table: string,
  keyColumn: string,
  keyValue: string | number,
  source: string,
  liveFetcher: () => Promise<T | null>
): Promise<CacheResult<T>> {
  const admin = createAdminClient();
  const staleMs = STALE_THRESHOLDS[source] ?? 7 * 24 * 60 * 60 * 1000;

  try {
    // Step 1: Cache lookup
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: cached, error: cacheErr } = await (admin as any)
      .from(table)
      .select('raw_data, synced_at')
      .eq(keyColumn, keyValue)
      .single();

    if (!cacheErr && cached?.raw_data) {
      const syncedAt = new Date(cached.synced_at).getTime();
      const age = Date.now() - syncedAt;

      if (age < staleMs) {
        // Cache hit — data er frisk
        return { data: cached.raw_data as T, fromCache: true, refreshed: false };
      }
      // Cache hit men stale — refresh i baggrunden, returner stale data
      logger.log(
        `[cachedLookup] ${source}/${keyValue} stale (${Math.round(age / 3600000)}h), refreshing`
      );
    }
  } catch (err) {
    logger.warn(
      `[cachedLookup] ${source}/${keyValue} cache read fejl:`,
      err instanceof Error ? err.message : err
    );
  }

  // Step 2: Live API fallback
  try {
    const liveData = await liveFetcher();
    if (liveData == null) {
      return { data: null, fromCache: false, refreshed: false };
    }

    // Step 3: Upsert til cache (fire-and-forget)
    const rawJson = JSON.stringify(liveData);
    const hash = crypto.createHash('sha256').update(rawJson).digest('hex');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void (admin as any)
      .from(table)
      .upsert(
        {
          [keyColumn]: keyValue,
          raw_data: liveData,
          source_hash: hash,
          synced_at: new Date().toISOString(),
        },
        { onConflict: keyColumn }
      )
      .then(() => {
        logger.log(`[cachedLookup] ${source}/${keyValue} cached`);
      })
      .catch((err: Error) => {
        logger.warn(`[cachedLookup] ${source}/${keyValue} cache write fejl:`, err.message);
      });

    return { data: liveData, fromCache: false, refreshed: true };
  } catch (err) {
    logger.warn(
      `[cachedLookup] ${source}/${keyValue} live fetch fejl:`,
      err instanceof Error ? err.message : err
    );
    return { data: null, fromCache: false, refreshed: false };
  }
}

// ─── Convenience wrappers ────────────────────────────────────────────────────

/**
 * Hent BBR-data for en ejendom via cache med live-fallback.
 *
 * @param bfeNummer - BFE-nummer
 * @param liveFetcher - Funktion der henter fra Datafordeler BBR
 * @returns CacheResult med BBR-data
 */
export function getCachedBBR<T>(
  bfeNummer: number,
  liveFetcher: () => Promise<T | null>
): Promise<CacheResult<T>> {
  return cachedLookup('cache_bbr', 'bfe_nummer', bfeNummer, 'bbr', liveFetcher);
}

/**
 * Hent CVR-data for en virksomhed via cache med live-fallback.
 *
 * @param cvrNummer - 8-cifret CVR-nummer
 * @param liveFetcher - Funktion der henter fra CVR ES
 * @returns CacheResult med CVR-data
 */
export function getCachedCVR<T>(
  cvrNummer: number,
  liveFetcher: () => Promise<T | null>
): Promise<CacheResult<T>> {
  return cachedLookup('cache_cvr', 'cvr_nummer', cvrNummer, 'cvr', liveFetcher);
}

/**
 * Hent DAR-adressedata via cache med live-fallback.
 *
 * @param adresseId - DAWA adgangsadresse UUID
 * @param liveFetcher - Funktion der henter fra DAR/DAWA
 * @returns CacheResult med adresse-data
 */
export function getCachedDAR<T>(
  adresseId: string,
  liveFetcher: () => Promise<T | null>
): Promise<CacheResult<T>> {
  return cachedLookup('cache_dar', 'adresse_id', adresseId, 'dar', liveFetcher);
}

/**
 * Hent VUR-data for en ejendom via cache med live-fallback.
 *
 * @param bfeNummer - BFE-nummer
 * @param liveFetcher - Funktion der henter fra Datafordeler VUR
 * @returns CacheResult med vurderingsdata
 */
export function getCachedVUR<T>(
  bfeNummer: number,
  liveFetcher: () => Promise<T | null>
): Promise<CacheResult<T>> {
  return cachedLookup('cache_vur', 'bfe_nummer', bfeNummer, 'vur', liveFetcher);
}
