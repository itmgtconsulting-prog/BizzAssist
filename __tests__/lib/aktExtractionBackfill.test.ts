/**
 * Unit tests for aktExtractionBackfill (BIZZ-1598).
 *
 * Dækker:
 * - Insert med korrekte felter + kilde='ai_extraction'
 * - Dedupe ved dato-match inden for ±30 dage
 * - Dedupe via unique constraint (23505 → tæller som dedupe, ikke fejl)
 * - Skip ved manglende påkrævede felter (bfe/dato/navn)
 * - Stats: total/inserted/deduped/failed beregnes korrekt
 * - Tomt array returnerer tomt resultat
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from '@/lib/supabase/admin';
import { backfillExtractedHandler, type ExtractedHandel } from '@/app/lib/aktExtractionBackfill';

const mockCreate = vi.mocked(createAdminClient);

/**
 * Make admin client with configurable behavior:
 * - existingForBfe: map of bfe_nummer → existing rows returned by dedupe-lookup
 * - insertError: error to return from insert (e.g. {code:'23505'})
 */
function makeAdmin(
  opts: {
    existingForBfe?: Record<number, Array<{ id: number }>>;
    insertError?: { code: string; message: string } | null;
    captureInsert?: (row: unknown) => void;
  } = {}
) {
  const insert = vi.fn().mockImplementation((row: unknown) => {
    opts.captureInsert?.(row);
    return Promise.resolve({ error: opts.insertError ?? null });
  });

  const lte = vi.fn();
  const gte = vi.fn().mockReturnValue({ lte });
  const eq2 = vi.fn().mockReturnValue({ gte });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
  const select = vi.fn().mockReturnValue({ eq: eq1 });
  const from = vi.fn().mockReturnValue({ select, insert });

  // Wire lte().limit() to return existing rows based on bfe captured in eq1
  let lastBfe = 0;
  eq1.mockImplementation((col: string, val: unknown) => {
    if (col === 'bfe_nummer') lastBfe = Number(val);
    return { eq: eq2 };
  });
  lte.mockImplementation(() => ({
    limit: vi.fn().mockResolvedValue({ data: opts.existingForBfe?.[lastBfe] ?? [], error: null }),
  }));

  return {
    from,
    _spy: { from, select, insert, eq1, eq2, gte, lte },
  };
}

const SAMPLE_HANDEL: ExtractedHandel = {
  bfe_nummer: 12345,
  overtagelsesdato: '2003-04-24',
  ejer_navn: 'Anders Andersen',
  kontant_koebesum: 1_370_600,
  dokument_type: 'Skoede',
};

beforeEach(() => {
  mockCreate.mockReset();
});

