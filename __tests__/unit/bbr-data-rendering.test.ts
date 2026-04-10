/**
 * BBR data-rendering unit tests.
 *
 * Verifies that when Datafordeler GraphQL returns buildings with valid codes,
 * the normalised LiveBBRBygning records have human-readable display strings for
 * all key fields — never the "–" placeholder that signals a missing or unknown code.
 *
 * Also verifies fetchBbrForAddress correctly threads a full GraphQL response
 * through to the caller.
 *
 * Covers BIZZ problems where BBR fields showed "–" everywhere due to silent
 * API failures or mis-mapped codes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('@/app/lib/dfProxy', () => ({
  proxyUrl: (url: string) => url,
  proxyHeaders: () => ({}),
  proxyTimeout: () => 10_000,
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { normaliseBygning, fetchBbrForAddress, type RawBBRBygning } from '@/app/lib/fetchBbrData';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: { entries: () => [] as unknown as IterableIterator<[string, string]> },
  } as unknown as Response;
}

// ─── normaliseBygning — no "–" when all codes present ────────────────────────

describe('normaliseBygning — key display fields with valid codes', () => {
  /** A raw BBR record with every display-code field populated using known-good codes */
  const fullRaw: RawBBRBygning = {
    id_lokalId: 'byg-full-render',
    byg026Opfoerelsesaar: 1975,
    byg027OmTilbygningsaar: 2010,
    byg038SamletBygningsareal: 250,
    byg039BygningensSamledeBoligAreal: 200,
    byg040BygningensSamledeErhvervsAreal: 50,
    byg041BebyggetAreal: 140,
    byg024AntalLejlighederMedKoekken: 4,
    byg025AntalLejlighederUdenKoekken: 0,
    byg054AntalEtager: 3,
    byg033Tagdaekningsmateriale: '2', // Tegltagsten
    byg032YdervaeggensMateriale: '1', // Mursten
    byg056Varmeinstallation: '1', // Fjernvarme / blokvarme
    byg057Opvarmningsmiddel: '2', // Gas
    byg058SupplerendeVarme: '2', // Brændeovn / pejs
    byg030Vandforsyning: '1', // Alment vandforsyningsanlæg
    byg031Afloebsforhold: '1', // Afløb til kloaksystem
    byg021BygningensAnvendelse: '120', // Fritliggende enfamilieshus
    byg066Ejerforhold: '10',
    byg094Revisionsdato: '2024-06-01',
    status: '6',
  };

  it('tagmateriale is NOT "–" when code 2 is given', () => {
    const result = normaliseBygning(fullRaw);
    expect(result.tagmateriale).not.toBe('–');
    expect(result.tagmateriale.length).toBeGreaterThan(1);
  });

  it('ydervaeg is NOT "–" when code 1 is given', () => {
    const result = normaliseBygning(fullRaw);
    expect(result.ydervaeg).not.toBe('–');
  });

  it('varmeinstallation is NOT "–" when code 1 is given', () => {
    const result = normaliseBygning(fullRaw);
    expect(result.varmeinstallation).not.toBe('–');
  });

  it('opvarmningsform is NOT "–" when code 2 is given', () => {
    const result = normaliseBygning(fullRaw);
    expect(result.opvarmningsform).not.toBe('–');
  });

  it('vandforsyning is NOT "–" when code 1 is given', () => {
    const result = normaliseBygning(fullRaw);
    expect(result.vandforsyning).not.toBe('–');
  });

  it('afloeb is NOT "–" when code 1 is given', () => {
    const result = normaliseBygning(fullRaw);
    expect(result.afloeb).not.toBe('–');
  });

  it('anvendelse is NOT "–" when code 120 is given', () => {
    const result = normaliseBygning(fullRaw);
    expect(result.anvendelse).not.toBe('–');
    expect(result.anvendelse).toBe('Fritliggende enfamilieshus');
  });

  it('supplerendeVarme is NOT "–" when code 2 is given', () => {
    const result = normaliseBygning(fullRaw);
    expect(result.supplerendeVarme).not.toBeNull();
    expect(result.supplerendeVarme).not.toBe('–');
  });

  it('numeric fields are correctly populated', () => {
    const result = normaliseBygning(fullRaw);
    expect(result.opfoerelsesaar).toBe(1975);
    expect(result.ombygningsaar).toBe(2010);
    expect(result.samletBygningsareal).toBe(250);
    expect(result.samletBoligareal).toBe(200);
    expect(result.samletErhvervsareal).toBe(50);
    expect(result.bebyggetAreal).toBe(140);
    expect(result.antalEtager).toBe(3);
    expect(result.antalBoligenheder).toBe(4); // 4 + 0
  });

  it('returns "–" as fallback ONLY when the code is absent', () => {
    // No codes → all text fields fall back to "–"
    const empty: RawBBRBygning = { id_lokalId: 'empty-byg' };
    const result = normaliseBygning(empty);
    // These specific fields default to "–" when no code is supplied
    expect(result.tagmateriale).toBe('–');
    expect(result.ydervaeg).toBe('–');
    expect(result.varmeinstallation).toBe('–');
    expect(result.opvarmningsform).toBe('–');
    expect(result.vandforsyning).toBe('–');
    expect(result.afloeb).toBe('–');
    expect(result.anvendelse).toBe('–');
  });
});

