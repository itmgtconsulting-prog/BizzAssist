/**
 * Unit tests for LruCache (BIZZ-600).
 */
import { describe, it, expect, vi } from 'vitest';
import { LruCache } from '@/app/lib/lruCache';

describe('LruCache', () => {
  it('stores and retrieves values', () => {
    const cache = new LruCache<string, number>({ maxSize: 10 });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('respects maxSize and evicts least-recently-used', () => {
    const cache = new LruCache<string, number>({ maxSize: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // evicts 'a'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('get promotes entry to most-recently-used', () => {
    const cache = new LruCache<string, number>({ maxSize: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    // Access 'a' so 'b' becomes LRU
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3); // evicts 'b', not 'a'
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('expires entries after TTL', () => {
    vi.useFakeTimers();
    try {
      const cache = new LruCache<string, number>({ maxSize: 10, ttlMs: 1000 });
      cache.set('a', 1);
      expect(cache.get('a')).toBe(1);
      vi.advanceTimersByTime(1500);
      expect(cache.get('a')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ttlMs=0 means never expire', () => {
    vi.useFakeTimers();
    try {
      const cache = new LruCache<string, number>({ maxSize: 10, ttlMs: 0 });
      cache.set('a', 1);
      vi.advanceTimersByTime(1_000_000_000);
      expect(cache.get('a')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clear wipes all entries', () => {
    const cache = new LruCache<string, number>();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });

  it('delete removes specific entry', () => {
    const cache = new LruCache<string, number>();
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
  });

  it('getOrLoad caches loader result and reuses on subsequent calls', async () => {
    const cache = new LruCache<string, number>();
    const loader = vi.fn().mockResolvedValue(42);
    expect(await cache.getOrLoad('a', loader)).toBe(42);
    expect(await cache.getOrLoad('a', loader)).toBe(42);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('getOrLoad does not cache when loader throws', async () => {
    const cache = new LruCache<string, number>();
    const loader = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(99);
    await expect(cache.getOrLoad('a', loader)).rejects.toThrow('fail');
    expect(await cache.getOrLoad('a', loader)).toBe(99);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('updating existing key preserves maxSize', () => {
    const cache = new LruCache<string, number>({ maxSize: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10); // updates, does not evict
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe(10);
    expect(cache.get('b')).toBe(2);
  });

  it('maxSize defaults to 150', () => {
    const cache = new LruCache<number, number>();
    for (let i = 0; i < 200; i++) cache.set(i, i);
    expect(cache.size).toBe(150);
    expect(cache.get(0)).toBeUndefined(); // evicted
    expect(cache.get(199)).toBe(199); // kept
  });
});
