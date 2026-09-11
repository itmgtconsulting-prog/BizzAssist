/**
 * BIZZ-2265/2266: fetchCompanyPollSnapshot overvåger nu virksomhedens ejerskaber.
 *
 * Verificerer at snapshot'et inkluderer udgående (virksomheder den ejer) + indgående
 * (virksomheds- + person-ejere) relationer som stabile projektioner, så detectChange
 * fyrer en cvr-notifikation når ejerkredsen ændrer sig. Tomt sæt → tomme arrays
 * (stabil hash → ingen falsk alarm).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/app/lib/fetchBbrData', () => ({ fetchBbrForAddress: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from '@/lib/supabase/admin';
import { fetchCompanyPollSnapshot } from '@/app/lib/propertyPollData';

interface Fixtures {
  stamdata: { data: Record<string, unknown> | null; error: unknown };
  udg: unknown[]; // cvr_virksomhed_ejerskab WHERE ejer_cvr = cvr
  indgVirk: unknown[]; // cvr_virksomhed_ejerskab WHERE ejet_cvr = cvr
  indgPers: unknown[]; // cvr_deltagerrelation register
}

function makeAdmin(f: Fixtures) {
  return {
    from: (table: string) => {
      const eqs: Record<string, unknown> = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          eqs[col] = val;
          return b;
        },
        is: () => b,
        not: () => b,
        order: () => b,
        limit: () => b,
        maybeSingle: async () => f.stamdata,
        then: (res: (v: unknown) => unknown) => {
          let data: unknown[] = [];
          if (table === 'cvr_virksomhed_ejerskab') data = eqs.ejer_cvr ? f.udg : f.indgVirk;
          else if (table === 'cvr_deltagerrelation') data = f.indgPers;
          return Promise.resolve({ data, error: null }).then(res);
        },
      };
      return b;
    },
  };
}

const mockAdmin = createAdminClient as ReturnType<typeof vi.fn>;
beforeEach(() => vi.clearAllMocks());

describe('BIZZ-2265/2266 fetchCompanyPollSnapshot ejerskaber', () => {
  it('inkluderer udgående + indgående ejerskaber som stabile projektioner', async () => {
    mockAdmin.mockReturnValue(
      makeAdmin({
        stamdata: { data: { navn: 'Holding A/S', status: 'NORMAL' }, error: null },
        udg: [
          { ejet_cvr: '20000002', ejerandel_pct: 100 },
          { ejet_cvr: '10000001', ejerandel_pct: 50 },
        ],
        indgVirk: [{ ejer_cvr: '30000003', ejerandel_pct: 100 }],
        indgPers: [{ deltager_enhedsnummer: '4000000001', ejerandel_pct: 25 }],
      })
    );
    const snap = await fetchCompanyPollSnapshot('12345678');
    expect(snap).not.toBeNull();
    const m = snap!.monitored;
    expect(m.navn).toBe('Holding A/S');
    // Udgående (BIZZ-2265) — "ejet_cvr:andel"
    expect(m.ejer_af).toEqual(['20000002:100', '10000001:50']);
    // Indgående virksomheds-ejere (BIZZ-2266)
    expect(m.ejet_af_virksomheder).toEqual(['30000003:100']);
    // Indgående person-ejere (BIZZ-2266)
    expect(m.ejet_af_personer).toEqual(['4000000001:25']);
  });

  it('tomme ejerskaber → tomme arrays (stabil hash, ingen falsk alarm)', async () => {
    mockAdmin.mockReturnValue(
      makeAdmin({
        stamdata: { data: { navn: 'Enkeltmand', status: 'NORMAL' }, error: null },
        udg: [],
        indgVirk: [],
        indgPers: [],
      })
    );
    const snap = await fetchCompanyPollSnapshot('99999999');
    expect(snap!.monitored.ejer_af).toEqual([]);
    expect(snap!.monitored.ejet_af_virksomheder).toEqual([]);
    expect(snap!.monitored.ejet_af_personer).toEqual([]);
  });

  it('returnerer null når virksomheden ikke findes', async () => {
    mockAdmin.mockReturnValue(
      makeAdmin({ stamdata: { data: null, error: null }, udg: [], indgVirk: [], indgPers: [] })
    );
    expect(await fetchCompanyPollSnapshot('00000000')).toBeNull();
  });

  it('projektion inkluderer ejerandel så ændret andel fanges (BIZZ-2266)', async () => {
    mockAdmin.mockReturnValue(
      makeAdmin({
        stamdata: { data: { navn: 'X' }, error: null },
        udg: [],
        indgVirk: [{ ejer_cvr: '30000003', ejerandel_pct: 66 }],
        indgPers: [],
      })
    );
    const snap = await fetchCompanyPollSnapshot('12345678');
    // andel indgår i strengen → en andels-ændring giver anden hash
    expect(snap!.monitored.ejet_af_virksomheder).toEqual(['30000003:66']);
  });
});
