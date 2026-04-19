/**
 * Unit tests for darHentAdresserBatch (BIZZ-507).
 *
 * The helper uses DAR_Adresse `in:[…]` filter to resolve etage/dør for a
 * batch of UUIDs at once. These tests lock the behaviour that matters
 * for callers (fetchBbrData.fetchDAWAEnhedAdresser): empty return on no
 * API key, filtering of malformed UUIDs, correct mapping of node fields,
 * and guards against a bogus `in:[]` payload.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockLoggerWarn = vi.fn();
vi.mock('@/app/lib/logger', () => ({
  logger: {
    log: vi.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
  },
}));

import { darHentAdresserBatch } from '@/app/lib/dar';

function mockFetchResolving(body: unknown, ok = true): typeof fetch {
  return vi.fn(() =>
    Promise.resolve({
      ok,
      status: ok ? 200 : 500,
      statusText: ok ? 'OK' : 'ISE',
      json: () => Promise.resolve(body),
    } as unknown as Response)
  ) as typeof fetch;
}

const UUID_A = '00000000-0000-0000-0000-00000000000a';
const UUID_B = '00000000-0000-0000-0000-00000000000b';

describe('darHentAdresserBatch (BIZZ-507)', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.DATAFORDELER_API_KEY;

  beforeEach(() => {
    mockLoggerWarn.mockClear();
    process.env.DATAFORDELER_API_KEY = 'test-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.DATAFORDELER_API_KEY = originalKey;
  });

  it('returns empty map (and warns) when DATAFORDELER_API_KEY is missing', async () => {
    delete process.env.DATAFORDELER_API_KEY;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await darHentAdresserBatch([UUID_A]);
    expect(result.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it('maps DAR_Adresse nodes to the legacy { etage, doer, adressebetegnelse } shape', async () => {
    global.fetch = mockFetchResolving({
      data: {
        DAR_Adresse: {
          nodes: [
            {
              id_lokalId: UUID_A,
              adressebetegnelse: 'Bredgade 1, 2. tv., 1260 København K',
              etagebetegnelse: '2',
              doerbetegnelse: 'tv',
            },
            {
              id_lokalId: UUID_B,
              adressebetegnelse: 'Bredgade 1, st., 1260 København K',
              etagebetegnelse: 'st',
              doerbetegnelse: '',
            },
          ],
        },
      },
    });

    const result = await darHentAdresserBatch([UUID_A, UUID_B]);
    expect(result.size).toBe(2);
    expect(result.get(UUID_A)).toEqual({
      etage: '2',
      doer: 'tv',
      adressebetegnelse: 'Bredgade 1, 2. tv., 1260 København K',
    });
    // Empty dør string normalised to null — same semantic as DAWA path
    expect(result.get(UUID_B)).toEqual({
      etage: 'st',
      doer: null,
      adressebetegnelse: 'Bredgade 1, st., 1260 København K',
    });
  });

  it('filters malformed UUIDs before hitting the network', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await darHentAdresserBatch(['not-a-uuid', '12345', '']);
    expect(result.size).toBe(0);
    // No UUIDs left → no fetch at all (avoids bogus `in:[]` query)
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dedupes UUIDs before querying', async () => {
    let lastBody: string | undefined;
    global.fetch = vi.fn((_, init?: RequestInit) => {
      lastBody = init?.body ? String(init.body) : '';
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { DAR_Adresse: { nodes: [] } } }),
      } as Response);
    }) as typeof fetch;

    await darHentAdresserBatch([UUID_A, UUID_A, UUID_A]);
    // Body should contain UUID_A exactly once in the `in:[…]` list
    const occurrences = (lastBody ?? '').split(UUID_A).length - 1;
    expect(occurrences).toBe(1);
  });

  it('returns empty map when DAR_Adresse response has no nodes', async () => {
    global.fetch = mockFetchResolving({
      data: { DAR_Adresse: { nodes: [] } },
    });
    const result = await darHentAdresserBatch([UUID_A]);
    expect(result.size).toBe(0);
  });

  it('returns empty map on GraphQL error (never throws)', async () => {
    global.fetch = mockFetchResolving({
      errors: [{ message: 'schema drift' }],
    });
    const result = await darHentAdresserBatch([UUID_A]);
    expect(result.size).toBe(0);
  });
});
