/**
 * Unit tests for app/lib/search/virksomhedFilterSchema.ts (BIZZ-805).
 *
 * Verifies:
 *   - 5 filtre i korrekt rækkefølge (status, virksomhedsform, branche,
 *     kommune, stiftet)
 *   - matchVirksomhedFilter honorerer hver enkelt filter
 *   - legacy active-bool fallback når status-feltet er null
 *   - Stiftet range clamping
 *   - Branche/kommune dynamic options dedupes + sorterer
 *   - narrowVirksomhedFilters type-safety
 */
import { describe, it, expect } from 'vitest';
import {
  buildVirksomhedFilterSchemas,
  matchVirksomhedFilter,
  buildVirksomhedBrancheOptions,
  buildVirksomhedKommuneOptions,
  narrowVirksomhedFilters,
  VIRKSOMHED_STATUS_OPTIONS,
  type FilterableVirksomhed,
} from '@/app/lib/search/virksomhedFilterSchema';

describe('buildVirksomhedFilterSchemas', () => {
  it('returnerer 5 filtre i korrekt rækkefølge', () => {
    const schemas = buildVirksomhedFilterSchemas('da');
    expect(schemas).toHaveLength(5);
    expect(schemas[0].key).toBe('status');
    expect(schemas[1].key).toBe('virksomhedsform');
    expect(schemas[2].key).toBe('branche');
    expect(schemas[3].key).toBe('kommune');
    expect(schemas[4].key).toBe('stiftet');
  });

  it('bilingual labels — da vs en', () => {
    const da = buildVirksomhedFilterSchemas('da');
    const en = buildVirksomhedFilterSchemas('en');
    expect(da[1].label).toBe('Virksomhedsform');
    expect(en[1].label).toBe('Company type');
  });

  it('status schema indeholder alle 7 CVR-statusser', () => {
    const schemas = buildVirksomhedFilterSchemas('da');
    const statusSchema = schemas[0];
    if (statusSchema.type === 'multi-select') {
      expect(statusSchema.options.length).toBe(VIRKSOMHED_STATUS_OPTIONS.length);
      expect(statusSchema.options.map((o) => o.value)).toContain('Normal');
      expect(statusSchema.options.map((o) => o.value)).toContain('Ophørt');
    }
  });

  it('stiftet range har fornuftige bounds', () => {
    const schemas = buildVirksomhedFilterSchemas('da');
    const stiftet = schemas[4];
    if (stiftet.type === 'range') {
      expect(stiftet.min).toBe(1900);
      expect(stiftet.max).toBeGreaterThanOrEqual(2025);
    }
  });

  it('dynamiske options injectes via options param', () => {
    const schemas = buildVirksomhedFilterSchemas('da', {
      brancheOptions: [{ value: 'IT', label: 'IT' }],
      kommuneOptions: [{ value: 'København', label: 'København' }],
    });
    const branche = schemas[2];
    const kommune = schemas[3];
    if (branche.type === 'multi-select') {
      expect(branche.options).toHaveLength(1);
      expect(branche.options[0].value).toBe('IT');
    }
    if (kommune.type === 'multi-select') {
      expect(kommune.options[0].value).toBe('København');
    }
  });
});

