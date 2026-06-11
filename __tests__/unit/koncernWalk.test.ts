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
  chain.gte = vi.fn().mockReturnValue(chain);
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

  it('BIZZ-2101: datterselskabs-opslag bruger kun eksisterende kolonner, mapper ansatte_aar og filtrerer ophørte', async () => {
    // Kolonner der faktisk findes i cvr_virksomhed (skemaet har ansatte_aar +
    // ansatte_kvartal_1..4 — IKKE 'ansatte'). En select med ukendt kolonne
    // afvises af PostgREST → virk=null → "CVR x"-labels (BIZZ-2101-buggen).
    const SCHEMA_COLS = new Set([
      'navn',
      'branche_tekst',
      'virksomhedsform',
      'ophoert',
      'ansatte_aar',
      'ansatte_kvartal_1',
      'ansatte_kvartal_2',
      'ansatte_kvartal_3',
      'ansatte_kvartal_4',
    ]);
    const virkSelects: string[] = [];

    let subCall = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ejf_ejerskab') return mockQuery([]);
      if (table === 'cvr_virksomhed_ejerskab') {
        subCall++;
        // Parent har to døtre: én aktiv, én ophørt. Døtrene har ingen døtre.
        if (subCall === 1)
          return mockQuery([
            { ejet_cvr: '11111111', ejerandel_min: 100 },
            { ejet_cvr: '22222222', ejerandel_min: 100 },
          ]);
        return mockQuery([]);
      }
      if (table === 'cvr_virksomhed') {
        const chain = mockQuery([]);
        chain.select = vi.fn().mockImplementation((cols: string) => {
          virkSelects.push(cols);
          return chain;
        });
        let requestedCvr = '';
        chain.eq = vi.fn().mockImplementation((_col: string, val: string) => {
          requestedCvr = val;
          return chain;
        });
        chain.maybeSingle = vi.fn().mockImplementation(() => {
          if (requestedCvr === '11111111')
            return {
              data: {
                navn: 'Aktiv Datter A/S',
                ansatte_aar: 42,
                branche_tekst: 'IT',
                ophoert: null,
              },
              error: null,
            };
          if (requestedCvr === '22222222')
            return {
              data: {
                navn: 'Ophørt ApS',
                ansatte_aar: 3,
                branche_tekst: 'IT',
                ophoert: '2020-06-01',
              },
              error: null,
            };
          return { data: null, error: null };
        });
        return chain;
      }
      if (table === 'cvr_deltagerrelation') return mockQuery([]);
      return mockQuery([]);
    });

    const result = await walkKoncern('virksomhed', '41341009');

    // 1) Alle cvr_virksomhed-selects må kun bede om eksisterende kolonner
    expect(virkSelects.length).toBeGreaterThan(0);
    for (const sel of virkSelects) {
      for (const col of sel.split(',').map((s) => s.trim())) {
        expect(SCHEMA_COLS.has(col), `ukendt kolonne '${col}' i select '${sel}'`).toBe(true);
      }
    }

    // 2) Aktiv datter får navn + ansatte_aar mappet til ansatte
    const datter = result.find((a) => a.cvr === '11111111');
    expect(datter?.label).toBe('Aktiv Datter A/S');
    expect(datter?.ansatte).toBe(42);

    // 3) Ophørt datter filtreres fra
    expect(result.some((a) => a.cvr === '22222222')).toBe(false);
  });

  it('BIZZ-2103: ekskluderer stale rækker (andel null) og minoritetsposter (< 50%)', async () => {
    // Parent "ejer" fire selskaber i cachen: 100% (reel datter), 50% (kontrol),
    // 5% (minoritetspost, fx SKIINVEST) og NULL (stale række fra cron'en, fx
    // RacingRoom solgt i 2020 hvor EJERANDEL_PROCENT-perioden er afsluttet).
    // Kun >= 50% må walkes som koncern-selskaber.
    let subCall = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ejf_ejerskab') return mockQuery([]);
      if (table === 'cvr_virksomhed_ejerskab') {
        subCall++;
        if (subCall === 1)
          return mockQuery([
            { ejet_cvr: '10000001', ejerandel_min: 100 },
            { ejet_cvr: '10000002', ejerandel_min: 50 },
            { ejet_cvr: '10000003', ejerandel_min: 5 },
            { ejet_cvr: '10000004', ejerandel_min: null },
          ]);
        return mockQuery([]);
      }
      if (table === 'cvr_virksomhed')
        return mockQuery([{ navn: 'Datter', ansatte_aar: 1, branche_tekst: null, ophoert: null }]);
      if (table === 'cvr_deltagerrelation') return mockQuery([]);
      return mockQuery([]);
    });

    const result = await walkKoncern('virksomhed', '28864973');

    const cvrs = result.filter((a) => a.type === 'virksomhed').map((a) => a.cvr);
    expect(cvrs).toContain('10000001'); // 100% — med
    expect(cvrs).toContain('10000002'); // 50% — med (kontrol-tærskel)
    expect(cvrs).not.toContain('10000003'); // 5% minoritet — ekskluderet
    expect(cvrs).not.toContain('10000004'); // stale NULL-andel — ekskluderet
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
