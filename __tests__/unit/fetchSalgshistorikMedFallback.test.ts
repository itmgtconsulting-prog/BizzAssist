/**
 * Unit-tests for fetchSalgshistorikMedFallback — den delte salgshistorik-
 * helper (BIZZ-609 / BIZZ-634). Dækker:
 *
 *  - Legacy-adfærd uden ownerDates: nyeste pris-bærende handel returneres
 *  - BIZZ-634: når ownerSellDate er sat, udvælges både købs- + salgs-handel
 *  - Tinglysning-fallback firer når EJF ikke har pris
 *  - Non-OK respons returnerer null graceful
 *
 * BIZZ-599: Lib-tests for kritiske untested-filer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchSalgshistorikMedFallback } from '@/app/lib/fetchSalgshistorikMedFallback';

const ORIGINAL_FETCH = globalThis.fetch;

/** Helper: mocker /api/salgshistorik + /api/tinglysning endpoints. */
function installFetchMock(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchSalgshistorikMedFallback — legacy-adfærd (uden ownerDates)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('returnerer nyeste pris-bærende handel fra EJF', async () => {
    installFetchMock((url) => {
      if (url.includes('/api/salgshistorik')) {
        return jsonResponse({
          handler: [
            { kontantKoebesum: 5_000_000, overtagelsesdato: '2023-06-01' },
            { kontantKoebesum: 3_000_000, overtagelsesdato: '2019-04-15' },
          ],
        });
      }
      return jsonResponse({}, 404);
    });
    const res = await fetchSalgshistorikMedFallback(12345, 'https://test', '');
    expect(res).not.toBeNull();
    expect(res!.koebesum).toBe(5_000_000);
    expect(res!.koebsdato).toBe('2023-06-01');
  });

  it('falder tilbage til Tinglysning når EJF returnerer tom handler-liste', async () => {
    installFetchMock((url) => {
      if (url.includes('/api/salgshistorik')) {
        return jsonResponse({ handler: [] });
      }
      if (url.includes('/api/tinglysning?bfe=')) {
        return jsonResponse({ uuid: 'tl-uuid' });
      }
      if (url.includes('/api/tinglysning/summarisk')) {
        return jsonResponse({
          ejere: [{ koebesum: 4_500_000, overtagelsesdato: '2022-01-15' }],
        });
      }
      return jsonResponse({}, 404);
    });
    const res = await fetchSalgshistorikMedFallback(54321, 'https://test', '');
    expect(res).not.toBeNull();
    expect(res!.koebesum).toBe(4_500_000);
    expect(res!.koebsdato).toBe('2022-01-15');
  });

  it('returnerer null når både EJF og Tinglysning er tom', async () => {
    installFetchMock(() => jsonResponse({}, 404));
    const res = await fetchSalgshistorikMedFallback(99999, 'https://test', '');
    expect(res).toBeNull();
  });
});

describe('fetchSalgshistorikMedFallback — ejer-specifik (BIZZ-634)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('finder købs-handel strengt før ownerSellDate + salgs-handel nær sellDate', async () => {
    // Scenario: ejer købte 2016-06 for 2.8M og solgte 2016-07 for 3.1M.
    // Efterfølgende ejer købte 2020-01 for 4.0M.
    installFetchMock((url) => {
      if (url.includes('/api/salgshistorik')) {
        return jsonResponse({
          handler: [
            { kontantKoebesum: 4_000_000, overtagelsesdato: '2020-01-10' }, // næste ejer
            { kontantKoebesum: 3_100_000, overtagelsesdato: '2016-07-20' }, // vores ejers salg
            { kontantKoebesum: 2_800_000, overtagelsesdato: '2016-06-01' }, // vores ejers køb
          ],
        });
      }
      return jsonResponse({}, 404);
    });
    const res = await fetchSalgshistorikMedFallback(12345, 'https://test', '', 5000, {
      buyDate: '2016-06-01',
      sellDate: '2016-07-20',
    });
    expect(res).not.toBeNull();
    // Køb = 2.8M (strengt før sellDate + efter buyDate)
    expect(res!.koebesum).toBe(2_800_000);
    expect(res!.koebsdato).toBe('2016-06-01');
    // Salg = 3.1M (nærmest sellDate — samme dato)
    expect(res!.salgesum).toBe(3_100_000);
    expect(res!.salgesdato).toBe('2016-07-20');
  });

  it('salgesum=null når salgshandel er mere end 30 dage fra sellDate', async () => {
    installFetchMock((url) => {
      if (url.includes('/api/salgshistorik')) {
        return jsonResponse({
          handler: [
            { kontantKoebesum: 3_000_000, overtagelsesdato: '2015-01-01' },
            { kontantKoebesum: 2_000_000, overtagelsesdato: '2010-01-01' },
          ],
        });
      }
      return jsonResponse({}, 404);
    });
    const res = await fetchSalgshistorikMedFallback(12345, 'https://test', '', 5000, {
      sellDate: '2020-12-31', // langt efter seneste handel
    });
    expect(res).not.toBeNull();
    // Nærmeste salgshandel (2015-01-01) er > 30 dage fra 2020-12-31 → null
    expect(res!.salgesum).toBeNull();
    expect(res!.salgesdato).toBeNull();
  });

  it('bagudkompatibel: ingen ownerDates → samme som legacy (ingen salgesum-felter)', async () => {
    installFetchMock((url) => {
      if (url.includes('/api/salgshistorik')) {
        return jsonResponse({
          handler: [{ kontantKoebesum: 1_500_000, overtagelsesdato: '2022-04-01' }],
        });
      }
      return jsonResponse({}, 404);
    });
    const res = await fetchSalgshistorikMedFallback(12345, 'https://test', '');
    expect(res).not.toBeNull();
    expect(res!.koebesum).toBe(1_500_000);
    // salgesum + salgesdato må ikke være sat (undefined eller null) i legacy-path
    expect(res!.salgesum ?? null).toBeNull();
    expect(res!.salgesdato ?? null).toBeNull();
  });
});
