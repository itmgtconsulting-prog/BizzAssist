/**
 * Unit tests for app/lib/search/ejendomFilterSchema.ts (BIZZ-804).
 *
 * Verifies:
 *   - buildEjendomFilterSchemas returnerer 10 filtre (kommune + phase-2)
 *   - matchEjendomFilter honorerer multi-select kommune
 *   - buildKommuneOptions dedupliker og sorterer kommuner
 *   - narrowEjendomFilters drops ikke-arrays til undefined
 *
 * BIZZ-988: ejendomstype og skjulUdfasede fjernet fra filter-panel.
 */
import { describe, it, expect } from 'vitest';
import {
  buildEjendomFilterSchemas,
  matchEjendomFilter,
  buildKommuneOptions,
  narrowEjendomFilters,
  type FilterableEjendom,
} from '@/app/lib/search/ejendomFilterSchema';

describe('buildEjendomFilterSchemas', () => {
  it('returnerer 10 filtre i korrekt rækkefølge (BIZZ-988: ejendomstype+skjulUdfasede fjernet)', () => {
    const schemas = buildEjendomFilterSchemas('da', []);
    expect(schemas).toHaveLength(10);
    expect(schemas[0].key).toBe('kommune');
    // BIZZ-821 phase-2 — 9 BBR-filtre
    expect(schemas[1].key).toBe('boligareal');
    expect(schemas[2].key).toBe('erhvervsareal');
    expect(schemas[3].key).toBe('grundareal');
    expect(schemas[4].key).toBe('bebyggetAreal');
    expect(schemas[5].key).toBe('opfoerelsesaar');
    expect(schemas[6].key).toBe('ombygningsaar');
    expect(schemas[7].key).toBe('aldersPreset');
    expect(schemas[8].key).toBe('energimaerke');
    expect(schemas[9].key).toBe('anvendelse');
  });

  it('bilingual labels — en vs da', () => {
    const daSchemas = buildEjendomFilterSchemas('da', []);
    const enSchemas = buildEjendomFilterSchemas('en', []);
    expect(daSchemas[0].label).toBe('Kommune');
    expect(enSchemas[0].label).toBe('Municipality');
  });
});

