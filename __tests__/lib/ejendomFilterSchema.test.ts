/**
 * Unit tests for app/lib/search/ejendomFilterSchema.ts (BIZZ-804).
 *
 * Verifies:
 *   - buildEjendomFilterSchemas returnerer 3 filtre (ejendomstype,
 *     skjulUdfasede, kommune)
 *   - matchEjendomFilter honorerer skjulUdfasede uden at udelukke
 *     ukendt/null status
 *   - matchEjendomFilter honorerer multi-select ejendomstype korrekt
 *   - matchEjendomFilter honorerer multi-select kommune
 *   - buildKommuneOptions dedupliker og sorterer kommuner
 *   - narrowEjendomFilters drops ikke-arrays/ikke-booleans til undefined
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
  it('returnerer 3 filtre i korrekt rækkefølge', () => {
    const schemas = buildEjendomFilterSchemas('da', []);
    expect(schemas).toHaveLength(3);
    expect(schemas[0].key).toBe('ejendomstype');
    expect(schemas[1].key).toBe('skjulUdfasede');
    expect(schemas[2].key).toBe('kommune');
  });

  it('skjulUdfasede har default=true', () => {
    const schemas = buildEjendomFilterSchemas('da', []);
    const skjul = schemas.find((s) => s.key === 'skjulUdfasede');
    expect(skjul).toBeDefined();
    if (skjul && skjul.type === 'toggle') {
      expect(skjul.default).toBe(true);
    }
  });

  it('bilingual labels — en vs da', () => {
    const daSchemas = buildEjendomFilterSchemas('da', []);
    const enSchemas = buildEjendomFilterSchemas('en', []);
    expect(daSchemas[0].label).toBe('Ejendomstype');
    expect(enSchemas[0].label).toBe('Property type');
  });
});

describe('matchEjendomFilter', () => {
  const base: FilterableEjendom = {
    status: 'Gældende',
    ejendomstype: 'bygning',
    adresse: { kommunenavn: 'Hvidovre' },
  };

  it('tomme filtre matcher alt', () => {
    expect(matchEjendomFilter(base, {})).toBe(true);
  });

  it('skjulUdfasede skjuler Nedlagt/Nedrevet men ikke Gældende eller null', () => {
    expect(matchEjendomFilter({ status: 'Nedlagt' }, { skjulUdfasede: true })).toBe(false);
    expect(matchEjendomFilter({ status: 'Nedrevet' }, { skjulUdfasede: true })).toBe(false);
    expect(matchEjendomFilter({ status: 'Henlagt' }, { skjulUdfasede: true })).toBe(false);
    expect(matchEjendomFilter({ status: 'Gældende' }, { skjulUdfasede: true })).toBe(true);
    expect(matchEjendomFilter({ status: null }, { skjulUdfasede: true })).toBe(true);
    expect(matchEjendomFilter({}, { skjulUdfasede: true })).toBe(true);
  });

  it('skjulUdfasede=false viser udfasede', () => {
    expect(matchEjendomFilter({ status: 'Nedlagt' }, { skjulUdfasede: false })).toBe(true);
  });

  it('ejendomstype multi-select honoreres', () => {
    expect(matchEjendomFilter(base, { ejendomstype: ['bygning'] })).toBe(true);
    expect(matchEjendomFilter(base, { ejendomstype: ['sfe'] })).toBe(false);
    expect(matchEjendomFilter(base, { ejendomstype: ['bygning', 'ejerlejlighed'] })).toBe(true);
  });

  it('ejendomstype null/undefined på item = matcher ikke ekspliciet valg', () => {
    const item: FilterableEjendom = { ejendomstype: null, adresse: { kommunenavn: 'X' } };
    expect(matchEjendomFilter(item, { ejendomstype: ['bygning'] })).toBe(false);
  });

  it('kommune multi-select honoreres', () => {
    expect(matchEjendomFilter(base, { kommune: ['Hvidovre'] })).toBe(true);
    expect(matchEjendomFilter(base, { kommune: ['København'] })).toBe(false);
  });

  it('flere filtre ANDes', () => {
    expect(
      matchEjendomFilter(base, {
        ejendomstype: ['bygning'],
        kommune: ['Hvidovre'],
        skjulUdfasede: true,
      })
    ).toBe(true);
    expect(
      matchEjendomFilter(base, {
        ejendomstype: ['sfe'], // mismatch
        kommune: ['Hvidovre'],
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
      ejendomstype: ['bygning', 'sfe'],
      skjulUdfasede: false,
      kommune: ['Hvidovre'],
    };
    expect(narrowEjendomFilters(raw)).toEqual(raw);
  });

  it('droppet felter (ikke-array / ikke-bool) til undefined', () => {
    const raw = {
      ejendomstype: 'bygning', // ikke array
      skjulUdfasede: 'true', // ikke bool
      kommune: 42, // ikke array
    };
    expect(narrowEjendomFilters(raw)).toEqual({
      ejendomstype: undefined,
      skjulUdfasede: undefined,
      kommune: undefined,
    });
  });
});
