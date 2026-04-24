/**
 * BIZZ-831: Unit test for PropertyCard href routing logic.
 *
 * SFE-hits med BFE linker til /dashboard/ejendomme/sfe/[bfe].
 * Alle andre linker til /dashboard/ejendomme/[dawaId].
 */
import { describe, it, expect } from 'vitest';

/**
 * Extracts the href-computation logic from PropertyCard so it can be
 * tested without rendering the full React component.
 */
function computePropertyCardHref(result: {
  ejendomstype?: 'sfe' | 'bygning' | 'ejerlejlighed' | null;
  bfe?: number | null;
  adresse: { id: string };
}): string {
  return result.ejendomstype === 'sfe' && result.bfe
    ? `/dashboard/ejendomme/sfe/${result.bfe}`
    : `/dashboard/ejendomme/${result.adresse.id}`;
}

describe('PropertyCard href routing (BIZZ-831)', () => {
  it('SFE with BFE links to /sfe/[bfe]', () => {
    expect(
      computePropertyCardHref({
        ejendomstype: 'sfe',
        bfe: 2091165,
        adresse: { id: '0a3f50a8-b2e9-32b8-e044-0003ba298018' },
      })
    ).toBe('/dashboard/ejendomme/sfe/2091165');
  });

  it('SFE without BFE falls back to /ejendomme/[dawaId]', () => {
    expect(
      computePropertyCardHref({
        ejendomstype: 'sfe',
        bfe: null,
        adresse: { id: '0a3f50a8-b2e9-32b8-e044-0003ba298018' },
      })
    ).toBe('/dashboard/ejendomme/0a3f50a8-b2e9-32b8-e044-0003ba298018');
  });

  it('SFE with undefined BFE falls back to /ejendomme/[dawaId]', () => {
    expect(
      computePropertyCardHref({
        ejendomstype: 'sfe',
        adresse: { id: '0a3f50a8-b2e9-32b8-e044-0003ba298018' },
      })
    ).toBe('/dashboard/ejendomme/0a3f50a8-b2e9-32b8-e044-0003ba298018');
  });

  it('bygning links to /ejendomme/[dawaId]', () => {
    expect(
      computePropertyCardHref({
        ejendomstype: 'bygning',
        bfe: 12345,
        adresse: { id: 'abc-uuid' },
      })
    ).toBe('/dashboard/ejendomme/abc-uuid');
  });

  it('ejerlejlighed links to /ejendomme/[dawaId]', () => {
    expect(
      computePropertyCardHref({
        ejendomstype: 'ejerlejlighed',
        bfe: 67890,
        adresse: { id: 'def-uuid' },
      })
    ).toBe('/dashboard/ejendomme/def-uuid');
  });

  it('null ejendomstype links to /ejendomme/[dawaId]', () => {
    expect(
      computePropertyCardHref({
        ejendomstype: null,
        adresse: { id: 'ghi-uuid' },
      })
    ).toBe('/dashboard/ejendomme/ghi-uuid');
  });

  it('undefined ejendomstype links to /ejendomme/[dawaId]', () => {
    expect(
      computePropertyCardHref({
        adresse: { id: 'jkl-uuid' },
      })
    ).toBe('/dashboard/ejendomme/jkl-uuid');
  });
});
