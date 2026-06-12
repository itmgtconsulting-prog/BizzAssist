/**
 * Unit tests for app/lib/bfeAdresse — BIZZ-2093.
 *
 * Mocks Supabase admin client og global fetch så cache-first-logik,
 * jordstykke-live-fallback, grund-håndtering, VP-fallback og guarded
 * writeback kan testes uden netværk.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFrom = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: mockFrom }),
}));

const { hentBfeAdresser, hentBfeAdresse, formatBfeLabel, erTrovaerdigCacheRaekke } =
  await import('@/app/lib/bfeAdresse');

/** Helper: mock cache-tabellens query chain + upsert-spy */
function mockCache(rows: unknown[]) {
  const upsert = vi.fn().mockResolvedValue({ data: null, error: null });
  const chain = {
    select: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue({ data: rows, error: null }),
    upsert,
  };
  mockFrom.mockReturnValue(chain);
  return { chain, upsert };
}

/** Helper: mock fetch der svarer pr. URL-mønster */
function mockFetch(handler: (url: string) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = handler(url);
      if (body === null) return { ok: false, status: 404, json: async () => null };
      return { ok: true, status: 200, json: async () => body };
    })
  );
}

const cacheRow = (over: Record<string, unknown> = {}) => ({
  bfe_nummer: 100,
  adresse: 'Fenrisvej 19',
  postnr: '3000',
  postnrnavn: 'Helsingør',
  kommune: 'Helsingør',
  kommune_kode: '0217',
  dawa_id: 'uuid-1',
  ejendomstype: null,
  etage: null,
  doer: null,
  kilde: 'fix_2092_jordstykke',
  ...over,
});

describe('erTrovaerdigCacheRaekke', () => {
  it('accepterer rækker med reel adresse og troværdig kilde', () => {
    expect(erTrovaerdigCacheRaekke({ adresse: 'Fenrisvej 19', kilde: 'manual' })).toBe(true);
  });

  it('afviser cache_dar og unresolvable kilder (BIZZ-2092)', () => {
    expect(erTrovaerdigCacheRaekke({ adresse: 'Gefionsvej 47A', kilde: 'cache_dar' })).toBe(false);
    expect(erTrovaerdigCacheRaekke({ adresse: 'X', kilde: 'unresolvable' })).toBe(false);
  });

  it('afviser placeholder-adresser og null', () => {
    expect(erTrovaerdigCacheRaekke({ adresse: 'BFE 12345', kilde: 'manual' })).toBe(false);
    expect(erTrovaerdigCacheRaekke({ adresse: null, kilde: 'manual' })).toBe(false);
    expect(erTrovaerdigCacheRaekke(null)).toBe(false);
  });
});

describe('formatBfeLabel', () => {
  it('formaterer adresse + etage/dør + postnr by', () => {
    expect(
      formatBfeLabel({
        adresse: 'Fenrisvej 19',
        etage: '1',
        doer: 'tv',
        postnr: '3000',
        by: 'Helsingør',
        kommune: null,
        kommuneKode: null,
        ejendomstype: null,
        dawaId: null,
        kilde: null,
      })
    ).toBe('Fenrisvej 19, 1. tv, 3000 Helsingør');
  });

  it('returnerer null uden adresse', () => {
    expect(formatBfeLabel(null)).toBeNull();
  });
});

describe('hentBfeAdresser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('returnerer troværdige cache-rækker uden live-opslag', async () => {
    const { upsert } = mockCache([cacheRow()]);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await hentBfeAdresser([100]);
    expect(res.get(100)?.adresse).toBe('Fenrisvej 19');
    expect(res.get(100)?.kilde).toBe('fix_2092_jordstykke');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('live-resolver cache_dar-rækker via jordstykke og skriver tilbage', async () => {
    const { upsert } = mockCache([cacheRow({ kilde: 'cache_dar', adresse: 'Gefionsvej 47A' })]);
    mockFetch((url) => {
      if (url.includes('/jordstykker'))
        return [{ matrikelnr: '65bd', ejerlav: { kode: 980553, navn: 'Helsingør Markjorder' } }];
      if (url.includes('/adgangsadresser'))
        return [
          {
            id: 'uuid-2',
            vejnavn: 'Fenrisvej',
            husnr: '19',
            postnr: '3000',
            postnrnavn: 'Helsingør',
            kommunekode: '0217',
          },
        ];
      return null;
    });

    const res = await hentBfeAdresser([100]);
    expect(res.get(100)?.adresse).toBe('Fenrisvej 19');
    expect(res.get(100)?.kilde).toBe('auto_jordstykke');
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toMatchObject({
      bfe_nummer: 100,
      adresse: 'Fenrisvej 19',
      kilde: 'auto_jordstykke',
    });
  });

  it('giver ubebyggede grunde matrikelbetegnelse med dawaId=null', async () => {
    mockCache([]);
    mockFetch((url) => {
      if (url.includes('/jordstykker'))
        return [{ matrikelnr: '65ce', ejerlav: { kode: 980553, navn: 'Helsingør Markjorder' } }];
      if (url.includes('/adgangsadresser')) return [];
      return null;
    });

    const res = await hentBfeAdresser([200]);
    expect(res.get(200)?.adresse).toBe('65ce Helsingør Markjorder');
    expect(res.get(200)?.dawaId).toBeNull();
    expect(res.get(200)?.kilde).toBe('auto_grund');
  });

  it('falder tilbage til VP for BFE uden jordstykke (ejerlejlighed)', async () => {
    mockCache([]);
    mockFetch((url) => {
      if (url.includes('/jordstykker')) return [];
      if (url.includes('vurderingsportalen'))
        return {
          hits: {
            hits: [
              {
                _source: {
                  roadName: 'Strandvejen',
                  houseNumber: '10',
                  zipcode: '2900',
                  postDistrict: 'Hellerup',
                  floor: '2',
                  door: 'th',
                  adresseID: 'enh-uuid',
                  adgangsAdresseID: 'adg-uuid',
                  juridiskKategori: 'Ejerlejlighed',
                },
              },
            ],
          },
        };
      return null;
    });

    const res = await hentBfeAdresser([300]);
    expect(res.get(300)?.adresse).toBe('Strandvejen 10');
    expect(res.get(300)?.etage).toBe('2');
    expect(res.get(300)?.doer).toBe('th');
    expect(res.get(300)?.dawaId).toBe('enh-uuid');
    expect(res.get(300)?.kilde).toBe('auto_vp');
  });

  it('udelader BFE-numre der ikke kan resolves', async () => {
    mockCache([]);
    mockFetch(() => null);
    const res = await hentBfeAdresser([400]);
    expect(res.has(400)).toBe(false);
  });

  it('håndterer tom input-liste uden DB-kald', async () => {
    mockCache([]);
    const res = await hentBfeAdresser([]);
    expect(res.size).toBe(0);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe('hentBfeAdresse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('returnerer null for uresolverbar BFE', async () => {
    mockCache([]);
    mockFetch(() => null);
    expect(await hentBfeAdresse(999)).toBeNull();
  });

  it('returnerer cache-hit for troværdig række', async () => {
    mockCache([cacheRow()]);
    const res = await hentBfeAdresse(100);
    expect(res?.adresse).toBe('Fenrisvej 19');
  });
});