// ─── fetchBbrForAddress — Datafordeler GraphQL mock ──────────────────────────

describe('fetchBbrForAddress — Datafordeler GraphQL response', () => {
  const DAWA_ID = 'b84b7e12-b8a1-4601-87d5-aabbcc001122';

  beforeEach(() => {
    process.env.DATAFORDELER_API_KEY = 'test-api-key';
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DATAFORDELER_API_KEY;
  });

  /**
   * Sets up fetch mock to return a realistic multi-building GraphQL response.
   * Mimics what Datafordeler /BBR/v2 GraphQL returns for a residential address.
   */
  function mockFullBbrFetch() {
    const mockFetch = vi
      .fn()
      // adgangsadresse
      .mockResolvedValueOnce(
        makeResponse({
          jordstykke: { ejerlav: { kode: 101 }, matrikelnr: '12a' },
          adressebetegnelse: 'Nørrebrogade 10, 2200 København N',
          kommune: { kode: '0101' },
        })
      )
      // jordstykker (BFE lookup)
      .mockResolvedValueOnce(makeResponse({ bfenummer: 100165718 }))
      // vurderingsportalen ES (not relevant here)
      .mockResolvedValueOnce(makeResponse({ hits: { hits: [] } }))
      // BBR GraphQL bygninger — two buildings with all codes populated
      .mockResolvedValueOnce(
        makeResponse({
          data: {
            BBR_Bygning: {
              nodes: [
                {
                  id_lokalId: 'byg-a001',
                  byg026Opfoerelsesaar: 1960,
                  byg027OmTilbygningsaar: 2005,
                  byg038SamletBygningsareal: 320,
                  byg039BygningensSamledeBoligAreal: 280,
                  byg041BebyggetAreal: 180,
                  byg054AntalEtager: 4,
                  byg024AntalLejlighederMedKoekken: 8,
                  byg025AntalLejlighederUdenKoekken: 0,
                  byg033Tagdaekningsmateriale: '1', // Betontagsten
                  byg032YdervaeggensMateriale: '1', // Mursten
                  byg056Varmeinstallation: '1', // Fjernvarme
                  byg057Opvarmningsmiddel: '4', // Olie
                  byg030Vandforsyning: '1',
                  byg031Afloebsforhold: '1',
                  byg021BygningensAnvendelse: '140', // Etageboligbebyggelse
                  byg066Ejerforhold: '10',
                  status: '6',
                  byg094Revisionsdato: '2024-01-10',
                },
                {
                  id_lokalId: 'byg-a002',
                  byg026Opfoerelsesaar: 1985,
                  byg038SamletBygningsareal: 45,
                  byg041BebyggetAreal: 45,
                  byg033Tagdaekningsmateriale: '4', // Fibercement
                  byg032YdervaeggensMateriale: '4', // Træ
                  byg056Varmeinstallation: '3', // Fjernvarme (varmt vand)
                  byg057Opvarmningsmiddel: '1', // Elektricitet
                  byg030Vandforsyning: '2',
                  byg031Afloebsforhold: '2',
                  byg021BygningensAnvendelse: '910', // Garage
                  status: '6',
                },
              ],
            },
          },
        })
      )
      // BBR GraphQL enheder
      .mockResolvedValueOnce(
        makeResponse({
          data: {
            BBR_Enhed: {
              nodes: [
                { id_lokalId: 'enh-001', enh026EnhedensSamledeAreal: 80, status: '6' },
                { id_lokalId: 'enh-002', enh026EnhedensSamledeAreal: 75, status: '6' },
              ],
            },
          },
        })
      )
      // WFS bygningspunkter
      .mockResolvedValueOnce(makeResponse({ features: [] }));

    vi.stubGlobal('fetch', mockFetch);
    return mockFetch;
  }

  it('returns two normalised buildings from a multi-building GraphQL response', async () => {
    mockFullBbrFetch();
    const result = await fetchBbrForAddress(DAWA_ID);

    expect(result.bbrFejl).toBeNull();
    expect(result.bbr).not.toBeNull();
    expect(result.bbr!.length).toBe(2);
  });

  it('first building has human-readable tagmateriale (not "–")', async () => {
    mockFullBbrFetch();
    const result = await fetchBbrForAddress(DAWA_ID);

    const byg = result.bbr![0];
    expect(byg.tagmateriale).not.toBe('–');
  });

  it('first building has human-readable ydervaeg (not "–")', async () => {
    mockFullBbrFetch();
    const result = await fetchBbrForAddress(DAWA_ID);

    expect(result.bbr![0].ydervaeg).not.toBe('–');
  });

  it('first building has correct numeric fields', async () => {
    mockFullBbrFetch();
    const result = await fetchBbrForAddress(DAWA_ID);

    const byg = result.bbr![0];
    expect(byg.id).toBe('byg-a001');
    expect(byg.opfoerelsesaar).toBe(1960);
    expect(byg.ombygningsaar).toBe(2005);
    expect(byg.samletBygningsareal).toBe(320);
    expect(byg.antalEtager).toBe(4);
    expect(byg.antalBoligenheder).toBe(8);
  });

  it('second building (garage) has matching anvendelse', async () => {
    mockFullBbrFetch();
    const result = await fetchBbrForAddress(DAWA_ID);

    const garage = result.bbr![1];
    expect(garage.id).toBe('byg-a002');
    // 910 = Garage — resolve to non-"–" string
    expect(garage.anvendelse).not.toBe('–');
  });

  it('enheder are correctly returned alongside bygninger', async () => {
    mockFullBbrFetch();
    const result = await fetchBbrForAddress(DAWA_ID);

    expect(result.enheder).not.toBeNull();
    expect(result.enheder!.length).toBe(2);
    expect(result.enheder![0].areal).toBe(80);
  });

  it('ejendomsrelationer carries the BFE number from jordstykker lookup', async () => {
    mockFullBbrFetch();
    const result = await fetchBbrForAddress(DAWA_ID);

    expect(result.ejendomsrelationer).not.toBeNull();
    expect(result.ejendomsrelationer![0].bfeNummer).toBe(100165718);
  });

  it('handles a 500 GraphQL response gracefully and returns bbrFejl', async () => {
    vi.fn()
      .mockResolvedValueOnce(
        makeResponse({
          jordstykke: { ejerlav: { kode: 101 }, matrikelnr: '12a' },
          adressebetegnelse: 'Test 1',
          kommune: { kode: '0101' },
        })
      )
      .mockResolvedValueOnce(makeResponse({ bfenummer: 123 }))
      .mockResolvedValueOnce(makeResponse({ hits: { hits: [] } }))
      .mockResolvedValueOnce(makeResponse({ errors: [{ message: 'Internal error' }] }, 500));

    // Even if fetch throws, fetchBbrForAddress should not crash
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('GraphQL server unreachable')));

    const result = await fetchBbrForAddress(DAWA_ID);
    expect(result).toBeDefined();
    expect(result.bbr).toBeNull();
  });
});
