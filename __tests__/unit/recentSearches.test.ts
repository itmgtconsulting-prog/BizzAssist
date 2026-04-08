/**
 * Unit tests for the recentSearches module.
 *
 * The module uses an in-memory cache that syncs to Supabase via /api/recents.
 * fetch() is mocked globally so no real network calls are made.
 *
 * Covers:
 * - getRecentSearches: empty cache, cached data, background fetch trigger
 * - saveRecentSearch: deduplication, ordering, max-limit pruning, metadata, entity types
 * - clearRecentSearches: wipes cache and fires DELETE
 * - refreshRecentSearches: forces a fresh server fetch and updates cache
 */
import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest';

// ── Mock fetch globally before module import ──────────────────────────────────
const mockFetch = vi.fn() as MockedFunction<typeof fetch>;
// Always provide a safe default so fire-and-forget calls don't throw
mockFetch.mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({}),
} as unknown as Response);
vi.stubGlobal('fetch', mockFetch);

// Helper: build a minimal Response-like object
function makeResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// Import after stubbing so the module picks up the mock
import {
  getRecentSearches,
  saveRecentSearch,
  clearRecentSearches,
  refreshRecentSearches,
  type RecentSearch,
} from '@/app/lib/recentSearches';

// Helper: reset the internal _cache between tests
async function resetCache(): Promise<void> {
  clearRecentSearches(); // sets _cache = []
}

