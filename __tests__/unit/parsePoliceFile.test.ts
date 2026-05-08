/**
 * BIZZ-1225: Tests for forsikrings-police CSV parser.
 */

import { describe, it, expect } from 'vitest';
import { parseCsv, normaliserForsikringstype } from '@/app/lib/parsePoliceFile';

describe('normaliserForsikringstype', () => {
  it('mapper husforsikring', () => {
    expect(normaliserForsikringstype('Husforsikring')).toBe('husforsikring');
    expect(normaliserForsikringstype('Ejendomsforsikring')).toBe('husforsikring');
    expect(normaliserForsikringstype('Villaforsikring')).toBe('husforsikring');
  });

  it('mapper bilforsikring', () => {
    expect(normaliserForsikringstype('Bilforsikring')).toBe('bilforsikring');
    expect(normaliserForsikringstype('Motorkøretøj')).toBe('bilforsikring');
    expect(normaliserForsikringstype('Kasko')).toBe('bilforsikring');
  });

  it('mapper bestyrelsesansvar', () => {
    expect(normaliserForsikringstype('D&O forsikring')).toBe('bestyrelsesansvar');
    expect(normaliserForsikringstype('Bestyrelsesansvar')).toBe('bestyrelsesansvar');
  });

  it('mapper ansvarsforsikring (ikke arbejdsskade)', () => {
    expect(normaliserForsikringstype('Ansvarsforsikring')).toBe('ansvarsforsikring');
    expect(normaliserForsikringstype('Erhvervsansvar')).toBe('ansvarsforsikring');
  });

  it('returnerer andet for ukendte typer', () => {
    expect(normaliserForsikringstype('Specialpolice XYZ')).toBe('andet');
  });
});

describe('parseCsv', () => {
  it('parser semikolon-separeret CSV', () => {
    const csv = `Type;Dækning;Selskab;Objekt
Husforsikring;3500000;Alm Brand;Søbyvej 11
Bilforsikring;250000;Tryg;AB12345`;

    const result = parseCsv(csv);

    expect(result.policer).toHaveLength(2);
    expect(result.fejl).toHaveLength(0);
    expect(result.policer[0].type).toBe('husforsikring');
    expect(result.policer[0].daekningssum).toBe(3500000);
    expect(result.policer[0].selskab).toBe('Alm Brand');
    expect(result.policer[1].type).toBe('bilforsikring');
    expect(result.policer[1].objekt).toBe('AB12345');
  });

  it('parser komma-separeret CSV', () => {
    const csv = `forsikringstype,sum,firma
Erhvervsforsikring,1000000,Topdanmark`;

    const result = parseCsv(csv);

    expect(result.policer).toHaveLength(1);
    expect(result.policer[0].type).toBe('erhvervsforsikring');
    expect(result.policer[0].daekningssum).toBe(1000000);
    expect(result.policer[0].selskab).toBe('Topdanmark');
  });

  it('håndterer danske specialtegn i kolonnenavne', () => {
    const csv = `Forsikring;Dækningsbeløb
Indboforsikring;500000`;

    const result = parseCsv(csv);

    expect(result.policer).toHaveLength(1);
    expect(result.policer[0].type).toBe('indboforsikring');
    expect(result.policer[0].daekningssum).toBe(500000);
  });

  it('rapporterer fejl for tomme type-celler', () => {
    const csv = `Type;Sum
;250000
Bilforsikring;100000`;

    const result = parseCsv(csv);

    expect(result.policer).toHaveLength(1);
    expect(result.fejl).toHaveLength(1);
    expect(result.fejl[0].linje).toBe(2);
  });

  it('returnerer fejl ved tom fil', () => {
    const result = parseCsv('');
    expect(result.policer).toHaveLength(0);
    expect(result.fejl).toHaveLength(1);
  });

  it('returnerer fejl ved manglende type-kolonne', () => {
    const csv = `Navn;Beløb
Test;100000`;

    const result = parseCsv(csv);
    expect(result.policer).toHaveLength(0);
    expect(result.fejl[0].besked).toContain('forsikringstype');
  });

  it('håndterer dækningssum med tusind-separator', () => {
    const csv = `Type;Sum
Husforsikring;3.500.000 DKK`;

    const result = parseCsv(csv);
    expect(result.policer[0].daekningssum).toBe(3500000);
  });
});
