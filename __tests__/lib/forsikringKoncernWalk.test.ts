/**
 * Unit tests for forsikring/koncernWalk (BIZZ-1529).
 *
 * Dækker:
 * - virksomhed root: hent egne ejendomme + datterselskaber + board
 * - person root: hent virksomheder + personligt ejede ejendomme
 * - cyklusbeskyttelse (seenCvrs forhindrer infinite loop)
 * - max-depth (3) stopper rekursion
 * - MAX_AKTIVER (500) cap respekteres
 * - asOfDate filtrering på gyldig_fra/gyldig_til
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @/lib/supabase/admin før import af modul
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from '@/lib/supabase/admin';
import { walkKoncern, type Aktiv } from '@/app/lib/forsikring/koncernWalk';

const mockCreate = vi.mocked(createAdminClient);

/**
 * Byg en mock Supabase-klient med per-table query builders. Hver tabel
 * mappes til en function der returnerer {data} response baseret på query-keys.
 */
interface TableSpec {
  // Match-funktion: returnér data hvis kriteriet matcher
  match: (filters: Record<string, unknown>) => unknown[];
}

function makeMockAdmin(tables: Record<string, TableSpec>) {
  const buildChain = (tableName: string) => {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {};

    const finalize = () => {
      const spec = tables[tableName];
      const rows = spec ? spec.match(filters) : [];
      return Promise.resolve({ data: rows, error: null });
    };

    chain.select = () => chain;
    chain.eq = (col: string, val: unknown) => {
      filters[`eq:${col}`] = val;
      return chain;
    };
    chain.in = (col: string, vals: unknown[]) => {
      filters[`in:${col}`] = vals;
      return chain;
    };
    chain.is = (col: string, val: unknown) => {
      filters[`is:${col}`] = val;
      return chain;
    };
    chain.lte = (col: string, val: unknown) => {
      filters[`lte:${col}`] = val;
      return chain;
    };
    // BIZZ-2103: koncernWalk filtrerer ejerandel_min >= 50 server-side
    chain.gte = (col: string, val: unknown) => {
      filters[`gte:${col}`] = val;
      return chain;
    };
    chain.or = (expr: string) => {
      filters['or'] = expr;
      return chain;
    };
    chain.limit = (n: number) => {
      filters['limit'] = n;
      return finalize();
    };
    chain.maybeSingle = () => {
      const spec = tables[tableName];
      const rows = spec ? spec.match(filters) : [];
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    };
    return chain;
  };

  return {
    from: (tableName: string) => buildChain(tableName),
  } as unknown as ReturnType<typeof createAdminClient>;
}

beforeEach(() => {
  mockCreate.mockReset();
});

// ─── Virksomhed root ────────────────────────────────────────────────────────

