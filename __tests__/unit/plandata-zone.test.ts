/**
 * Unit tests for hentZoneFraPlandata (BIZZ-509).
 *
 * The helper queries plandata.dk's GeoServer WFS for zone classification
 * (Byzone / Landzone / Sommerhuszone). Tests verify:
 *   - The CQL_FILTER uses SRID=4326 prefix (load-bearing — without it
 *     GeoServer misinterprets coords)
 *   - Multiple layer names are tried in order for schema drift
 *   - Zone normalisation maps alternate labels/codes to canonical values
 *   - Never throws — fetch errors resolve to null
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('@/app/lib/logger', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { hentZoneFraPlandata, __clearDarCachesForTests } from '@/app/lib/dar';

function mockFetch(makeResponse: (url: string) => { body?: unknown; ok?: boolean }): typeof fetch {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = makeResponse(url);
    const ok = r.ok !== false;
    return Promise.resolve({
      ok,
      status: ok ? 200 : 500,
      json: () => Promise.resolve(r.body ?? { features: [] }),
    } as unknown as Response);
  }) as typeof fetch;
}

describe('hentZoneFraPlandata (BIZZ-509)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // BIZZ-600: Ryd LRU-cache så tests ikke deler zone-resultater på tværs
    __clearDarCachesForTests();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends SRID=4326 prefix in the CQL_FILTER (load-bearing for plandata WFS)', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ features: [{ properties: { zone: 'Byzone' } }] }),
      } as Response);
    }) as typeof fetch;

    await hentZoneFraPlandata(12.5858, 55.6835);
    expect(capturedUrl).toContain('SRID%3D4326');
    // Coordinates preserved in the POINT literal
    expect(decodeURIComponent(capturedUrl)).toContain('POINT(12.5858 55.6835)');
  });

  it('returns the canonical "Byzone" label from raw props.zone', async () => {
    global.fetch = mockFetch(() => ({ body: { features: [{ properties: { zone: 'Byzone' } }] } }));
    expect(await hentZoneFraPlandata(12.5, 55.7)).toBe('Byzone');
  });

  it('normalises numeric zone codes (1 → Byzone, 2 → Sommerhuszone, 3 → Landzone)', async () => {
    global.fetch = mockFetch(() => ({ body: { features: [{ properties: { zone: '1' } }] } }));
    expect(await hentZoneFraPlandata(12, 55)).toBe('Byzone');

    __clearDarCachesForTests();
    global.fetch = mockFetch(() => ({ body: { features: [{ properties: { zone: '2' } }] } }));
    expect(await hentZoneFraPlandata(12, 55)).toBe('Sommerhuszone');

    __clearDarCachesForTests();
    global.fetch = mockFetch(() => ({ body: { features: [{ properties: { zone: '3' } }] } }));
    expect(await hentZoneFraPlandata(12, 55)).toBe('Landzone');
  });

  it('normalises long-form "Sommerhusområde" to "Sommerhuszone"', async () => {
    global.fetch = mockFetch(() => ({
      body: { features: [{ properties: { zone: 'Sommerhusområde' } }] },
    }));
    expect(await hentZoneFraPlandata(12, 55)).toBe('Sommerhuszone');
  });

  it('accepts alternate field names (zone_navn / betegnelse)', async () => {
    global.fetch = mockFetch(() => ({
      body: { features: [{ properties: { zone_navn: 'Landzone' } }] },
    }));
    expect(await hentZoneFraPlandata(12, 55)).toBe('Landzone');

    __clearDarCachesForTests();
    global.fetch = mockFetch(() => ({
      body: { features: [{ properties: { betegnelse: 'Byzone' } }] },
    }));
    expect(await hentZoneFraPlandata(12, 55)).toBe('Byzone');
  });

  it('tries next layer when the first returns no features', async () => {
    let callCount = 0;
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      callCount++;
      const url = typeof input === 'string' ? input : input.toString();
      // typeName colon is URL-encoded as %3A — match on the part after the colon
      const body = url.includes('theme_pdk_zonekort_vedtaget_v')
        ? { features: [] }
        : { features: [{ properties: { zone: 'Byzone' } }] };
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      } as Response);
    }) as typeof fetch;

    const result = await hentZoneFraPlandata(12, 55);
    expect(result).toBe('Byzone');
    // Both layers attempted
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('returns null when all layers return nothing', async () => {
    global.fetch = mockFetch(() => ({ body: { features: [] } }));
    expect(await hentZoneFraPlandata(12, 55)).toBeNull();
  });

  it('returns null when fetch throws (never propagates)', async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error('network'))) as typeof fetch;
    expect(await hentZoneFraPlandata(12, 55)).toBeNull();
  });

  it('returns null on non-ok responses (continues past HTTP errors)', async () => {
    global.fetch = mockFetch(() => ({ body: {}, ok: false }));
    expect(await hentZoneFraPlandata(12, 55)).toBeNull();
  });

  it('passes unrecognised zone labels through unchanged (do not silently drop)', async () => {
    global.fetch = mockFetch(() => ({
      body: { features: [{ properties: { zone: 'Specialzone' } }] },
    }));
    expect(await hentZoneFraPlandata(12, 55)).toBe('Specialzone');
  });
});
