/**
 * BIZZ-2089: Tests for geokodning af ejendomslister til EjendomsKortPanel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  geokodKortItems,
  kortItemKey,
  _clearGeokodCache,
  type KortItem,
} from '@/app/lib/ejendomsKortGeokod';

/** Bygger en fetch-mock der svarer pr. URL-mønster */
function mockFetch(handler: (url: string) => unknown): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = handler(url);
    if (body === undefined) return { ok: false, json: async () => ({}) } as Response;
    return { ok: true, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  _clearGeokodCache();
});

describe('kortItemKey', () => {
  it('prioriterer dawaId > adresse > bfe', () => {
    expect(kortItemKey({ bfe: 1, adresse: 'A', dawaId: 'x' })).toBe('id:x');
    expect(kortItemKey({ bfe: 1, adresse: 'A' })).toBe('adr:A');
    expect(kortItemKey({ bfe: 1, adresse: null })).toBe('bfe:1');
  });
});

describe('geokodKortItems', () => {
  it('slår dawaId op direkte i DAWA', async () => {
    const fetchFn = mockFetch((url) => {
      if (url.includes('/adresser/uuid-1?')) return { x: 12.5, y: 55.7, betegnelse: 'Testvej 1' };
      return undefined;
    });
    const items: KortItem[] = [{ bfe: 100, adresse: null, dawaId: 'uuid-1' }];
    const markers = await geokodKortItems(items, fetchFn);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ lng: 12.5, lat: 55.7, dawaId: 'uuid-1', bfe: 100 });
    expect(markers[0].adresse).toBe('Testvej 1');
  });

  it('falder tilbage til adgangsadresser når /adresser fejler', async () => {
    const fetchFn = mockFetch((url) => {
      if (url.includes('/adgangsadresser/uuid-2?')) return { x: 10.1, y: 56.2 };
      return undefined;
    });
    const markers = await geokodKortItems(
      [{ bfe: null, adresse: 'Vej 2', dawaId: 'uuid-2' }],
      fetchFn
    );
    expect(markers).toHaveLength(1);
    expect(markers[0].adresse).toBe('Vej 2');
  });

  it('fuzzy-søger på adressetekst når dawaId mangler', async () => {
    const fetchFn = mockFetch((url) => {
      if (url.includes('/adresser?q=')) return [{ id: 'hit-id', x: 9.9, y: 57.0 }];
      return undefined;
    });
    const markers = await geokodKortItems(
      [{ bfe: null, adresse: 'Søvej 3, 9000 Aalborg' }],
      fetchFn
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ lng: 9.9, lat: 57.0, dawaId: 'hit-id' });
  });

  it('beriger BFE-only items via /api/bfe-addresses og geokoder derefter', async () => {
    const fetchFn = mockFetch((url) => {
      if (url.includes('/api/bfe-addresses?bfes=42'))
        return {
          '42': { adresse: 'Havnegade 4', postnr: '5000', by: 'Odense', dawaId: 'uuid-42' },
        };
      if (url.includes('/adresser/uuid-42?')) return { x: 10.4, y: 55.4 };
      return undefined;
    });
    const markers = await geokodKortItems([{ bfe: 42, adresse: null }], fetchFn);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ lng: 10.4, lat: 55.4, bfe: 42, dawaId: 'uuid-42' });
    expect(markers[0].adresse).toBe('Havnegade 4, 5000 Odense');
  });

  it('cacher opslag — andet kald rammer ikke fetch igen', async () => {
    const handler = vi.fn((url: string) =>
      url.includes('/adresser/uuid-c?') ? { x: 12.0, y: 55.0 } : undefined
    );
    const fetchFn = mockFetch(handler);
    const items: KortItem[] = [{ bfe: null, adresse: null, dawaId: 'uuid-c' }];
    await geokodKortItems(items, fetchFn);
    const kald = handler.mock.calls.length;
    const markers2 = await geokodKortItems(items, fetchFn);
    expect(markers2).toHaveLength(1);
    expect(handler.mock.calls.length).toBe(kald); // ingen nye fetches
  });

  it("udelader items der ikke kunne geokodes og dedup'er", async () => {
    const fetchFn = mockFetch((url) => {
      if (url.includes('/adresser/ok?')) return { x: 12.0, y: 55.0 };
      return undefined; // alt andet fejler
    });
    const markers = await geokodKortItems(
      [
        { bfe: null, adresse: null, dawaId: 'ok' },
        { bfe: null, adresse: null, dawaId: 'ok' }, // duplikat
        { bfe: null, adresse: 'findes ikke' },
        { bfe: null, adresse: null }, // helt tom — springes over
      ],
      fetchFn
    );
    expect(markers).toHaveLength(1);
  });
});
