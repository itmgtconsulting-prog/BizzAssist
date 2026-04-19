/**
 * Unit tests for darResolveAdresseId (BIZZ-506).
 *
 * The helper walks DAR GraphQL 4 queries deep:
 *   NavngivenVej → Postnummer → Husnummer → Adresse
 *
 * Each step returns null on any empty/failed response so the caller can
 * fall back to DAWA cleanly. These tests mock `fetch` globally and assert
 * the chain terminates at the right step.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();
vi.mock('@/app/lib/logger', () => ({
  logger: {
    log: vi.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

// Leave dfProxy unmocked — proxyUrl passes through when DF_PROXY_URL is
// absent, and the tests don't need the proxy code path.

import { darResolveAdresseId } from '@/app/lib/dar';

/**
 * Build a fake fetch that returns queued responses in order.
 * Each response is a plain JSON payload; ok defaults to true.
 */
function queuedFetch(
  ...responses: Array<{ data?: unknown; errors?: unknown[]; ok?: boolean }>
): typeof fetch {
  let i = 0;
  return vi.fn(() => {
    const r = responses[i++] ?? {};
    return Promise.resolve({
      ok: r.ok !== false,
      status: r.ok === false ? 500 : 200,
      json: () => Promise.resolve({ data: r.data, errors: r.errors }),
    } as unknown as Response);
  }) as typeof fetch;
}

describe('darResolveAdresseId (BIZZ-506)', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.DATAFORDELER_API_KEY;

  beforeEach(() => {
    mockLoggerWarn.mockClear();
    mockLoggerError.mockClear();
    process.env.DATAFORDELER_API_KEY = 'test-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.DATAFORDELER_API_KEY = originalKey;
  });

  it('returns null (and warns) when DATAFORDELER_API_KEY is missing', async () => {
    delete process.env.DATAFORDELER_API_KEY;
    const calls = vi.fn();
    global.fetch = calls as unknown as typeof fetch;

    const result = await darResolveAdresseId({
      vejnavn: 'Bredgade',
      husnr: '1',
      postnr: '1260',
    });

    expect(result).toBeNull();
    expect(calls).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it('chains 4 queries and returns the adresse UUID on success', async () => {
    global.fetch = queuedFetch(
      // Step 1: DAR_NavngivenVej
      { data: { DAR_NavngivenVej: { nodes: [{ id_lokalId: 'vej-uuid-1' }] } } },
      // Step 2: DAR_Postnummer
      { data: { DAR_Postnummer: { nodes: [{ id_lokalId: 'pn-uuid' }] } } },
      // Step 3: DAR_Husnummer — includes vej-uuid-1 in navngivenVej, so it matches
      {
        data: {
          DAR_Husnummer: {
            nodes: [{ id_lokalId: 'hn-uuid', navngivenVej: 'vej-uuid-1' }],
          },
        },
      },
      // Step 4: DAR_Adresse
      { data: { DAR_Adresse: { nodes: [{ id_lokalId: 'adresse-uuid-final' }] } } }
    );

    const result = await darResolveAdresseId({
      vejnavn: 'Bredgade',
      husnr: '1',
      postnr: '1260',
      etage: '2',
      doer: 'tv',
    });

    expect(result).toBe('adresse-uuid-final');
  });

  it('returns null when NavngivenVej returns no hits (stops at step 1)', async () => {
    const fetchMock = queuedFetch(
      { data: { DAR_NavngivenVej: { nodes: [] } } }
      // No further calls should happen
    );
    global.fetch = fetchMock;

    const result = await darResolveAdresseId({
      vejnavn: 'IkkeEksisterende',
      husnr: '1',
      postnr: '1260',
    });

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when Postnummer lookup fails (stops at step 2)', async () => {
    const fetchMock = queuedFetch(
      { data: { DAR_NavngivenVej: { nodes: [{ id_lokalId: 'vej-uuid' }] } } },
      { data: { DAR_Postnummer: { nodes: [] } } }
    );
    global.fetch = fetchMock;

    const result = await darResolveAdresseId({
      vejnavn: 'Bredgade',
      husnr: '1',
      postnr: '9999',
    });

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('filters Husnummer by navngivenVej UUID — rejects mismatched streets', async () => {
    // Husnummer response has navngivenVej = 'other-vej' which is NOT in
    // the vej-UUID set returned in step 1. Result must be null.
    global.fetch = queuedFetch(
      { data: { DAR_NavngivenVej: { nodes: [{ id_lokalId: 'vej-uuid-1' }] } } },
      { data: { DAR_Postnummer: { nodes: [{ id_lokalId: 'pn-uuid' }] } } },
      {
        data: {
          DAR_Husnummer: {
            nodes: [{ id_lokalId: 'hn-other', navngivenVej: 'vej-uuid-other' }],
          },
        },
      }
    );

    const result = await darResolveAdresseId({
      vejnavn: 'Bredgade',
      husnr: '1',
      postnr: '1260',
    });

    expect(result).toBeNull();
  });

  it('skips etage/doer filters when they are absent (ground floor, single-entry)', async () => {
    const calls: string[] = [];
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? String(init.body) : '';
      calls.push(body);
      // Respond based on the query stage
      if (body.includes('DAR_NavngivenVej')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: { DAR_NavngivenVej: { nodes: [{ id_lokalId: 'vej-uuid' }] } },
            }),
        } as Response);
      }
      if (body.includes('DAR_Postnummer')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: { DAR_Postnummer: { nodes: [{ id_lokalId: 'pn-uuid' }] } },
            }),
        } as Response);
      }
      if (body.includes('DAR_Husnummer')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: {
                DAR_Husnummer: {
                  nodes: [{ id_lokalId: 'hn-uuid', navngivenVej: 'vej-uuid' }],
                },
              },
            }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: { DAR_Adresse: { nodes: [{ id_lokalId: 'ground-floor-uuid' }] } },
          }),
      } as Response);
    }) as typeof fetch;

    const result = await darResolveAdresseId({
      vejnavn: 'Bredgade',
      husnr: '1',
      postnr: '1260',
      // no etage, no doer
    });

    expect(result).toBe('ground-floor-uuid');
    // Verify the final DAR_Adresse query does NOT include etagebetegnelse/doerbetegnelse
    const lastBody = calls[calls.length - 1];
    expect(lastBody).not.toContain('etagebetegnelse');
    expect(lastBody).not.toContain('doerbetegnelse');
  });
});
