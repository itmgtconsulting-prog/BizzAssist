/**
 * Unit tests for the recentSearches module.
 *
 * Tests localStorage-based recent search persistence:
 * - Saving and retrieving searches
 * - Deduplication by query
 * - Max entries trimming
 * - Clearing all entries
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock localStorage
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    store[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete store[key];
  }),
  clear: vi.fn(() => {
    Object.keys(store).forEach((k) => delete store[k]);
  }),
  get length() {
    return Object.keys(store).length;
  },
  key: vi.fn(() => null),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

import { getRecentSearches, saveRecentSearch, clearRecentSearches } from '@/app/lib/recentSearches';

describe('recentSearches', () => {
  beforeEach(() => {
    localStorageMock.clear();
    clearRecentSearches();
    vi.clearAllMocks();
  });

  it('returns empty array when no searches saved', () => {
    expect(getRecentSearches()).toEqual([]);
  });

  it('saves and retrieves a search entry', () => {
    saveRecentSearch({ query: 'test', ts: 1000 });
    const results = getRecentSearches();
    expect(results).toHaveLength(1);
    expect(results[0].query).toBe('test');
    expect(results[0].ts).toBe(1000);
  });

  it('deduplicates by query (case-insensitive)', () => {
    saveRecentSearch({ query: 'Test Query', ts: 1000 });
    saveRecentSearch({ query: 'test query', ts: 2000 });
    const results = getRecentSearches();
    expect(results).toHaveLength(1);
    expect(results[0].ts).toBe(2000); // newer entry
  });

  it('keeps newest first', () => {
    saveRecentSearch({ query: 'first', ts: 1000 });
    saveRecentSearch({ query: 'second', ts: 2000 });
    const results = getRecentSearches();
    expect(results[0].query).toBe('second');
    expect(results[1].query).toBe('first');
  });

  it('trims to max 10 entries', () => {
    for (let i = 0; i < 15; i++) {
      saveRecentSearch({ query: `query-${i}`, ts: i * 1000 });
    }
    const results = getRecentSearches();
    expect(results.length).toBeLessThanOrEqual(10);
  });

  it('clears all entries', () => {
    saveRecentSearch({ query: 'test', ts: 1000 });
    clearRecentSearches();
    expect(getRecentSearches()).toEqual([]);
  });

  it('stores optional result metadata', () => {
    saveRecentSearch({
      query: 'Vesterbrogade',
      ts: 1000,
      resultType: 'address',
      resultTitle: 'Vesterbrogade 1, 1620 København V',
      resultHref: '/dashboard/ejendomme/abc-123',
    });
    const results = getRecentSearches();
    expect(results[0].resultType).toBe('address');
    expect(results[0].resultTitle).toBe('Vesterbrogade 1, 1620 København V');
    expect(results[0].resultHref).toBe('/dashboard/ejendomme/abc-123');
  });
});