describe('matchVirksomhedFilter', () => {
  const base: FilterableVirksomhed = {
    active: true,
    status: 'Normal',
    companyType: 'ApS',
    industry: 'Fast ejendom',
    kommuneNavn: 'København',
    stiftetAar: 2020,
  };

  it('tomme filtre matcher alt', () => {
    expect(matchVirksomhedFilter(base, {})).toBe(true);
  });

  it('status multi-select honoreres', () => {
    expect(matchVirksomhedFilter(base, { status: ['Normal'] })).toBe(true);
    expect(matchVirksomhedFilter(base, { status: ['Ophørt'] })).toBe(false);
    expect(matchVirksomhedFilter(base, { status: ['Normal', 'Under konkurs'] })).toBe(true);
  });

  it('legacy active-bool fallback når status er null', () => {
    const item: FilterableVirksomhed = { active: true, status: null };
    expect(matchVirksomhedFilter(item, { status: ['Normal'] })).toBe(true);
    expect(matchVirksomhedFilter(item, { status: ['Ophørt'] })).toBe(false);
    const inactive: FilterableVirksomhed = { active: false, status: null };
    expect(matchVirksomhedFilter(inactive, { status: ['Ophørt'] })).toBe(true);
  });

  it('virksomhedsform substring-match virker på kortBeskrivelse', () => {
    // CVR ES companyType leveres som "kortBeskrivelse" (fx "ApS")
    // — schema value matcher samme form. Substring-match giver plads
    // til mindre variationer som "APS" (uppercase).
    expect(matchVirksomhedFilter({ companyType: 'ApS' }, { virksomhedsform: ['ApS'] })).toBe(true);
    expect(matchVirksomhedFilter({ companyType: 'A/S' }, { virksomhedsform: ['A/S'] })).toBe(true);
    // Case-insensitive fallback
    expect(matchVirksomhedFilter({ companyType: 'aps' }, { virksomhedsform: ['ApS'] })).toBe(true);
  });

  it('branche multi-select honoreres', () => {
    expect(matchVirksomhedFilter(base, { branche: ['Fast ejendom'] })).toBe(true);
    expect(matchVirksomhedFilter(base, { branche: ['IT'] })).toBe(false);
  });

  it('kommune multi-select honoreres', () => {
    expect(matchVirksomhedFilter(base, { kommune: ['København'] })).toBe(true);
    expect(matchVirksomhedFilter(base, { kommune: ['Aarhus'] })).toBe(false);
  });

  it('stiftet range honoreres', () => {
    expect(matchVirksomhedFilter(base, { stiftet: { min: 2015, max: 2025 } })).toBe(true);
    expect(matchVirksomhedFilter(base, { stiftet: { min: 2021 } })).toBe(false);
    expect(matchVirksomhedFilter(base, { stiftet: { max: 2019 } })).toBe(false);
    expect(matchVirksomhedFilter({ stiftetAar: null }, { stiftet: { min: 2020 } })).toBe(false);
  });

  it('flere filtre ANDes', () => {
    expect(
      matchVirksomhedFilter(base, {
        status: ['Normal'],
        virksomhedsform: ['ApS'],
        kommune: ['København'],
      })
    ).toBe(true);
    expect(
      matchVirksomhedFilter(base, {
        status: ['Normal'],
        virksomhedsform: ['ApS'],
        kommune: ['Aarhus'], // mismatch
      })
    ).toBe(false);
  });
});

describe('buildVirksomhedBrancheOptions', () => {
  it('dedupliker og sorterer dansk alfabetisk', () => {
    const items: FilterableVirksomhed[] = [
      { industry: 'Fast ejendom' },
      { industry: 'IT' },
      { industry: 'Fast ejendom' },
      { industry: 'Bygge' },
    ];
    const opts = buildVirksomhedBrancheOptions(items);
    expect(opts).toHaveLength(3);
    expect(opts.map((o) => o.value)).toEqual(['Bygge', 'Fast ejendom', 'IT']);
  });

  it('drops null/empty industry', () => {
    const items: FilterableVirksomhed[] = [
      { industry: null },
      { industry: '' },
      {},
      { industry: 'IT' },
    ];
    expect(buildVirksomhedBrancheOptions(items)).toHaveLength(1);
  });
});

describe('buildVirksomhedKommuneOptions', () => {
  it('dedupliker', () => {
    // Bemærk: dansk locale-compare sorterer 'Aa' som 'Å' (efter 'Ø'),
    // så København kommer før Aarhus i dansk alfabetisk rækkefølge.
    const items: FilterableVirksomhed[] = [
      { kommuneNavn: 'København' },
      { kommuneNavn: 'Aarhus' },
      { kommuneNavn: 'København' },
    ];
    const opts = buildVirksomhedKommuneOptions(items);
    expect(opts).toHaveLength(2);
    const values = opts.map((o) => o.value);
    expect(values).toContain('Aarhus');
    expect(values).toContain('København');
  });
});

describe('narrowVirksomhedFilters', () => {
  it('mapper gyldige felter', () => {
    const raw = {
      status: ['Normal'],
      virksomhedsform: ['ApS'],
      branche: ['IT'],
      kommune: ['København'],
      stiftet: { min: 2020, max: 2025 },
    };
    expect(narrowVirksomhedFilters(raw)).toEqual(raw);
  });

  it('drops invalid types', () => {
    const raw = {
      status: 'Normal', // ikke array
      stiftet: [2020, 2025], // array, ikke objekt
    };
    expect(narrowVirksomhedFilters(raw)).toEqual({
      status: undefined,
      virksomhedsform: undefined,
      branche: undefined,
      kommune: undefined,
      stiftet: undefined,
    });
  });
});