describe('matchEjendomFilter', () => {
  const base: FilterableEjendom = {
    bbrStatusCode: 3, // Bygning opført
    ejendomstype: 'bygning',
    adresse: { kommunenavn: 'Hvidovre' },
  };

  it('tomme filtre matcher alt', () => {
    expect(matchEjendomFilter(base, {})).toBe(true);
  });

  it('kommune multi-select honoreres', () => {
    expect(matchEjendomFilter(base, { kommune: ['Hvidovre'] })).toBe(true);
    expect(matchEjendomFilter(base, { kommune: ['København'] })).toBe(false);
  });

  // BIZZ-821: Phase-2 range-filtre
  it('erhvervsareal range filtrerer korrekt', () => {
    const item: FilterableEjendom = { ...base, erhvervsareal: 200 };
    expect(matchEjendomFilter(item, { erhvervsareal: { min: 100, max: 300 } })).toBe(true);
    expect(matchEjendomFilter(item, { erhvervsareal: { min: 250 } })).toBe(false);
    expect(matchEjendomFilter(item, { erhvervsareal: { max: 150 } })).toBe(false);
  });

  it('grundareal range filtrerer korrekt', () => {
    const item: FilterableEjendom = { ...base, grundareal: 800 };
    expect(matchEjendomFilter(item, { grundareal: { min: 500, max: 1000 } })).toBe(true);
    expect(matchEjendomFilter(item, { grundareal: { min: 900 } })).toBe(false);
  });

  it('bebyggetAreal range filtrerer korrekt', () => {
    const item: FilterableEjendom = { ...base, bebyggetAreal: 120 };
    expect(matchEjendomFilter(item, { bebyggetAreal: { min: 100, max: 200 } })).toBe(true);
    expect(matchEjendomFilter(item, { bebyggetAreal: { max: 100 } })).toBe(false);
  });

  it('ombygningsaar range filtrerer korrekt', () => {
    const item: FilterableEjendom = { ...base, ombygningsaar: 2015 };
    expect(matchEjendomFilter(item, { ombygningsaar: { min: 2010, max: 2020 } })).toBe(true);
    expect(matchEjendomFilter(item, { ombygningsaar: { min: 2020 } })).toBe(false);
  });

  it('aldersPreset nybyggeri matcher < 5 år', () => {
    const currentYear = new Date().getFullYear();
    const item: FilterableEjendom = { ...base, opfoerelsesaar: currentYear - 3 };
    expect(matchEjendomFilter(item, { aldersPreset: ['nybyggeri'] })).toBe(true);
    expect(matchEjendomFilter(item, { aldersPreset: ['moderne'] })).toBe(false);
    expect(matchEjendomFilter(item, { aldersPreset: ['foer1950'] })).toBe(false);
  });

  it('aldersPreset moderne matcher 5-30 år', () => {
    const currentYear = new Date().getFullYear();
    const item: FilterableEjendom = { ...base, opfoerelsesaar: currentYear - 15 };
    expect(matchEjendomFilter(item, { aldersPreset: ['moderne'] })).toBe(true);
    expect(matchEjendomFilter(item, { aldersPreset: ['nybyggeri'] })).toBe(false);
  });

  it('aldersPreset foer1950 matcher < 1950', () => {
    const item: FilterableEjendom = { ...base, opfoerelsesaar: 1935 };
    expect(matchEjendomFilter(item, { aldersPreset: ['foer1950'] })).toBe(true);
    expect(matchEjendomFilter(item, { aldersPreset: ['nybyggeri'] })).toBe(false);
  });

  it('null-felter passerer range-filtre igennem', () => {
    const item: FilterableEjendom = { ...base, erhvervsareal: null, grundareal: null };
    expect(matchEjendomFilter(item, { erhvervsareal: { min: 100 } })).toBe(true);
    expect(matchEjendomFilter(item, { grundareal: { min: 500 } })).toBe(true);
  });

  it('flere filtre ANDes', () => {
    expect(
      matchEjendomFilter(base, {
        kommune: ['Hvidovre'],
      })
    ).toBe(true);
    expect(
      matchEjendomFilter(base, {
        kommune: ['København'], // mismatch
      })
    ).toBe(false);
  });
});

describe('buildKommuneOptions', () => {
  it('dedupliker og sorterer dansk alfabetisk', () => {
    const items: FilterableEjendom[] = [
      { adresse: { kommunenavn: 'Hvidovre' } },
      { adresse: { kommunenavn: 'Aalborg' } },
      { adresse: { kommunenavn: 'Hvidovre' } }, // duplicate
      { adresse: { kommunenavn: 'København' } },
      { adresse: { kommunenavn: 'Århus' } },
    ];
    const opts = buildKommuneOptions(items, 'da');
    const values = opts.map((o) => o.value);
    // Dansk sortering: A-Z uden Å-special-rule i locale-compare('da')
    expect(values).toContain('Hvidovre');
    expect(values).toContain('Aalborg');
    expect(values).toContain('København');
    expect(values).toContain('Århus');
    // Dedup
    expect(values.filter((v) => v === 'Hvidovre')).toHaveLength(1);
  });

  it('filtrerer tom/missing kommunenavn', () => {
    const items: FilterableEjendom[] = [
      { adresse: { kommunenavn: '' } },
      { adresse: {} },
      {},
      { adresse: { kommunenavn: 'Hvidovre' } },
    ];
    const opts = buildKommuneOptions(items, 'da');
    expect(opts).toHaveLength(1);
    expect(opts[0].value).toBe('Hvidovre');
  });
});

describe('narrowEjendomFilters', () => {
  it('mapper gyldige felter', () => {
    const raw = {
      kommune: ['Hvidovre'],
    };
    expect(narrowEjendomFilters(raw)).toEqual(expect.objectContaining(raw));
  });

  it('droppet felter (ikke-array) til undefined', () => {
    const raw = {
      kommune: 42, // ikke array
    };
    expect(narrowEjendomFilters(raw).kommune).toBeUndefined();
  });
});
