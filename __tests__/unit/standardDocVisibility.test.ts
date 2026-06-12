/**
 * BIZZ-2106: Tests for visibility-filter af standard_doc_ids i analyse-POST.
 */
import { describe, it, expect } from 'vitest';
import { filterAllowedStandardDocIds } from '@/app/lib/forsikring/standardDocVisibility';

describe('filterAllowedStandardDocIds (BIZZ-2106)', () => {
  it('beholder ids der er synlige for brugeren', () => {
    const { allowed, dropped } = filterAllowedStandardDocIds(['a', 'b'], ['a', 'b', 'c']);
    expect(allowed).toEqual(['a', 'b']);
    expect(dropped).toEqual([]);
  });

  it('dropper fremmede/ukendte ids og bevarer rækkefølgen af tilladte', () => {
    const { allowed, dropped } = filterAllowedStandardDocIds(
      ['fremmed-privat', 'egen', 'opdigtet', 'domain-delt'],
      ['egen', 'domain-delt']
    );
    expect(allowed).toEqual(['egen', 'domain-delt']);
    expect(dropped).toEqual(['fremmed-privat', 'opdigtet']);
  });

  it('deduplikerer gentagne ids i request body', () => {
    const { allowed, dropped } = filterAllowedStandardDocIds(['a', 'a', 'x', 'x'], ['a']);
    expect(allowed).toEqual(['a']);
    expect(dropped).toEqual(['x']);
  });

  it('tom request giver tomme lister', () => {
    const { allowed, dropped } = filterAllowedStandardDocIds([], ['a']);
    expect(allowed).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('ingen synlige ids dropper alt', () => {
    const { allowed, dropped } = filterAllowedStandardDocIds(['a', 'b'], []);
    expect(allowed).toEqual([]);
    expect(dropped).toEqual(['a', 'b']);
  });
});