describe('recentSearches', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-establish safe default after clearAllMocks wipes it
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    } as unknown as Response);
    await resetCache();
  });

  // ── getRecentSearches ──────────────────────────────────────────────────────

  describe('getRecentSearches', () => {
    it('returns empty array when cache is empty (just cleared)', () => {
      expect(getRecentSearches()).toEqual([]);
    });

    it('returns cached entries immediately after save', () => {
      saveRecentSearch({ query: 'Aarhus', ts: 1000 });
      const result = getRecentSearches();
      expect(result).toHaveLength(1);
      expect(result[0].query).toBe('Aarhus');
    });

    it('returns multiple cached entries in order', () => {
      saveRecentSearch({ query: 'first', ts: 1000 });
      saveRecentSearch({ query: 'second', ts: 2000 });
      const result = getRecentSearches();
      expect(result[0].query).toBe('second');
      expect(result[1].query).toBe('first');
    });
  });

  // ── saveRecentSearch ───────────────────────────────────────────────────────

  describe('saveRecentSearch', () => {
    it('saves a basic search entry and retrieves it', () => {
      const entry: RecentSearch = { query: 'Test', ts: 9999 };
      saveRecentSearch(entry);
      const results = getRecentSearches();
      expect(results).toHaveLength(1);
      expect(results[0].query).toBe('Test');
      expect(results[0].ts).toBe(9999);
    });

    it('deduplicates by query text (exact match)', () => {
      saveRecentSearch({ query: 'duplikat', ts: 1000 });
      saveRecentSearch({ query: 'duplikat', ts: 2000 });
      const results = getRecentSearches();
      expect(results).toHaveLength(1);
      expect(results[0].ts).toBe(2000);
    });

    it('deduplicates case-insensitively', () => {
      saveRecentSearch({ query: 'Vesterbrogade', ts: 1000 });
      saveRecentSearch({ query: 'vesterbrogade', ts: 2000 });
      const results = getRecentSearches();
      expect(results).toHaveLength(1);
      expect(results[0].ts).toBe(2000);
    });

    it('deduplicates mixed case from both sides', () => {
      saveRecentSearch({ query: 'AARHUS', ts: 500 });
      saveRecentSearch({ query: 'aarhus', ts: 600 });
      saveRecentSearch({ query: 'Aarhus', ts: 700 });
      const results = getRecentSearches();
      expect(results).toHaveLength(1);
      expect(results[0].ts).toBe(700);
    });

    it('keeps newest entry first (prepends)', () => {
      saveRecentSearch({ query: 'alpha', ts: 100 });
      saveRecentSearch({ query: 'beta', ts: 200 });
      saveRecentSearch({ query: 'gamma', ts: 300 });
      const results = getRecentSearches();
      expect(results[0].query).toBe('gamma');
      expect(results[1].query).toBe('beta');
      expect(results[2].query).toBe('alpha');
    });

    it('trims to maximum 10 entries', () => {
      for (let i = 0; i < 15; i++) {
        saveRecentSearch({ query: `unique-query-${i}`, ts: i * 100 });
      }
      expect(getRecentSearches().length).toBe(10);
    });

    it('trims oldest entries when limit is exceeded', () => {
      for (let i = 0; i < 12; i++) {
        saveRecentSearch({ query: `q${i}`, ts: i * 100 });
      }
      const results = getRecentSearches();
      // The last 10 saved (q2..q11) should be present, oldest dropped
      expect(results.some((r) => r.query === 'q0')).toBe(false);
      expect(results.some((r) => r.query === 'q1')).toBe(false);
      expect(results.some((r) => r.query === 'q11')).toBe(true);
    });

    it('stores address resultType metadata', () => {
      saveRecentSearch({
        query: 'Vesterbrogade 1',
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

    it('stores company resultType metadata', () => {
      saveRecentSearch({
        query: 'Novo Nordisk',
        ts: 2000,
        resultType: 'company',
        resultTitle: 'Novo Nordisk A/S',
        resultHref: '/dashboard/companies/12345678',
      });
      const results = getRecentSearches();
      expect(results[0].resultType).toBe('company');
      expect(results[0].resultTitle).toBe('Novo Nordisk A/S');
      expect(results[0].resultHref).toBe('/dashboard/companies/12345678');
    });

    it('stores person resultType metadata', () => {
      saveRecentSearch({
        query: 'Jakob Juul',
        ts: 3000,
        resultType: 'person',
        resultTitle: 'Jakob Juul Rasmussen',
        resultHref: '/dashboard/owners/some-id',
      });
      const results = getRecentSearches();
      expect(results[0].resultType).toBe('person');
    });

    it('handles entry with no optional fields', () => {
      saveRecentSearch({ query: 'bare minimum', ts: 1 });
      const results = getRecentSearches();
      expect(results[0].resultType).toBeUndefined();
      expect(results[0].resultTitle).toBeUndefined();
      expect(results[0].resultHref).toBeUndefined();
    });

    it('fires a background POST to /api/recents', () => {
      mockFetch.mockResolvedValue(makeResponse({ ok: true }));
      saveRecentSearch({ query: 'fire-and-forget', ts: 1 });
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/recents',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('sends correct entity_type in POST body', () => {
      mockFetch.mockResolvedValue(makeResponse({ ok: true }));
      saveRecentSearch({ query: 'body check', ts: 1 });
      // Find the POST call (clearRecentSearches in beforeEach fires a DELETE first)
      const postCall = mockFetch.mock.calls.find(
        ([, opts]) => (opts as RequestInit)?.method === 'POST'
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body.entity_type).toBe('search');
      expect(body.display_name).toBe('body check');
    });

    it('sends lowercased trimmed query as entity_id', () => {
      mockFetch.mockResolvedValue(makeResponse({ ok: true }));
      saveRecentSearch({ query: '  ODENSE  ', ts: 1 });
      const postCall = mockFetch.mock.calls.find(
        ([, opts]) => (opts as RequestInit)?.method === 'POST'
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body.entity_id).toBe('odense');
    });
  });

  // ── clearRecentSearches ────────────────────────────────────────────────────

  describe('clearRecentSearches', () => {
    it('empties the in-memory cache', () => {
      saveRecentSearch({ query: 'to-be-cleared', ts: 1 });
      clearRecentSearches();
      expect(getRecentSearches()).toEqual([]);
    });

    it('allows new entries after clearing', () => {
      saveRecentSearch({ query: 'old', ts: 1 });
      clearRecentSearches();
      saveRecentSearch({ query: 'new', ts: 2 });
      const results = getRecentSearches();
      expect(results).toHaveLength(1);
      expect(results[0].query).toBe('new');
    });

    it('fires a DELETE request to /api/recents', () => {
      mockFetch.mockResolvedValue(makeResponse(null));
      clearRecentSearches();
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/recents?type=search',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  // ── refreshRecentSearches ──────────────────────────────────────────────────

  describe('refreshRecentSearches', () => {
    it('returns an empty array when server returns no recents', async () => {
      mockFetch.mockResolvedValue(makeResponse({ recents: [] }));
      const results = await refreshRecentSearches();
      expect(results).toEqual([]);
    });

    it('maps server rows to RecentSearch format', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          recents: [
            {
              display_name: 'Søgning fra server',
              visited_at: '2024-01-15T10:00:00Z',
              entity_data: {
                resultType: 'address',
                resultTitle: 'Nørrebrogade 1',
                resultHref: '/dashboard/ejendomme/x',
              },
            },
          ],
        })
      );
      const results = await refreshRecentSearches();
      expect(results).toHaveLength(1);
      expect(results[0].query).toBe('Søgning fra server');
      expect(results[0].resultType).toBe('address');
      expect(results[0].resultTitle).toBe('Nørrebrogade 1');
      expect(results[0].resultHref).toBe('/dashboard/ejendomme/x');
    });

    it('uses Date.now() for rows with no visited_at', async () => {
      const before = Date.now();
      mockFetch.mockResolvedValue(
        makeResponse({
          recents: [{ display_name: 'no-ts', visited_at: null, entity_data: {} }],
        })
      );
      const results = await refreshRecentSearches();
      const after = Date.now();
      expect(results[0].ts).toBeGreaterThanOrEqual(before);
      expect(results[0].ts).toBeLessThanOrEqual(after);
    });

    it('updates the in-memory cache so getRecentSearches returns fresh data', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({
          recents: [
            {
              display_name: 'cached-after-refresh',
              visited_at: '2024-01-01T00:00:00Z',
              entity_data: {},
            },
          ],
        })
      );
      await refreshRecentSearches();
      const cached = getRecentSearches();
      expect(cached).toHaveLength(1);
      expect(cached[0].query).toBe('cached-after-refresh');
    });

    it('returns empty array when server responds with non-ok status', async () => {
      mockFetch.mockResolvedValue(makeResponse(null, false));
      const results = await refreshRecentSearches();
      expect(results).toEqual([]);
    });

    it('returns empty array when fetch throws a network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network failure'));
      const results = await refreshRecentSearches();
      expect(results).toEqual([]);
    });

    it('handles missing recents key in response gracefully', async () => {
      mockFetch.mockResolvedValue(makeResponse({}));
      const results = await refreshRecentSearches();
      expect(results).toEqual([]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Background-fetch path in getRecentSearches (covers lines 43-59)
//
// When _cache === null (fresh module, never set), getRecentSearches() returns []
// immediately AND fires a background fetch that populates the cache.
// We test this by importing a fresh module instance with vi.resetModules().
// ─────────────────────────────────────────────────────────────────────────────

describe('getRecentSearches — background fetch path (_cache === null)', () => {
  it('returns [] immediately when cache is null and fires a background fetch', async () => {
    // Arrange: provide a successful fetch response for the background load
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          recents: [
            {
              display_name: 'bg-fetch-result',
              visited_at: '2024-06-01T00:00:00Z',
              entity_data: { resultType: 'address', resultTitle: null, resultHref: null },
            },
          ],
        }),
    } as unknown as Response);

    // Reset modules so _cache is null again (fresh import)
    vi.resetModules();
    const freshModule = await import('@/app/lib/recentSearches');

    // Act: call before the background fetch resolves
    const immediate = freshModule.getRecentSearches();

    // Returns empty immediately (cache is null → triggers background fetch → returns [])
    expect(immediate).toEqual([]);

    // Wait for background fetch to complete and populate the cache
    await vi.waitFor(() => {
      const afterFetch = freshModule.getRecentSearches();
      expect(afterFetch.length).toBeGreaterThan(0);
    });

    const cached = freshModule.getRecentSearches();
    expect(cached[0].query).toBe('bg-fetch-result');

    // Calling getRecentSearches again does NOT trigger another fetch
    const callsBefore = mockFetch.mock.calls.length;
    freshModule.getRecentSearches();
    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });

  it('does not fire a second background fetch while one is already in flight', async () => {
    // Use a fetch that never resolves so the request stays in-flight
    let resolveHangingFetch!: (v: Response) => void;
    const hangingPromise = new Promise<Response>((res) => {
      resolveHangingFetch = res;
    });
    mockFetch.mockReturnValueOnce(hangingPromise as unknown as Promise<Response>);

    vi.resetModules();
    const freshModule = await import('@/app/lib/recentSearches');

    const fetchCallsBefore = mockFetch.mock.calls.length;

    // First call — starts the background fetch
    freshModule.getRecentSearches();
    // Second call — should NOT start another fetch
    freshModule.getRecentSearches();

    // Only one new fetch call should have been made
    expect(mockFetch.mock.calls.length).toBe(fetchCallsBefore + 1);

    // Clean up: resolve the hanging promise
    resolveHangingFetch({
      ok: false,
      json: () => Promise.resolve(null),
    } as unknown as Response);
  });
});
