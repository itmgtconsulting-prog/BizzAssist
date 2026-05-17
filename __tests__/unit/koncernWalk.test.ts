/**
 * Unit tests for koncernWalk — BIZZ-1362.
 *
 * Mocks Supabase admin client to test traversal logic
 * without hitting a real database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock createAdminClient before importing the module
const mockFrom = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: mockFrom }),
}));

// Import after mock setup
const { walkKoncern } = await import('@/app/lib/forsikring/koncernWalk');

/** Helper: mock a Supabase query chain */
function mockQuery(data: unknown[] | null) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.is = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue({ data, error: null });
  chain.maybeSingle = vi.fn().mockReturnValue({ data: data?.[0] ?? null, error: null });
  return chain;
}

describe('walkKoncern', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ejendomme for a virksomhed via ejf_ejerskab', async () => {
    const ejfChain = mockQuery([
      { bfe_nummer: 123456, ejerandel_taeller: 1, ejerandel_naevner: 1 },
      { bfe_nummer: 789012, ejerandel_taeller: 1, ejerandel_naevner: 2 },
    ]);
    const subChain = mockQuery([]); // Ingen datterselskaber
    const boardChain = mockQuery([]); // Ingen bestyrelse

    mockFrom.mockImplementation((table: string) => {
      if (table === 'ejf_ejerskab') return ejfChain;
      if (table === 'cvr_virksomhed_ejerskab') return subChain;
      if (table === 'cvr_deltagerrelation') return boardChain;
      return mockQuery([]);
    });

    const result = await walkKoncern('virksomhed', '12345678');

    // BIZZ-1443: +1 for virksomheden selv som aktiv
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe('virksomhed');
    expect(result[1].type).toBe('ejendom');
    expect(result[1].bfe).toBe(123456);
    expect(result[2].bfe).toBe(789012);
  });

  it('walks datterselskaber recursively', async () => {
    let ejfCallCount = 0;
    const subChain = mockQuery([{ ejet_cvr: '99887766', ejerandel_min: 100 }]);
    const virkChain = mockQuery([
      { navn: 'Datter ApS', ansatte: 5, branche_tekst: 'IT', ophoert: null },
    ]);

    mockFrom.mockImplementation((table: string) => {
      if (table === 'ejf_ejerskab') {
        ejfCallCount++;
        // Parent har 1 ejendom, datter har 1 anden ejendom
        if (ejfCallCount === 1)
          return mockQuery([{ bfe_nummer: 100, ejerandel_taeller: 1, ejerandel_naevner: 1 }]);
        return mockQuery([{ bfe_nummer: 200, ejerandel_taeller: 1, ejerandel_naevner: 1 }]);
      }
      if (table === 'cvr_virksomhed_ejerskab') {
        // Kun parent har datter, datter har ingen
        if (ejfCallCount <= 1) return subChain;
        return mockQuery([]);
      }
      if (table === 'cvr_virksomhed') return virkChain;
      if (table === 'cvr_deltagerrelation') return mockQuery([]);
      return mockQuery([]);
    });

    const result = await walkKoncern('virksomhed', '11223344');

    const ejendomme = result.filter((a) => a.type === 'ejendom');
    const virksomheder = result.filter((a) => a.type === 'virksomhed');
    expect(ejendomme.length).toBeGreaterThanOrEqual(2);
    // BIZZ-1443: parent + datter (+ evt. sub-datter) = ≥2 virksomheder
    expect(virksomheder.length).toBeGreaterThanOrEqual(2);
    expect(virksomheder.some((v) => v.label === 'Datter ApS')).toBe(true);
  });

  it('detects cyclic ownership and stops', async () => {
    let callCount = 0;

    mockFrom.mockImplementation((table: string) => {
      if (table === 'ejf_ejerskab') return mockQuery([]);
      if (table === 'cvr_virksomhed_ejerskab') {
        callCount++;
        // A ejer B, B ejer A → infinite loop
        if (callCount === 1) return mockQuery([{ ejet_cvr: 'B', ejerandel_min: 50 }]);
        if (callCount === 2) return mockQuery([{ ejet_cvr: 'A', ejerandel_min: 50 }]);
        return mockQuery([]);
      }
      if (table === 'cvr_virksomhed')
        return mockQuery([{ navn: 'Test', ansatte: null, branche_tekst: null, ophoert: null }]);
      if (table === 'cvr_deltagerrelation') return mockQuery([]);
      return mockQuery([]);
    });

    const result = await walkKoncern('virksomhed', 'A');
    // Should not infinite loop — verify it terminates
    expect(result.length).toBeLessThan(10);
  });

  it('returns personligt ejede ejendomme for person', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'cvr_deltagerrelation') return mockQuery([]);
      if (table === 'ejf_ejerskab')
        return mockQuery([{ bfe_nummer: 555, ejerandel_taeller: 1, ejerandel_naevner: 1 }]);
      return mockQuery([]);
    });

    const result = await walkKoncern('person', '4000115446');

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('ejendom');
    expect(result[0].bfe).toBe(555);
  });

  it('caps at MAX_AKTIVER (500)', async () => {
    const manyProps = Array.from({ length: 600 }, (_, i) => ({
      bfe_nummer: 1000 + i,
      ejerandel_taeller: 1,
      ejerandel_naevner: 1,
    }));

    mockFrom.mockImplementation((table: string) => {
      if (table === 'ejf_ejerskab') return mockQuery(manyProps);
      if (table === 'cvr_virksomhed_ejerskab') return mockQuery([]);
      if (table === 'cvr_deltagerrelation') return mockQuery([]);
      return mockQuery([]);
    });

    const result = await walkKoncern('virksomhed', '12345678');
    expect(result.length).toBeLessThanOrEqual(500);
  });
});
