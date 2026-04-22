/**
 * BIZZ-685 / BIZZ-693: tinglysningPrices unit tests.
 *
 * Exercises the XML parser + date-index + cache reset. The fetch path is
 * covered by the integration-style tlFetch tests (we don't spin up mTLS
 * for every unit suite).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tlFetchMock = vi.fn();
vi.mock('@/app/lib/tlFetch', () => ({
  tlFetch: (path: string, opts?: unknown) => tlFetchMock(path, opts),
}));

import {
  fetchTinglysningPriceRowsByBfe,
  indexPriceRowsByDate,
  _clearTinglysningPriceCache,
} from '@/app/lib/tinglysningPrices';

const SUMMARISK_XML = `
<ns:EjdomSummarisk xmlns:ns="urn">
  <ns:AdkomstSummariskSamling>
    <ns:AdkomstSummarisk>
      <ns:AdkomstType>Skøde</ns:AdkomstType>
      <ns:SkoedeOvertagelsesDato>2023-04-01+02:00</ns:SkoedeOvertagelsesDato>
      <ns:TinglysningsDato>2023-03-30T10:00:00Z</ns:TinglysningsDato>
      <ns:KoebsaftaleDato>2023-03-15+02:00</ns:KoebsaftaleDato>
      <ns:KontantKoebesum>3500000</ns:KontantKoebesum>
      <ns:IAltKoebesum>3550000</ns:IAltKoebesum>
      <ns:DokumentIdentifikator>doc-uuid-1</ns:DokumentIdentifikator>
    </ns:AdkomstSummarisk>
    <ns:AdkomstSummarisk>
      <ns:AdkomstType>Skøde</ns:AdkomstType>
      <ns:SkoedeOvertagelsesDato>2020-03-01+01:00</ns:SkoedeOvertagelsesDato>
      <ns:KontantKoebesum>2000000</ns:KontantKoebesum>
      <ns:DokumentIdentifikator>doc-uuid-2</ns:DokumentIdentifikator>
    </ns:AdkomstSummarisk>
  </ns:AdkomstSummariskSamling>
</ns:EjdomSummarisk>
`;

describe('fetchTinglysningPriceRowsByBfe — BIZZ-685 iter 2', () => {
  beforeEach(() => {
    tlFetchMock.mockReset();
    _clearTinglysningPriceCache();
  });

  it('returns empty when ejendom lookup fails', async () => {
    tlFetchMock.mockResolvedValueOnce({ status: 404, body: '' });
    const r = await fetchTinglysningPriceRowsByBfe(123456);
    expect(r).toEqual([]);
  });

  it('returns empty when summarisk fetch fails', async () => {
    tlFetchMock
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ items: [{ uuid: 'ej-1' }] }) })
      .mockResolvedValueOnce({ status: 500, body: '' });
    const r = await fetchTinglysningPriceRowsByBfe(1000);
    expect(r).toEqual([]);
  });

  it('parses KontantKoebesum + dates from summarisk XML', async () => {
    tlFetchMock
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ items: [{ uuid: 'ej-1' }] }) })
      .mockResolvedValueOnce({ status: 200, body: SUMMARISK_XML });
    const r = await fetchTinglysningPriceRowsByBfe(2091166);
    expect(r).toHaveLength(2);
    expect(r[0].kontantKoebesum).toBe(3500000);
    expect(r[0].iAltKoebesum).toBe(3550000);
    expect(r[0].overtagelsesdato).toBe('2023-04-01');
    expect(r[0].koebsaftaleDato).toBe('2023-03-15');
    expect(r[0].dokumentId).toBe('doc-uuid-1');
  });

  it('caches results across calls', async () => {
    tlFetchMock
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ items: [{ uuid: 'ej-1' }] }) })
      .mockResolvedValueOnce({ status: 200, body: SUMMARISK_XML });
    await fetchTinglysningPriceRowsByBfe(99999);
    await fetchTinglysningPriceRowsByBfe(99999);
    expect(tlFetchMock).toHaveBeenCalledTimes(2); // only the first call hits tlFetch
  });

  it('swallows throw from tlFetch', async () => {
    tlFetchMock.mockRejectedValue(new Error('network'));
    const r = await fetchTinglysningPriceRowsByBfe(50);
    expect(r).toEqual([]);
  });
});

describe('indexPriceRowsByDate — BIZZ-685 iter 2', () => {
  it('keys by overtagelsesdato YYYY-MM-DD', () => {
    const m = indexPriceRowsByDate([
      {
        overtagelsesdato: '2023-04-01',
        tinglysningsdato: null,
        koebsaftaleDato: null,
        kontantKoebesum: 100,
        iAltKoebesum: null,
        dokumentId: 'a',
      },
    ]);
    expect(m.get('2023-04-01')?.kontantKoebesum).toBe(100);
  });

  it('prefers the priced entry on duplicate dates', () => {
    const m = indexPriceRowsByDate([
      {
        overtagelsesdato: '2020-03-01',
        tinglysningsdato: null,
        koebsaftaleDato: null,
        kontantKoebesum: null,
        iAltKoebesum: null,
        dokumentId: 'a',
      },
      {
        overtagelsesdato: '2020-03-01',
        tinglysningsdato: null,
        koebsaftaleDato: null,
        kontantKoebesum: 2000000,
        iAltKoebesum: null,
        dokumentId: 'b',
      },
    ]);
    expect(m.get('2020-03-01')?.kontantKoebesum).toBe(2000000);
  });

  it('falls back to tinglysningsdato when overtagelse is missing', () => {
    const m = indexPriceRowsByDate([
      {
        overtagelsesdato: null,
        tinglysningsdato: '2019-12-05',
        koebsaftaleDato: null,
        kontantKoebesum: 500,
        iAltKoebesum: null,
        dokumentId: 'a',
      },
    ]);
    expect(m.get('2019-12-05')?.kontantKoebesum).toBe(500);
  });
});
