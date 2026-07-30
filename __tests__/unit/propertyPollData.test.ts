/**
 * Unit tests for app/lib/propertyPollData.ts — service-role datakilder til
 * poll-properties (BIZZ-2194).
 *
 * Covers:
 *   - fetchBbrPollSnapshot: opløser BFE fra ejendomsrelationer + bygger stabil
 *     (sorteret) BBR-projektion
 *   - fetchBbrPollSnapshot: returnerer null når fetchBbrForAddress kaster
 *   - fetchOwnershipPollSnapshot: læser gældende ejere fra ejf_ejerskab og
 *     sorterer dem deterministisk
 *   - fetchOwnershipPollSnapshot: returnerer null ved DB-fejl
 *
 * fetchBbrForAddress og admin-klienten er mocket — ingen rigtige kald.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/app/lib/fetchBbrData', () => ({
  fetchBbrForAddress: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(),
}));

import { fetchBbrPollSnapshot, fetchOwnershipPollSnapshot } from '@/app/lib/propertyPollData';
import { fetchBbrForAddress } from '@/app/lib/fetchBbrData';
import { createAdminClient } from '@/lib/supabase/admin';

/** Thenable query-builder mock for admin.from('ejf_ejerskab').select().eq().eq() */
function ownBuilder(result: { data: unknown; error: unknown }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {
    select: () => b,
    eq: () => b,
    then: (res: (v: unknown) => unknown) => Promise.resolve(result).then(res),
  };
  return b;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchBbrPollSnapshot', () => {
  it('resolves BFE from ejendomsrelationer and builds a sorted bygninger projection', async () => {
    (fetchBbrForAddress as ReturnType<typeof vi.fn>).mockResolvedValue({
      ejendomsrelationer: [{ bfeNummer: 555001 }],
      ejerlejlighedBfe: null,
      moderBfe: null,
      bbr: [
        {
          id: 'b2',
          opfoerelsesaar: 1990,
          samletBygningsareal: 120,
          antalEtager: 2,
          anvendelse: '120',
        },
        {
          id: 'b1',
          opfoerelsesaar: 1975,
          samletBygningsareal: 80,
          antalEtager: 1,
          anvendelse: '110',
        },
      ],
    });

    const snap = await fetchBbrPollSnapshot('dawa-uuid');

    expect(snap).not.toBeNull();
    expect(snap!.bfe).toBe(555001);
    const bygninger = snap!.monitored.bygninger as Array<{ id: string }>;
    // Sorteret på id → b1 før b2 (deterministisk hash)
    expect(bygninger.map((b) => b.id)).toEqual(['b1', 'b2']);
  });

  it('falls back to ejerlejlighedBfe when ejendomsrelationer has no BFE', async () => {
    (fetchBbrForAddress as ReturnType<typeof vi.fn>).mockResolvedValue({
      ejendomsrelationer: [],
      ejerlejlighedBfe: 999,
      moderBfe: 111,
      bbr: [],
    });

    const snap = await fetchBbrPollSnapshot('dawa-uuid');
    expect(snap!.bfe).toBe(999);
  });

  it('returns null when fetchBbrForAddress throws', async () => {
    (fetchBbrForAddress as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DAF down'));
    const snap = await fetchBbrPollSnapshot('dawa-uuid');
    expect(snap).toBeNull();
  });
});

describe('fetchOwnershipPollSnapshot', () => {
  it('reads gældende owners from ejf_ejerskab and sorts them deterministically', async () => {
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue({
      from: () =>
        ownBuilder({
          data: [
            {
              ejer_navn: 'Zeta ApS',
              ejer_cvr: '99',
              ejer_type: 'selskab',
              ejerandel_taeller: 1,
              ejerandel_naevner: 2,
            },
            {
              ejer_navn: 'Alfa Jensen',
              ejer_cvr: null,
              ejer_type: 'person',
              ejerandel_taeller: 1,
              ejerandel_naevner: 2,
            },
          ],
          error: null,
        }),
    });

    const snap = await fetchOwnershipPollSnapshot(555001);

    expect(snap).not.toBeNull();
    expect(snap!.ejere).toHaveLength(2);
    // Deterministisk sortering (uafhængig af DB-rækkefølge)
    const names = snap!.ejere.map((e) => e.navn);
    expect(names).toEqual([...names].sort((a, b) => String(a).localeCompare(String(b)) || 0));
    expect(snap!.ejere[0]).toHaveProperty('cvr');
    expect(snap!.ejere[0]).toHaveProperty('taeller');
  });

  it('returns null on DB error', async () => {
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue({
      from: () => ownBuilder({ data: null, error: { message: 'boom' } }),
    });

    const snap = await fetchOwnershipPollSnapshot(555001);
    expect(snap).toBeNull();
  });
});