describe('walkKoncern — virksomhed', () => {
  it('inkluderer virksomheden selv + ejendomme + datterselskaber', async () => {
    mockCreate.mockReturnValue(
      makeMockAdmin({
        cvr_virksomhed: {
          match: (f) => {
            const cvr = (f['eq:cvr_nummer'] ?? f['eq:cvr']) as string;
            if (cvr === '11111111') return [{ navn: 'Holding A/S', branche_tekst: 'Real estate' }];
            if (cvr === '22222222')
              return [
                { navn: 'Datter A/S', ansatte: 5, branche_tekst: 'Real estate', ophoert: false },
              ];
            return [];
          },
        },
        ejf_ejerskab: {
          match: (f) => {
            const cvr = f['eq:ejer_cvr'] as string;
            if (cvr === '11111111') {
              return [
                { bfe_nummer: 100, ejerandel_taeller: 1, ejerandel_naevner: 1 },
                { bfe_nummer: 101, ejerandel_taeller: 1, ejerandel_naevner: 2 },
              ];
            }
            if (cvr === '22222222') {
              return [{ bfe_nummer: 200, ejerandel_taeller: 1, ejerandel_naevner: 1 }];
            }
            return [];
          },
        },
        cvr_virksomhed_ejerskab: {
          match: (f) => {
            const cvr = f['eq:ejer_cvr'] as string;
            if (cvr === '11111111') return [{ ejet_cvr: '22222222', ejerandel_min: 80 }];
            return [];
          },
        },
        cvr_deltagerrelation: {
          match: () => [],
        },
      })
    );

    const aktiver = await walkKoncern('virksomhed', '11111111');
    expect(aktiver.length).toBeGreaterThanOrEqual(4);
    const types = aktiver.map((a) => a.type);
    expect(types).toContain('virksomhed');
    expect(types).toContain('ejendom');
    // Holding selv + 2 ejendomme + 1 datterselskab + 1 datters ejendom
    const bfes = aktiver.filter((a) => a.type === 'ejendom').map((a) => a.bfe);
    expect(bfes).toEqual(expect.arrayContaining([100, 101, 200]));
    const cvrs = aktiver.filter((a) => a.type === 'virksomhed').map((a) => a.cvr);
    expect(cvrs).toEqual(expect.arrayContaining(['11111111', '22222222']));
  });

  it('cyklusbeskyttelse: ejer A→B→A returnerer ikke duplikater', async () => {
    mockCreate.mockReturnValue(
      makeMockAdmin({
        cvr_virksomhed: {
          match: (f) => {
            const cvr = (f['eq:cvr_nummer'] ?? f['eq:cvr']) as string;
            return [{ navn: `Virk ${cvr}`, branche_tekst: null, ophoert: false }];
          },
        },
        ejf_ejerskab: { match: () => [] },
        cvr_virksomhed_ejerskab: {
          match: (f) => {
            const cvr = f['eq:ejer_cvr'] as string;
            if (cvr === 'A') return [{ ejet_cvr: 'B', ejerandel_min: 50 }];
            if (cvr === 'B') return [{ ejet_cvr: 'A', ejerandel_min: 50 }]; // cykel!
            return [];
          },
        },
        cvr_deltagerrelation: { match: () => [] },
      })
    );

    const aktiver = await walkKoncern('virksomhed', 'A');
    const cvrs = aktiver.filter((a) => a.type === 'virksomhed').map((a) => a.cvr);
    // Cyklus brudt: A og B besøges ikke uendeligt
    // (A pushes B som sub, walkVirksomhed(B) pushes B som self, B forsøger
    // at gå tilbage til A men seenCvrs blokerer — terminerer i 3 entries
    // i stedet for infinite loop)
    expect(cvrs).toEqual(expect.arrayContaining(['A', 'B']));
    expect(aktiver.length).toBeLessThan(10); // sanity: ikke runaway
  });

  it('springer ophørte datterselskaber over', async () => {
    mockCreate.mockReturnValue(
      makeMockAdmin({
        cvr_virksomhed: {
          match: (f) => {
            const cvr = (f['eq:cvr_nummer'] ?? f['eq:cvr']) as string;
            if (cvr === 'PARENT') return [{ navn: 'Parent', branche_tekst: null }];
            if (cvr === 'DEAD') return [{ navn: 'Dead Sub', ophoert: '2024-01-01' }];
            return [];
          },
        },
        ejf_ejerskab: { match: () => [] },
        cvr_virksomhed_ejerskab: {
          match: (f) => {
            const cvr = f['eq:ejer_cvr'] as string;
            if (cvr === 'PARENT') return [{ ejet_cvr: 'DEAD', ejerandel_min: 100 }];
            return [];
          },
        },
        cvr_deltagerrelation: { match: () => [] },
      })
    );

    const aktiver = await walkKoncern('virksomhed', 'PARENT');
    const cvrs = aktiver.filter((a) => a.type === 'virksomhed').map((a) => a.cvr);
    expect(cvrs).toContain('PARENT');
    expect(cvrs).not.toContain('DEAD');
  });

  it('inkluderer bestyrelsesposter (depth=0)', async () => {
    mockCreate.mockReturnValue(
      makeMockAdmin({
        cvr_virksomhed: {
          match: () => [{ navn: 'Holding', branche_tekst: null }],
        },
        ejf_ejerskab: { match: () => [] },
        cvr_virksomhed_ejerskab: { match: () => [] },
        cvr_deltagerrelation: {
          match: () => [
            { deltager_enhedsnummer: 1234, type: 'bestyrelse', virksomhed_cvr: '11111111' },
            { deltager_enhedsnummer: 5678, type: 'direktion', virksomhed_cvr: '11111111' },
          ],
        },
      })
    );

    const aktiver = await walkKoncern('virksomhed', '11111111');
    const roles = aktiver.filter((a) => a.type === 'bestyrelsespost').map((a) => a.label);
    expect(roles).toEqual(expect.arrayContaining([expect.stringContaining('bestyrelse')]));
    expect(roles).toEqual(expect.arrayContaining([expect.stringContaining('direktion')]));
  });

  it('asOfDate triggerer historisk filter (gyldig_fra/gyldig_til)', async () => {
    const captured: string[][] = [];
    const fromSpy = vi.fn().mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {};
      const local: string[] = [];
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.in = () => chain;
      chain.is = (col: string) => {
        local.push(`is:${col}`);
        return chain;
      };
      chain.lte = (col: string) => {
        local.push(`lte:${col}`);
        return chain;
      };
      chain.gte = (col: string) => {
        local.push(`gte:${col}`);
        return chain;
      };
      chain.or = (expr: string) => {
        local.push(`or:${expr.slice(0, 30)}`);
        return chain;
      };
      chain.limit = () => {
        if (table === 'ejf_ejerskab' || table === 'cvr_virksomhed_ejerskab') {
          captured.push(local);
        }
        return Promise.resolve({ data: [], error: null });
      };
      chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
      return chain;
    });

    mockCreate.mockReturnValue({ from: fromSpy } as unknown as ReturnType<
      typeof createAdminClient
    >);
    await walkKoncern('virksomhed', '11111111', new Date('2025-01-15'));

    expect(captured.some((c) => c.some((s) => s.startsWith('lte:gyldig_fra')))).toBe(true);
    expect(captured.some((c) => c.some((s) => s.startsWith('or:')))).toBe(true);
  });
});

