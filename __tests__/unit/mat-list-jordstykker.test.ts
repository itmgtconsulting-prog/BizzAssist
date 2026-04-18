/**
 * Unit tests for matListJordstykker (BIZZ-510).
 *
 * The helper paginates MAT WFS and normalises the GeoJSON feature
 * properties into a flat MatJordstykkeBulk array used by the sitemap
 * cron job. Fields names historically vary (bfenummer vs bfeNummer,
 * matrikelnr vs matrikelnummer, etc.) — these tests lock the expected
 * normalisation.
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

import { matListJordstykker } from '@/app/lib/dar';

function mockFetchOnce(body: unknown, ok = true): typeof fetch {
  return vi.fn(() =>
    Promise.resolve({
      ok,
      status: ok ? 200 : 500,
      statusText: ok ? 'OK' : 'ISE',
      json: () => Promise.resolve(body),
    } as unknown as Response)
  ) as typeof fetch;
}

describe('matListJordstykker (BIZZ-510)', () => {
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

    const result = await matListJordstykker(0, 1000);
    expect(result).toBeNull();
    expect(calls).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it('parses a well-formed WFS response into MatJordstykkeBulk[]', async () => {
    global.fetch = mockFetchOnce({
      features: [
        {
          properties: {
            bfenummer: 2081243,
            matrikelnummer: '29ck',
            ejerlavsnavn: 'Hvidovre By, Strandmark',
            ejerlavskode: 161553,
          },
        },
        {
          properties: {
            bfenummer: 100,
            matrikelnummer: '1a',
            ejerlavsnavn: 'Odense Bygrunde',
            ejerlavskode: 8000,
          },
        },
      ],
    });

    const result = await matListJordstykker(0, 1000);
    expect(result).toEqual([
      {
        bfenummer: 2081243,
        matrikelnr: '29ck',
        ejerlavsnavn: 'Hvidovre By, Strandmark',
        ejerlavskode: 161553,
      },
      {
        bfenummer: 100,
        matrikelnr: '1a',
        ejerlavsnavn: 'Odense Bygrunde',
        ejerlavskode: 8000,
      },
    ]);
  });

  it('accepts alternate field casings (bfeNummer / matrnr / ejerlavsKode)', async () => {
    // MatGaeld662 has historically returned these variants — guard them all.
    global.fetch = mockFetchOnce({
      features: [
        {
          properties: {
            bfeNummer: 42,
            matrnr: '7b',
            ejerlavsNavn: 'Hvidovre',
            ejerlavsKode: '161553', // sometimes comes back as string
          },
        },
      ],
    });

    const result = await matListJordstykker(0, 10);
    expect(result).toEqual([
      {
        bfenummer: 42,
        matrikelnr: '7b',
        ejerlavsnavn: 'Hvidovre',
        ejerlavskode: 161553,
      },
    ]);
  });

  it('skips features without a BFE number (filtered silently)', async () => {
    global.fetch = mockFetchOnce({
      features: [
        { properties: { bfenummer: null, matrikelnummer: '1a', ejerlavsnavn: 'Ghost' } },
        { properties: { bfenummer: 123, matrikelnummer: '2b', ejerlavsnavn: 'Keep' } },
        { properties: { matrikelnummer: '3c', ejerlavsnavn: 'Nope' } }, // no BFE at all
      ],
    });

    const result = await matListJordstykker(0, 10);
    expect(result).toHaveLength(1);
    expect(result?.[0]?.bfenummer).toBe(123);
  });

  it('skips features with neither matrikelnr nor ejerlavsnavn', async () => {
    global.fetch = mockFetchOnce({
      features: [
        { properties: { bfenummer: 1, matrikelnummer: '', ejerlavsnavn: '' } },
        { properties: { bfenummer: 2, matrikelnummer: '1a', ejerlavsnavn: '' } },
      ],
    });

    const result = await matListJordstykker(0, 10);
    expect(result).toEqual([{ bfenummer: 2, matrikelnr: '1a', ejerlavsnavn: '', ejerlavskode: 0 }]);
  });

  it('returns null on non-ok WFS response', async () => {
    global.fetch = mockFetchOnce({}, false);
    const result = await matListJordstykker(0, 10);
    expect(result).toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it('returns empty array when WFS returns no features (end of dataset)', async () => {
    global.fetch = mockFetchOnce({ features: [] });
    const result = await matListJordstykker(10_000_000, 10);
    expect(result).toEqual([]);
  });

  it('returns null when WFS response lacks features array (malformed)', async () => {
    global.fetch = mockFetchOnce({ unexpected: 'shape' });
    const result = await matListJordstykker(0, 10);
    expect(result).toBeNull();
  });

  it('returns null when fetch throws (network / timeout)', async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error('network fail'))) as typeof fetch;
    const result = await matListJordstykker(0, 10);
    expect(result).toBeNull();
    expect(mockLoggerError).toHaveBeenCalled();
  });
});
