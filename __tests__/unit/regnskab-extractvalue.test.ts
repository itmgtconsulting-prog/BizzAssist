/**
 * BIZZ-1944: Tests for extractValue scale/sign/unit handling.
 *
 * Verificerer at XBRL-parseren:
 *  1. Stoler på den eksplicitte iXBRL scale-attribut (scale="0" → ×1, ingen
 *     "antag millioner"-gætteheuristik der inflaterede hele-DKK-regnskaber ×10^6).
 *  2. Honorerer sign="-" (det viste tal er en positiv magnitude → tab/negativ
 *     egenkapital skal negeres).
 *  3. Aldrig skalerer ikke-monetære enheder (U-pure, antal ansatte).
 *  4. BIZZ-1956: `decimals` skaleres ALDRIG — det er kun en præcisionsindikator
 *     (XBRL 2.1), ikke en enhed. Elementets indhold er altid hele DKK.
 */

import { describe, it, expect } from 'vitest';
import { extractValue } from '@/app/api/regnskab/xbrl/route';

/** Byg et minimalt iXBRL-dokument med ét nonFraction-element. */
function ix(name: string, value: string, attrs = ''): string {
  return `<ix:nonFraction contextRef="C0" ${attrs} name="fsa:${name}" unitRef="U-iso4217-DKK">${value}</ix:nonFraction>`;
}

describe('extractValue — scale/sign/unit (BIZZ-1944)', () => {
  it('scale="0" giver hele DKK (ingen ×1.000.000-gæt)', () => {
    const xml = ix('Assets', '268,926', 'decimals="0" scale="0"');
    expect(extractValue(xml, ['Assets'])).toBe(268_926);
  });

  it('honorerer sign="-" og negerer værdien', () => {
    const xml = ix('Equity', '4,233,271', 'decimals="0" scale="0" sign="-"');
    expect(extractValue(xml, ['Equity'])).toBe(-4_233_271);
  });

  it('negativt resultat (tab) med sign="-" bliver negativt', () => {
    const xml = ix(
      'ProfitLossFromOrdinaryActivitiesBeforeTax',
      '2,615,430',
      'decimals="0" scale="0" sign="-"'
    );
    expect(extractValue(xml, ['ProfitLossFromOrdinaryActivitiesBeforeTax'])).toBe(-2_615_430);
  });

  it('skalerer IKKE ikke-monetære enheder (antal ansatte, U-pure)', () => {
    const xml = `<ix:nonFraction contextRef="D0" decimals="0" scale="0" name="fsa:AverageNumberOfEmployees" unitRef="U-pure">3</ix:nonFraction>`;
    expect(extractValue(xml, ['AverageNumberOfEmployees'])).toBe(3);
  });

  it('scale="6" multiplicerer med 10^6 (regnskab i millioner)', () => {
    const xml = ix('Revenue', '154', 'decimals="-6" scale="6"');
    expect(extractValue(xml, ['Revenue'])).toBe(154_000_000);
  });

  it('BIZZ-1956: standard XBRL decimals="-3" skaleres IKKE (præcision, ikke enhed)', () => {
    // decimals="-3" betyder "nøjagtig til nærmeste 1.000", IKKE "tal i tusinder".
    // Elementets indhold er allerede hele DKK. (HEARTLAND: ShorttermLiabilities
    // 21.537.870.000 med decimals="-3" = 21,5 mia DKK — ikke 21,5 billioner.)
    const xml = `<fsa:Revenue contextRef="D0" decimals="-3" unitRef="U-iso4217-DKK">21537870000</fsa:Revenue>`;
    expect(extractValue(xml, ['Revenue'])).toBe(21_537_870_000);
  });

  it('BIZZ-1956: standard XBRL decimals="-6" skaleres IKKE (trillion-bug fix)', () => {
    // decimals="-6" inflaterede tidligere værdien ×10^6 → ×1.000 efter T DKK-norm.
    const xml = `<fsa:Assets contextRef="D0" decimals="-6" unitRef="U-iso4217-DKK">60900000000</fsa:Assets>`;
    expect(extractValue(xml, ['Assets'])).toBe(60_900_000_000);
  });

  it('standard XBRL decimals="INF" → hele DKK uændret', () => {
    const xml = `<fsa:Revenue contextRef="D0" decimals="INF" unitRef="U-iso4217-DKK">5154887</fsa:Revenue>`;
    expect(extractValue(xml, ['Revenue'])).toBe(5_154_887);
  });

  it('positivt tal uden sign er uændret positivt', () => {
    const xml = ix('GrossProfitLoss', '1,895,010', 'decimals="0" scale="0"');
    expect(extractValue(xml, ['GrossProfitLoss'])).toBe(1_895_010);
  });

  it('returnerer null når tag ikke findes', () => {
    expect(extractValue('<x/>', ['Assets'])).toBeNull();
  });
});
