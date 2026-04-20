/**
 * BIZZ-600: Simpel LRU-cache med TTL.
 *
 * CLAUDE.md kræver max 150 entries + TTL for gentagne external API-calls
 * inden for en session. Implementeret uden ekstern dependency for at
 * holde bundle-size lav og undgå endnu et npm audit-check.
 *
 * Typisk brug:
 *   const cache = new LruCache<string, MyData>({ maxSize: 150, ttlMs: 3600_000 });
 *   const cached = cache.get(key); if (cached) return cached;
 *   const data = await fetchExpensive();
 *   cache.set(key, data);
 *
 * Thread-safety: JavaScript's single-threaded event loop garanterer at
 * get/set er atomare. Flere samtidige requests for samme key vil
 * hver trigge fetch'en (ingen dedup) — tilføj request-coalescing separat
 * hvis det bliver et issue (sjældent for CLAUDE.md's usage pattern).
 *
 * NB: Cachen lever i serverprocessen — i Vercel serverless miljøet deles
 * den IKKE mellem function invocations. Det er acceptabelt for
 * single-session caching; distribueret caching kræver Redis/KV.
 */

/** Konfiguration for en LRU-cache instance */
export interface LruCacheOptions {
  /** Maksimalt antal entries. Ved overskridelse evictes eldste. Default 150. */
  maxSize?: number;
  /** Time-to-live i millisekunder. 0 = uendelig. Default 1 time. */
  ttlMs?: number;
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number; // Infinity hvis ttlMs = 0
}

/**
 * LRU-cache med TTL. Brug Map's iteration-order (insertion order) som
 * LRU-implementation: ved get flyttes entry til slutningen; ved overflow
 * evictes første entry (oldest).
 */
export class LruCache<K, V> {
  private readonly max: number;
  private readonly ttl: number;
  private readonly store = new Map<K, CacheEntry<V>>();

  constructor(opts: LruCacheOptions = {}) {
    this.max = Math.max(1, opts.maxSize ?? 150);
    this.ttl = opts.ttlMs ?? 3_600_000;
  }

  /**
   * Hent value for key hvis den findes og ikke er udløbet.
   * Udløbet entry fjernes ved hit — lazy eviction.
   */
  get(key: K): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Move to end (most-recently-used) ved at re-sætte
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }

  /** Sæt value for key. Evicter eldste entry hvis cachen er fuld. */
  set(key: K, value: V): void {
    // Opdater ved eksisterende key → fjern først for at flytte til slut
    if (this.store.has(key)) this.store.delete(key);
    else if (this.store.size >= this.max) {
      // Evict oldest (first key in iteration order)
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, {
      value,
      expiresAt: this.ttl > 0 ? Date.now() + this.ttl : Infinity,
    });
  }

  /** Slet specifik entry. Returnerer true hvis key fandtes. */
  delete(key: K): boolean {
    return this.store.delete(key);
  }

  /** Ryd hele cachen. Bruges typisk ved logout eller tenant-skift. */
  clear(): void {
    this.store.clear();
  }

  /** Antal entries i cachen (inkl. evt. udløbne der ikke er evicted endnu) */
  get size(): number {
    return this.store.size;
  }

  /**
   * Helper der wrapper en async loader med cache-lookup.
   * Returnerer cached value hvis tilstede, ellers kalder loader og cacher.
   * Loader-exceptions cacher IKKE — så fejlede fetches retries næste gang.
   */
  async getOrLoad(key: K, loader: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await loader();
    this.set(key, value);
    return value;
  }
}

/**
 * Pr. call-site singleton pattern: opret én LRU pr. ressource-type i
 * module-scope så de deles på tværs af requests i samme serverproces.
 * Eksempel:
 *   const dawaPostnrCache = new LruCache<string, Kommune>({ ttlMs: 86_400_000 });
 */
