/**
 * BIZZ-716: enrichEntities unit tests.
 *
 * The helper hits Supabase + Datafordeler so we mock those modules —
 * the goal is to assert shape + cap behaviour, not to exercise the
 * external systems (integration tests handle that).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchBbrAreasByBfeMock = vi.fn();
const supabaseFromMock = vi.fn();

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: supabaseFromMock }),
}));
vi.mock('@/app/lib/fetchBbrData', () => ({
  fetchBbrAreasByBfe: (bfe: number) => fetchBbrAreasByBfeMock(bfe),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
function chain(returnValue: unknown): any {
  // Returns a thenable that resolves to { data, error } and also supports
  // arbitrary chained filter calls (.select().in().eq() etc).
  const proxy: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown) => resolve({ data: returnValue, error: null });
        }
        return () => proxy;
      },
    }
  );
  return proxy;
}

describe('enrichEntities — BIZZ-716', () => {
  afterEach(() => {
    vi.resetModules();
    fetchBbrAreasByBfeMock.mockReset();
    supabaseFromMock.mockReset();
  });

  it('returns empty when no entities provided', async () => {
    const { enrichEntities } = await import('@/app/lib/domainEnrichEntities');
    const r = await enrichEntities({ cvrs: [], bfes: [] });
    expect(r).toEqual([]);
  });

  it('fetches cvr_virksomhed rows for CVR identifiers', async () => {
    supabaseFromMock.mockImplementation((table: string) => {
      if (table === 'cvr_virksomhed') {
        return chain([{ cvr: '12345678', navn: 'Acme ApS', branche_tekst: 'Ejendomsudvikling' }]);
      }
      return chain([]);
    });
    const { enrichEntities } = await import('@/app/lib/domainEnrichEntities');
    const r = await enrichEntities({ cvrs: ['12345678'], bfes: [] });
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe('cvr');
    expect(r[0].id).toBe('12345678');
    expect(String(r[0].data)).toContain('Acme ApS');
  });

  it('caps per-type entity count at MAX_ENTITIES_PER_TYPE', async () => {
    const { MAX_ENTITIES_PER_TYPE, enrichEntities } =
      await import('@/app/lib/domainEnrichEntities');
    // Build list longer than the cap
    const tooMany = Array.from({ length: MAX_ENTITIES_PER_TYPE + 4 }, (_, i) =>
      String(10000000 + i)
    );
    supabaseFromMock.mockImplementation(() =>
      chain(tooMany.slice(0, MAX_ENTITIES_PER_TYPE).map((cvr) => ({ cvr, navn: 'X' })))
    );
    const r = await enrichEntities({ cvrs: tooMany, bfes: [] });
    expect(r.length).toBeLessThanOrEqual(MAX_ENTITIES_PER_TYPE);
  });

  it('enriches BFEs with current owners and BBR areas', async () => {
    fetchBbrAreasByBfeMock.mockResolvedValue({
      boligAreal: 120,
      erhvervsAreal: null,
      samletBygningsareal: 120,
    });
    supabaseFromMock.mockImplementation((table: string) => {
      if (table === 'ejf_ejerskab') {
        return chain([
          {
            bfe_nummer: 100165718,
            ejer_navn: 'Acme ApS',
            ejer_cvr: '12345678',
            ejer_type: 'virksomhed',
            andel: '1/1',
            virkning_fra: '2023-04-01',
            status: 'gældende',
          },
        ]);
      }
      return chain([]);
    });
    const { enrichEntities } = await import('@/app/lib/domainEnrichEntities');
    const r = await enrichEntities({ cvrs: [], bfes: ['100165718'] });
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe('bfe');
    expect(r[0].id).toBe('100165718');
    const payload = String(r[0].data);
    expect(payload).toContain('Acme ApS');
    expect(payload).toContain('120');
  });

  it('swallows Supabase errors silently — caller gets a partial result', async () => {
    supabaseFromMock.mockImplementation(() => {
      throw new Error('connection refused');
    });
    const { enrichEntities } = await import('@/app/lib/domainEnrichEntities');
    const r = await enrichEntities({ cvrs: ['12345678'], bfes: [] });
    // Shouldn't throw, returns empty (no data)
    expect(r).toEqual([]);
  });

  it('truncates oversized JSON payloads past PER_ENTITY_CHAR_CAP', async () => {
    const big = 'x'.repeat(5000);
    supabaseFromMock.mockImplementation(() => chain([{ cvr: '12345678', navn: big }]));
    const { enrichEntities, PER_ENTITY_CHAR_CAP } = await import('@/app/lib/domainEnrichEntities');
    const r = await enrichEntities({ cvrs: ['12345678'], bfes: [] });
    expect(r).toHaveLength(1);
    expect(String(r[0].data).length).toBeLessThanOrEqual(PER_ENTITY_CHAR_CAP);
    expect(String(r[0].data)).toContain('truncated');
  });
});
