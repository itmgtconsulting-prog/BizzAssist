/**
 * Unit tests for personFilterSchema (BIZZ-823 / BIZZ-790b).
 */
import { describe, it, expect } from 'vitest';
import {
  buildPersonFilterSchemas,
  narrowPersonFilters,
  matchPersonFilter,
  type FilterablePerson,
} from '@/app/lib/search/personFilterSchema';

describe('buildPersonFilterSchemas', () => {
  it('returnerer 4 filtre i korrekt rækkefølge', () => {
    const schemas = buildPersonFilterSchemas('da', []);
    expect(schemas).toHaveLength(4);
    expect(schemas[0].key).toBe('rolle');
    expect(schemas[1].key).toBe('rollestatus');
    expect(schemas[2].key).toBe('antalAktiveSelskaber');
    expect(schemas[3].key).toBe('kommune');
  });

  it('rollestatus default er aktive', () => {
    const schemas = buildPersonFilterSchemas('da', []);
    const rs = schemas.find((s) => s.key === 'rollestatus');
    if (rs?.type !== 'dropdown') throw new Error('expected dropdown');
    expect(rs.default).toBe('aktive');
  });
});

describe('matchPersonFilter', () => {
  const base: FilterablePerson = {
    isAktiv: true,
    antalAktiveSelskaber: 3,
    roleTyper: ['direktør', 'ejer'],
    adresse: { kommunenavn: 'København' },
  };

  it('rolle overlap: match når mindst én valgt rolle findes på person', () => {
    expect(matchPersonFilter(base, { rolle: ['direktør'] })).toBe(true);
    expect(matchPersonFilter(base, { rolle: ['ejer', 'stifter'] })).toBe(true);
    expect(matchPersonFilter(base, { rolle: ['stifter'] })).toBe(false);
  });

  it('rollestatus=aktive udelukker inaktive', () => {
    const inaktiv: FilterablePerson = { ...base, isAktiv: false };
    expect(matchPersonFilter(inaktiv, { rollestatus: 'aktive' })).toBe(false);
    expect(matchPersonFilter(inaktiv, { rollestatus: 'alle' })).toBe(true);
    expect(matchPersonFilter(inaktiv, { rollestatus: 'ophoerte' })).toBe(true);
  });

  it('antalAktiveSelskaber range honoreres', () => {
    expect(matchPersonFilter(base, { antalAktiveSelskaber: { min: 2, max: 5 } })).toBe(true);
    expect(matchPersonFilter(base, { antalAktiveSelskaber: { min: 5 } })).toBe(false);
    expect(matchPersonFilter(base, { antalAktiveSelskaber: { max: 2 } })).toBe(false);
  });

  it('kommune multi-select honoreres', () => {
    expect(matchPersonFilter(base, { kommune: ['København'] })).toBe(true);
    expect(matchPersonFilter(base, { kommune: ['Aarhus'] })).toBe(false);
  });

  it('null-felter passer gennem (ingen ekskludering)', () => {
    const sparse: FilterablePerson = { isAktiv: null };
    expect(matchPersonFilter(sparse, { antalAktiveSelskaber: { min: 5 } })).toBe(true);
  });
});

describe('narrowPersonFilters', () => {
  it('parser range-shapes og arrays korrekt', () => {
    const raw = {
      rolle: ['direktør'],
      rollestatus: 'aktive',
      antalAktiveSelskaber: { min: 2 },
      kommune: ['København', 'Aarhus'],
    };
    const narrow = narrowPersonFilters(raw);
    expect(narrow.rolle).toEqual(['direktør']);
    expect(narrow.rollestatus).toBe('aktive');
    expect(narrow.antalAktiveSelskaber).toEqual({ min: 2 });
    expect(narrow.kommune).toEqual(['København', 'Aarhus']);
  });

  it('dropper ikke-arrays/non-strings til undefined', () => {
    const raw = { rolle: 'not-an-array', antalAktiveSelskaber: 'not-a-range' };
    const narrow = narrowPersonFilters(raw);
    expect(narrow.rolle).toBeUndefined();
    expect(narrow.antalAktiveSelskaber).toBeUndefined();
  });
});