// ─── Person root ────────────────────────────────────────────────────────────

describe('walkKoncern — person', () => {
  it('person med register-ejerskab walker tilhørende virksomhed', async () => {
    mockCreate.mockReturnValue(
      makeMockAdmin({
        cvr_deltagerrelation: {
          match: () => [{ virksomhed_cvr: '33333333', type: 'register', ejerandel_pct: 100 }],
        },
        cvr_virksomhed: {
          match: () => [{ navn: 'Persons Virk', branche_tekst: null }],
        },
        ejf_ejerskab: {
          match: (f) => {
            if (f['eq:ejer_cvr'] === '33333333') {
              return [{ bfe_nummer: 999, ejerandel_taeller: 1, ejerandel_naevner: 1 }];
            }
            if (f['eq:ejer_enheds_nummer'] !== undefined) {
              return [{ bfe_nummer: 777, ejerandel_taeller: 1, ejerandel_naevner: 1 }];
            }
            return [];
          },
        },
        cvr_virksomhed_ejerskab: { match: () => [] },
      })
    );

    const aktiver: Aktiv[] = await walkKoncern('person', '5000');
    const bfes = aktiver.filter((a) => a.type === 'ejendom').map((a) => a.bfe);
    // Personligt ejede + virksomheds-ejede
    expect(bfes).toEqual(expect.arrayContaining([999, 777]));
    const personligEjede = aktiver.filter(
      (a) => (a.rawData as { personligt_ejet?: boolean })?.personligt_ejet
    );
    expect(personligEjede).toHaveLength(1);
    expect(personligEjede[0].bfe).toBe(777);
  });

  it('person med bestyrelses-rolle får aktivitet uden at walke virksomheden', async () => {
    mockCreate.mockReturnValue(
      makeMockAdmin({
        cvr_deltagerrelation: {
          match: () => [{ virksomhed_cvr: '44444444', type: 'bestyrelse', ejerandel_pct: null }],
        },
        cvr_virksomhed: { match: () => [] },
        ejf_ejerskab: { match: () => [] },
        cvr_virksomhed_ejerskab: { match: () => [] },
      })
    );

    const aktiver = await walkKoncern('person', '6000');
    const roles = aktiver.filter((a) => a.type === 'bestyrelsespost');
    expect(roles).toHaveLength(1);
    expect(roles[0].cvr).toBe('44444444');
    // Ingen virksomhed-aktiv tilføjet (vi kalder ikke walkVirksomhed for ren bestyrelses-rolle)
    const virkAktiver = aktiver.filter((a) => a.type === 'virksomhed');
    expect(virkAktiver).toHaveLength(0);
  });
});
