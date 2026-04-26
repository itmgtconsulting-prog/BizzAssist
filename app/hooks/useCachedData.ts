/**
 * useCachedData — React hook for cache-first data-hentning.
 *
 * BIZZ-919: Wraper API-kald med cache-metadata (fromCache, syncedAt).
 * API-routes skal returnere cache-headers som frontend kan læse.
 *
 * @param url - API URL at fetche
 * @param enabled - Om fetch skal køre (default true)
 * @returns { data, loading, fromCache, syncedAt }
 */

'use client';

import { useState, useEffect, useCallback } from 'react';

interface CachedDataResult<T> {
  /** Fetched data */
  data: T | null;
  /** true under loading */
  loading: boolean;
  /** Om data kom fra cache */
  fromCache: boolean;
  /** Tidspunkt for cache-sync (fra response header) */
  syncedAt: string | null;
  /** Fejlbesked */
  error: string | null;
  /** Manuel refresh-funktion */
  refresh: () => void;
}

/**
 * Hook for cache-aware data-hentning.
 * Læser `X-Cache-Hit` og `X-Synced-At` headers fra API-response.
 */
export function useCachedData<T>(url: string | null, enabled = true): CachedDataResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doFetch = useCallback(async () => {
    if (!url || !enabled) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        setError(`${res.status}`);
        return;
      }
      const json = (await res.json()) as T;
      setData(json);

      // Læs cache-metadata fra response headers
      const cacheHit = res.headers.get('X-Cache-Hit');
      const synced = res.headers.get('X-Synced-At');
      setFromCache(cacheHit === 'true');
      setSyncedAt(synced);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fetch error');
    } finally {
      setLoading(false);
    }
  }, [url, enabled]);

  useEffect(() => {
    doFetch();
  }, [doFetch]);

  return { data, loading, fromCache, syncedAt, error, refresh: doFetch };
}
