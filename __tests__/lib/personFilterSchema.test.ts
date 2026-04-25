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
  it('returnerer 7 filtre i korrekt rækkefølge', () => {
    const schemas = buildPersonFilterSchemas('da', []);
    expect(schemas).toHaveLength(7);
    expect(schemas[0].key).toBe('preset');
    expect(schemas[1].key).toBe('rolle');
    expect(schemas[2].key).toBe('rollestatus');
    expect(schemas[3].key).toBe('antalAktiveSelskaber');
    expect(schemas[4].key).toBe('antalHistoriskeVirksomheder');
    expect(schemas[5].key).toBe('totalAntalRoller');
    expect(schemas[6].key).toBe('kommune');
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
    antalHistoriskeVirksomheder: 5,
    totalAntalRoller: 12,
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

  // BIZZ-823: Nye filtre
  it('antalHistoriskeVirksomheder range honoreres', () => {
    expect(matchPersonFilter(base, { antalHistoriskeVirksomheder: { min: 3, max: 10 } })).toBe(
      true
    );
    expect(matchPersonFilter(base, { antalHistoriskeVirksomheder: { min: 10 } })).toBe(false);
  });

  it('totalAntalRoller range honoreres', () => {
    expect(matchPersonFilter(base, { totalAntalRoller: { min: 10, max: 20 } })).toBe(true);
    expect(matchPersonFilter(base, { totalAntalRoller: { min: 15 } })).toBe(false);
  });

  // BIZZ-823: Preset-tags
  it('preset kunDirektoerer matcher kun direktører', () => {
    expect(matchPersonFilter(base, { preset: ['kunDirektoerer'] })).toBe(true);
    const noDir: FilterablePerson = { ...base, roleTyper: ['stifter'] };
    expect(matchPersonFilter(noDir, { preset: ['kunDirektoerer'] })).toBe(false);
  });

  it('preset serielIvaerksaetter kræver 5+ aktive virksomheder', () => {
    const seriel: FilterablePerson = { ...base, antalAktiveSelskaber: 7 };
    expect(matchPersonFilter(seriel, { preset: ['serielIvaerksaetter'] })).toBe(true);
    expect(matchPersonFilter(base, { preset: ['serielIvaerksaetter'] })).toBe(false);
  });

  it('preset professionelBestyrelse kræver bestyrelsesrolle + 3+ virksomheder', () => {
    const prof: FilterablePerson = {
      ...base,
      roleTyper: ['bestyrelsesmedlem', 'direktør'],
      antalAktiveSelskaber: 4,
    };
    expect(matchPersonFilter(prof, { preset: ['professionelBestyrelse'] })).toBe(true);
    // Har bestyrelsesrolle men kun 2 virksomheder
    const faa: FilterablePerson = {
      ...base,
      roleTyper: ['bestyrelsesmedlem'],
      antalAktiveSelskaber: 2,
    };
    expect(matchPersonFilter(faa, { preset: ['professionelBestyrelse'] })).toBe(false);
  });

  it('preset enkeltvirksomhed kræver præcis 1 aktiv', () => {
    const enkel: FilterablePerson = { ...base, antalAktiveSelskaber: 1 };
    expect(matchPersonFilter(enkel, { preset: ['enkeltvirksomhed'] })).toBe(true);
    expect(matchPersonFilter(base, { preset: ['enkeltvirksomhed'] })).toBe(false);
  });

  it('preset + range kan kombineres', () => {
    const seriel: FilterablePerson = {
      ...base,
      antalAktiveSelskaber: 7,
      totalAntalRoller: 20,
    };
    // Seriel iværksætter + total roller 15-25 = match
    expect(
      matchPersonFilter(seriel, {
        preset: ['serielIvaerksaetter'],
        totalAntalRoller: { min: 15, max: 25 },
      })
    ).toBe(true);
    // Seriel iværksætter + total roller 25-50 = no match
    expect(
      matchPersonFilter(seriel, {
        preset: ['serielIvaerksaetter'],
        totalAntalRoller: { min: 25 },
      })
    ).toBe(false);
  });
});

describe('narrowPersonFilters', () => {
  it('parser range-shapes og arrays korrekt', () => {
    const raw = {
      preset: ['serielIvaerksaetter'],
      rolle: ['direktør'],
      rollestatus: 'aktive',
      antalAktiveSelskaber: { min: 2 },
      antalHistoriskeVirksomheder: { min: 3, max: 10 },
      totalAntalRoller: { max: 50 },
      kommune: ['København', 'Aarhus'],
    };
    const narrow = narrowPersonFilters(raw);
    expect(narrow.preset).toEqual(['serielIvaerksaetter']);
    expect(narrow.rolle).toEqual(['direktør']);
    expect(narrow.rollestatus).toBe('aktive');
    expect(narrow.antalAktiveSelskaber).toEqual({ min: 2 });
    expect(narrow.antalHistoriskeVirksomheder).toEqual({ min: 3, max: 10 });
    expect(narrow.totalAntalRoller).toEqual({ max: 50 });
    expect(narrow.kommune).toEqual(['København', 'Aarhus']);
  });

  it('dropper ikke-arrays/non-strings til undefined', () => {
    const raw = { rolle: 'not-an-array', antalAktiveSelskaber: 'not-a-range' };
    const narrow = narrowPersonFilters(raw);
    expect(narrow.rolle).toBeUndefined();
    expect(narrow.antalAktiveSelskaber).toBeUndefined();
  });
});
