/**
 * Unit tests for app/lib/bbrEjendomStatus.ts (BIZZ-785 iter 2a).
 *
 * Verifies:
 *   - Tom input returnerer tom map uden DB-query
 *   - Dedupliker input-UUIDs (case-insensitive)
 *   - PostgREST-fejl returnerer tom map (silent fallback)
 *   - Exception fra createAdminClient returnerer tom map
 *   - upsertBbrStatus mapper felter + timestamp korrekt
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock admin-client før importen
const mockIn = vi.fn();
const mockSelect = vi.fn(() => ({ in: mockIn }));
const mockUpsert = vi.fn();
const mockFrom = vi.fn(() => ({ select: mockSelect, upsert: mockUpsert }));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({ from: mockFrom })),
}));

// Efter mocks registrerede vi importer modulet
import { fetchBbrStatusForAdresser, upsertBbrStatus } from '@/app/lib/bbrEjendomStatus';

describe('fetchBbrStatusForAdresser', () => {
  beforeEach(() => {
    mockFrom.mockClear();
    mockSelect.mockClear();
    mockIn.mockClear();
  });

  it('tom input returnerer tom map uden DB-kald', async () => {
    const result = await fetchBbrStatusForAdresser([]);
    expect(result.size).toBe(0);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('dedupliker case-insensitive', async () => {
    mockIn.mockResolvedValue({ data: [], error: null });
    await fetchBbrStatusForAdresser([
      'abc-123',
      'ABC-123', // samme uuid, lowercase
      'def-456',
    ]);
    expect(mockIn).toHaveBeenCalledTimes(1);
    // Kontroller at kun 2 unique UUIDs blev sendt
    const args = mockIn.mock.calls[0];
    expect(args[1]).toHaveLength(2);
  });

  it('mapper rows til BbrStatusEntry map', async () => {
    mockIn.mockResolvedValue({
      data: [
        {
          bfe_nummer: 2091165,
          adgangsadresse_id: 'abc-123',
          is_udfaset: true,
          bbr_status_code: 10,
          status_last_checked_at: '2026-04-23T12:00:00Z',
          samlet_boligareal: 120,
          opfoerelsesaar: 1965,
          energimaerke: 'C',
          byg021_anvendelse: 120,
        },
      ],
      error: null,
    });
    const result = await fetchBbrStatusForAdresser(['abc-123']);
    expect(result.get('abc-123')).toEqual({
      bfeNummer: 2091165,
      isUdfaset: true,
      bbrStatusCode: 10,
      statusLastCheckedAt: '2026-04-23T12:00:00Z',
      samletBoligareal: 120,
      opfoerelsesaar: 1965,
      energimaerke: 'C',
      anvendelseskode: 120,
    });
  });

  it('PostgREST-fejl returnerer tom map (silent)', async () => {
    mockIn.mockResolvedValue({ data: null, error: { message: 'table missing' } });
    const result = await fetchBbrStatusForAdresser(['abc-123']);
    expect(result.size).toBe(0);
  });

  it('exception under DB-call returnerer tom map', async () => {
    mockIn.mockRejectedValue(new Error('Network failed'));
    const result = await fetchBbrStatusForAdresser(['abc-123']);
    expect(result.size).toBe(0);
  });

  it('rows uden adgangsadresse_id skippes', async () => {
    mockIn.mockResolvedValue({
      data: [
        {
          bfe_nummer: 1,
          adgangsadresse_id: null,
          is_udfaset: false,
          bbr_status_code: null,
          status_last_checked_at: null,
        },
      ],
      error: null,
    });
    const result = await fetchBbrStatusForAdresser(['abc-123']);
    expect(result.size).toBe(0);
  });
});

describe('upsertBbrStatus', () => {
  beforeEach(() => {
    mockFrom.mockClear();
    mockUpsert.mockClear();
  });

  it('tom input skipper DB-kald', async () => {
    const res = await upsertBbrStatus([]);
    expect(res).toEqual({ upserted: 0, errors: 0 });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('mapper rows + tilføjer timestamp', async () => {
    mockUpsert.mockResolvedValue({ error: null, count: 2 });
    const res = await upsertBbrStatus([
      { bfe_nummer: 1, is_udfaset: true },
      { bfe_nummer: 2, is_udfaset: false, bbr_status_code: 3 },
    ]);
    expect(res).toEqual({ upserted: 2, errors: 0 });
    const payload = mockUpsert.mock.calls[0][0] as Array<{
      bfe_nummer: number;
      is_udfaset: boolean;
      bbr_status_code: number | null;
      kommune_kode: number | null;
      adgangsadresse_id: string | null;
      status_last_checked_at: string;
    }>;
    expect(payload).toHaveLength(2);
    expect(payload[0].bfe_nummer).toBe(1);
    expect(payload[0].adgangsadresse_id).toBe(null);
    expect(payload[0].status_last_checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(payload[1].bbr_status_code).toBe(3);
  });

  it('PostgREST-fejl returnerer errors=rows.length', async () => {
    mockUpsert.mockResolvedValue({ error: { message: 'unique violation' }, count: null });
    const res = await upsertBbrStatus([{ bfe_nummer: 1, is_udfaset: true }]);
    expect(res).toEqual({ upserted: 0, errors: 1 });
  });
});
