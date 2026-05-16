/**
 * Unit tests for tinglysningHandlerCache (BIZZ-1550).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

import { createClient } from '@supabase/supabase-js';
import {
  parseHandlerRowsFromSummarisk,
  isCacheFresh,
  readCachedHandler,
  upsertHandlerRows,
  backfillHandlerForBfe,
  _resetHandlerCacheClientForTests,
} from '@/app/lib/tinglysningHandlerCache';

const mockCreate = vi.mocked(createClient);

beforeEach(() => {
  mockCreate.mockReset();
  _resetHandlerCacheClientForTests();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'srv';
});

const SUMMARISK_XML = `<?xml version="1.0"?>
<EjendomSummariskSvar xmlns="urn:tl">
  <AdkomstSummariskSamling>
    <AdkomstSummarisk>
      <DokumentIdentifikator>doc-001</DokumentIdentifikator>
      <SkoedeOvertagelsesDato>2020-06-01</SkoedeOvertagelsesDato>
      <TinglysningsDato>2020-06-15</TinglysningsDato>
      <KoeberNavn>Anders Andersen</KoeberNavn>
      <KoeberCVR>99999991</KoeberCVR>
      <AdkomstType>Skoede</AdkomstType>
      <KontantKoebesum>4250000</KontantKoebesum>
      <IAltKoebesum>4500000</IAltKoebesum>
      <LoesoereBeloeb>50000</LoesoereBeloeb>
      <EntrepriseBeloeb>200000</EntrepriseBeloeb>
      <TinglysningsAfgift>17000</TinglysningsAfgift>
      <Andel>1/1</Andel>
    </AdkomstSummarisk>
    <AdkomstSummarisk>
      <SkoedeOvertagelsesDato>2015-03-01</SkoedeOvertagelsesDato>
      <KoeberNavn>ACME Holding A/S</KoeberNavn>
      <KoeberCVR>99999992</KoeberCVR>
      <AdkomstType>Skoede</AdkomstType>
      <KontantKoebesum>3100000</KontantKoebesum>
    </AdkomstSummarisk>
    <AdkomstSummarisk>
      <KoeberNavn>Mangler-dato (springes over)</KoeberNavn>
    </AdkomstSummarisk>
  </AdkomstSummariskSamling>
</EjendomSummariskSvar>`;

describe('parseHandlerRowsFromSummarisk', () => {
  it('ekstraherer alle felter når til stede', () => {
    const rows = parseHandlerRowsFromSummarisk(SUMMARISK_XML);
    expect(rows).toHaveLength(2); // 3. entry har ingen dato → skippet
    expect(rows[0]).toMatchObject({
      overtagelsesdato: '2020-06-01',
      tinglysningsdato: '2020-06-15',
      koeber_navn: 'Anders Andersen',
      koeber_cvr: 99999991,
      adkomst_type: 'Skoede',
      kontant_koebesum: 4250000,
      ialt_koebesum: 4500000,
      loesoere: 50000,
      entreprise: 200000,
      tinglysningsafgift: 17000,
      andel: '1/1',
      dokument_id: 'doc-001',
    });
  });

  it('håndterer manglende optional felter som null', () => {
    const rows = parseHandlerRowsFromSummarisk(SUMMARISK_XML);
    expect(rows[1]).toMatchObject({
      overtagelsesdato: '2015-03-01',
      koeber_navn: 'ACME Holding A/S',
      koeber_cvr: 99999992,
      kontant_koebesum: 3100000,
      ialt_koebesum: null,
      loesoere: null,
      tinglysningsafgift: null,
      andel: null,
      dokument_id: null,
    });
  });

  it('springer rows uden overtagelsesdato over (PK kræver dato)', () => {
    const rows = parseHandlerRowsFromSummarisk(SUMMARISK_XML);
    expect(rows.every((r) => r.overtagelsesdato !== null)).toBe(true);
  });

  it('returnerer tomt array på XML uden AdkomstSummariskSamling', () => {
    expect(parseHandlerRowsFromSummarisk('<x/>')).toEqual([]);
  });
});

describe('isCacheFresh', () => {
  const now = new Date('2026-05-16T12:00:00Z');

  it('tom cache er aldrig fresh', () => {
    expect(isCacheFresh([], now)).toBe(false);
  });

  it('rows opdateret i dag er fresh', () => {
    const rows = [{ sidst_opdateret: '2026-05-15T12:00:00Z' }] as never;
    expect(isCacheFresh(rows, now)).toBe(true);
  });

  it('rows ældre end 14 dage er stale', () => {
    const rows = [{ sidst_opdateret: '2026-04-01T12:00:00Z' }] as never;
    expect(isCacheFresh(rows, now)).toBe(false);
  });

  it('blandet (én stale) gør hele cache stale', () => {
    const rows = [
      { sidst_opdateret: '2026-05-15T12:00:00Z' },
      { sidst_opdateret: '2026-01-01T12:00:00Z' },
    ] as never;
    expect(isCacheFresh(rows, now)).toBe(false);
  });
});

describe('readCachedHandler', () => {
  it('returnerer [] hvis env mangler', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(await readCachedHandler(12345)).toEqual([]);
  });

  it('returnerer rows fra DB ved hit', async () => {
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          bfe_nummer: 12345,
          overtagelsesdato: '2020-01-01',
          sidst_opdateret: new Date().toISOString(),
        },
      ],
      error: null,
    });
    const eq = vi.fn().mockReturnValue({ order });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });
    mockCreate.mockReturnValue({ from } as never);

    const rows = await readCachedHandler(12345);
    expect(rows).toHaveLength(1);
    expect(rows[0].bfe_nummer).toBe(12345);
  });

  it('fail-soft: returnerer [] ved DB-fejl', async () => {
    const order = vi.fn().mockResolvedValue({ data: null, error: new Error('boom') });
    const eq = vi.fn().mockReturnValue({ order });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });
    mockCreate.mockReturnValue({ from } as never);

    expect(await readCachedHandler(12345)).toEqual([]);
  });
});

describe('upsertHandlerRows', () => {
  it('returnerer 0 ved tom input', async () => {
    expect(await upsertHandlerRows(12345, [])).toBe(0);
  });

  it('upserter med composite PK', async () => {
    const upsert = vi.fn().mockResolvedValue({ count: 2, error: null });
    const from = vi.fn().mockReturnValue({ upsert });
    mockCreate.mockReturnValue({ from } as never);

    const rows = parseHandlerRowsFromSummarisk(SUMMARISK_XML);
    const n = await upsertHandlerRows(12345, rows);
    expect(n).toBe(2);
    expect(upsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ bfe_nummer: 12345, sidst_opdateret: expect.any(String) }),
      ]),
      { onConflict: 'bfe_nummer,overtagelsesdato', count: 'exact' }
    );
  });
});

describe('backfillHandlerForBfe', () => {
  it('kalder injectable fetchSummarisk + upserter', async () => {
    const upsert = vi.fn().mockResolvedValue({ count: 2, error: null });
    const from = vi.fn().mockReturnValue({ upsert });
    mockCreate.mockReturnValue({ from } as never);

    const fetcher = vi.fn().mockResolvedValue(SUMMARISK_XML);
    const n = await backfillHandlerForBfe(12345, fetcher);
    expect(fetcher).toHaveBeenCalledWith(12345);
    expect(n).toBe(2);
  });

  it('returnerer 0 hvis fetcher kaster', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network'));
    const n = await backfillHandlerForBfe(12345, fetcher);
    expect(n).toBe(0);
  });

  it('returnerer 0 hvis XML har ingen handler', async () => {
    const fetcher = vi.fn().mockResolvedValue('<x/>');
    const n = await backfillHandlerForBfe(12345, fetcher);
    expect(n).toBe(0);
  });
});
