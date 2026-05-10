/**
 * BIZZ-1226: Tests for forsikrings-gap-detektionsregler og risiko-scoring.
 */

import { describe, it, expect } from 'vitest';
import { detectGaps, type Aktiv } from '@/app/lib/forsikringGapEngine';
import type { ParsedPolice } from '@/app/lib/parsePoliceFile';

/** Hjælper: opret et minimalt aktiv */
function lagAktiv(overrides: Partial<Aktiv> = {}): Aktiv {
  return {
    id: 'test-1',
    type: 'ejendom',
    label: 'Søbyvej 11',
    vaerdi: 3_500_000,
    adresse: 'Søbyvej 11, 2650 Hvidovre',
    bfe: 2081243,
    cvr: null,
    regnr: null,
    haeftelser: 0,
    risikofaktorer: [],
    byggeaar: null,
    ansatte: null,
    ...overrides,
  };
}

/** Hjælper: opret en minimal police */
function lagPolice(overrides: Partial<ParsedPolice> = {}): ParsedPolice {
  return {
    type: 'husforsikring',
    rawType: 'Husforsikring',
    daekningssum: 3_500_000,
    selskab: 'Alm Brand',
    objekt: 'Søbyvej 11',
    policenummer: null,
    udloebsdato: null,
    linje: 2,
    ...overrides,
  };
}

describe('detectGaps', () => {
  it('returnerer tomt array når alle aktiver er dækket', () => {
    const aktiver = [lagAktiv()];
    const policer = [lagPolice()];
    const gaps = detectGaps(aktiver, policer);
    expect(gaps).toHaveLength(0);
  });

  it('identificerer uforsikret ejendom', () => {
    const aktiver = [lagAktiv()];
    const gaps = detectGaps(aktiver, []);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].gapType).toBe('uforsikret');
    expect(gaps[0].risikoLabel).toBe('hoej');
  });

  it('identificerer underforsikret ejendom (<90%)', () => {
    const aktiver = [lagAktiv({ vaerdi: 5_000_000 })];
    const policer = [lagPolice({ daekningssum: 2_000_000 })]; // 40% dækning
    const gaps = detectGaps(aktiver, policer);
    const underGap = gaps.find((g) => g.gapType === 'underforsikret');
    expect(underGap).toBeDefined();
    expect(underGap!.anbefaletDaekning).toBe(5_000_000);
  });

  it('ignorerer marginal underforsikring (>90%)', () => {
    const aktiver = [lagAktiv({ vaerdi: 3_500_000 })];
    const policer = [lagPolice({ daekningssum: 3_200_000 })]; // 91% dækning
    const gaps = detectGaps(aktiver, policer);
    expect(gaps.filter((g) => g.gapType === 'underforsikret')).toHaveLength(0);
  });

  it('identificerer manglende bestyrelsesansvar', () => {
    const aktiver = [
      lagAktiv({
        id: 'bestyrelse-1',
        type: 'bestyrelsespost',
        label: 'JaJR Holding ApS (Bestyrelsesmedlem)',
        vaerdi: null,
        adresse: null,
      }),
    ];
    const gaps = detectGaps(aktiver, []);
    expect(gaps[0].gapType).toBe('manglende_ansvar');
  });

  it('matcher bil-police via registreringsnummer', () => {
    const aktiver = [
      lagAktiv({
        id: 'bil-1',
        type: 'køretøj',
        label: 'BMW 2024 AB12345',
        vaerdi: null,
        adresse: null,
        regnr: 'AB12345',
      }),
    ];
    const policer = [
      lagPolice({
        type: 'bilforsikring',
        rawType: 'Bilforsikring',
        objekt: 'AB 12345',
      }),
    ];
    const gaps = detectGaps(aktiver, policer);
    expect(gaps.filter((g) => g.gapType === 'uforsikret')).toHaveLength(0);
  });

  it('øger risiko-score for gamle bygninger (asbest-risiko)', () => {
    const aktiver = [lagAktiv({ byggeaar: 1955 })];
    const gaps = detectGaps(aktiver, []);
    // Byggeår < 1960 tilføjer +10 til score
    expect(gaps[0].risikoScore).toBeGreaterThan(60);
  });

  it('sorterer gaps efter risiko-score (højest først)', () => {
    const aktiver = [
      lagAktiv({ id: 'a1', vaerdi: 1_000_000 }),
      lagAktiv({ id: 'a2', vaerdi: 10_000_000, haeftelser: 2, byggeaar: 1950 }),
    ];
    const gaps = detectGaps(aktiver, []);
    expect(gaps[0].risikoScore).toBeGreaterThanOrEqual(gaps[1].risikoScore);
  });

  it('beregner estimeret præmie for uforsikret', () => {
    const aktiver = [lagAktiv({ vaerdi: 5_000_000 })];
    const gaps = detectGaps(aktiver, []);
    expect(gaps[0].estimertPraemie).toBe(10_000); // 5M * 0.2%
  });
});