describe('backfillExtractedHandler', () => {
  it('returnerer tom resultat ved tomt input', async () => {
    const admin = makeAdmin();
    mockCreate.mockReturnValue(admin as never);
    const r = await backfillExtractedHandler([]);
    expect(r).toEqual({ total: 0, inserted: 0, deduped: 0, failed: 0 });
    expect(admin._spy.insert).not.toHaveBeenCalled();
  });

  it('inserter ny handel med kilde="ai_extraction"', async () => {
    let captured: Record<string, unknown> | null = null;
    const admin = makeAdmin({
      captureInsert: (row) => {
        captured = row as Record<string, unknown>;
      },
    });
    mockCreate.mockReturnValue(admin as never);
    const r = await backfillExtractedHandler([SAMPLE_HANDEL]);
    expect(r).toEqual({ total: 1, inserted: 1, deduped: 0, failed: 0 });
    expect(captured).toMatchObject({
      bfe_nummer: 12345,
      overtagelsesdato: '2003-04-24',
      ejer_navn: 'Anders Andersen',
      kontant_koebesum: 1_370_600,
      kilde: 'ai_extraction',
      historisk_kilde: 'Skoede',
    });
  });

  it('dedupliker ved dato-match inden for ±30 dage', async () => {
    const admin = makeAdmin({
      existingForBfe: { 12345: [{ id: 999 }] }, // eksisterende handel for samme bfe + navn
    });
    mockCreate.mockReturnValue(admin as never);
    const r = await backfillExtractedHandler([SAMPLE_HANDEL]);
    expect(r).toEqual({ total: 1, inserted: 0, deduped: 1, failed: 0 });
    expect(admin._spy.insert).not.toHaveBeenCalled();
  });

  it('dedupe via unique constraint (23505) tæller ikke som fejl', async () => {
    const admin = makeAdmin({
      insertError: { code: '23505', message: 'duplicate key' },
    });
    mockCreate.mockReturnValue(admin as never);
    const r = await backfillExtractedHandler([SAMPLE_HANDEL]);
    expect(r).toEqual({ total: 1, inserted: 0, deduped: 1, failed: 0 });
  });

  it('andre DB-fejl tæller som failed', async () => {
    const admin = makeAdmin({
      insertError: { code: '23502', message: 'not null violation' },
    });
    mockCreate.mockReturnValue(admin as never);
    const r = await backfillExtractedHandler([SAMPLE_HANDEL]);
    expect(r).toEqual({ total: 1, inserted: 0, deduped: 0, failed: 1 });
  });

  it('skipper handel uden bfe_nummer', async () => {
    const admin = makeAdmin();
    mockCreate.mockReturnValue(admin as never);
    const r = await backfillExtractedHandler([{ ...SAMPLE_HANDEL, bfe_nummer: 0 }]);
    expect(r).toEqual({ total: 1, inserted: 0, deduped: 0, failed: 1 });
    expect(admin._spy.insert).not.toHaveBeenCalled();
  });

  it('skipper handel uden overtagelsesdato', async () => {
    const admin = makeAdmin();
    mockCreate.mockReturnValue(admin as never);
    const r = await backfillExtractedHandler([{ ...SAMPLE_HANDEL, overtagelsesdato: '' }]);
    expect(r.failed).toBe(1);
    expect(r.inserted).toBe(0);
  });

  it('skipper handel uden ejer_navn (dedupe-key)', async () => {
    const admin = makeAdmin();
    mockCreate.mockReturnValue(admin as never);
    const r = await backfillExtractedHandler([{ ...SAMPLE_HANDEL, ejer_navn: '' }]);
    expect(r.failed).toBe(1);
    expect(admin._spy.insert).not.toHaveBeenCalled();
  });

  it('processerer batch: 1 ny + 1 dedup + 1 fail', async () => {
    const admin = makeAdmin({
      existingForBfe: { 22222: [{ id: 1 }] }, // BFE 22222 har allerede en handel
    });
    mockCreate.mockReturnValue(admin as never);
    const r = await backfillExtractedHandler([
      { ...SAMPLE_HANDEL, bfe_nummer: 11111 }, // ny
      { ...SAMPLE_HANDEL, bfe_nummer: 22222 }, // dedup
      { ...SAMPLE_HANDEL, bfe_nummer: 0 }, // fail (manglende felt)
    ]);
    expect(r).toEqual({ total: 3, inserted: 1, deduped: 1, failed: 1 });
  });

  it('inkluderer cvr + ejer_type når til stede', async () => {
    let captured: Record<string, unknown> | null = null;
    const admin = makeAdmin({
      captureInsert: (row) => {
        captured = row as Record<string, unknown>;
      },
    });
    mockCreate.mockReturnValue(admin as never);
    await backfillExtractedHandler([
      {
        ...SAMPLE_HANDEL,
        ejer_navn: 'ACME Holding A/S',
        ejer_cvr: '24301117',
        ejer_type: 'virksomhed',
        i_alt_koebesum: 1_500_000,
      },
    ]);
    expect(captured).toMatchObject({
      ejer_cvr: '24301117',
      ejer_type: 'virksomhed',
      i_alt_koebesum: 1_500_000,
    });
  });
});
