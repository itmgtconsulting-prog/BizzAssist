/**
 * Unit tests for the kommuner module.
 *
 * Tests the KOMMUNE_NAVN lookup table and kommunenavnFraKode helper.
 * Pure function tests — no mocking required.
 *
 * Covers:
 * - Known commune codes (string with leading zero, string without, number)
 * - Null / undefined inputs
 * - Unknown codes
 * - Edge cases: boundary codes, all 98 kommuner present
 */
import { describe, it, expect } from 'vitest';
import { KOMMUNE_NAVN, kommunenavnFraKode } from '@/app/lib/kommuner';

describe('KOMMUNE_NAVN', () => {
  it('is a non-empty object', () => {
    expect(typeof KOMMUNE_NAVN).toBe('object');
    expect(Object.keys(KOMMUNE_NAVN).length).toBeGreaterThan(0);
  });

  it('contains at least 98 municipalities', () => {
    // Denmark has exactly 98 kommuner — the file also lists Christiansø and
    // two Fanø entries so the count is slightly above 98
    expect(Object.keys(KOMMUNE_NAVN).length).toBeGreaterThanOrEqual(98);
  });

  it('uses 4-digit zero-padded string keys', () => {
    for (const key of Object.keys(KOMMUNE_NAVN)) {
      expect(key).toMatch(/^\d{4}$/);
    }
  });

  it('has non-empty string values for all entries', () => {
    for (const [key, value] of Object.entries(KOMMUNE_NAVN)) {
      expect(typeof value, `KOMMUNE_NAVN['${key}'] should be a string`).toBe('string');
      expect(value.length, `KOMMUNE_NAVN['${key}'] should not be empty`).toBeGreaterThan(0);
    }
  });

  it('contains København (0101)', () => {
    expect(KOMMUNE_NAVN['0101']).toBe('København');
  });

  it('contains Aarhus (0751)', () => {
    expect(KOMMUNE_NAVN['0751']).toBe('Aarhus');
  });

  it('contains Aalborg (0851)', () => {
    expect(KOMMUNE_NAVN['0851']).toBe('Aalborg');
  });

  it('contains Odense (0461)', () => {
    expect(KOMMUNE_NAVN['0461']).toBe('Odense');
  });
});

describe('kommunenavnFraKode', () => {
  // ── Happy path: string with leading zero ────────────────────────────────

  it('looks up København with 4-digit padded string "0101"', () => {
    expect(kommunenavnFraKode('0101')).toBe('København');
  });

  it('looks up Frederiksberg with "0147"', () => {
    expect(kommunenavnFraKode('0147')).toBe('Frederiksberg');
  });

  it('looks up Aarhus with "0751"', () => {
    expect(kommunenavnFraKode('0751')).toBe('Aarhus');
  });

  it('looks up Aalborg with "0851"', () => {
    expect(kommunenavnFraKode('0851')).toBe('Aalborg');
  });

  it('looks up Odense with "0461"', () => {
    expect(kommunenavnFraKode('0461')).toBe('Odense');
  });

  it('looks up Hjørring with "0860"', () => {
    expect(kommunenavnFraKode('0860')).toBe('Hjørring');
  });

  it('looks up Bornholm with "0400"', () => {
    expect(kommunenavnFraKode('0400')).toBe('Bornholm');
  });

  // ── Happy path: string without leading zero (should be padded) ──────────

  it('accepts "101" without leading zero and returns København', () => {
    expect(kommunenavnFraKode('101')).toBe('København');
  });

  it('accepts "751" without leading zero and returns Aarhus', () => {
    expect(kommunenavnFraKode('751')).toBe('Aarhus');
  });

  it('accepts single-digit-like short string "400" and returns Bornholm', () => {
    expect(kommunenavnFraKode('400')).toBe('Bornholm');
  });

  // ── Happy path: numeric input ───────────────────────────────────────────

  it('accepts number 101 and returns København', () => {
    expect(kommunenavnFraKode(101)).toBe('København');
  });

  it('accepts number 751 and returns Aarhus', () => {
    expect(kommunenavnFraKode(751)).toBe('Aarhus');
  });

  it('accepts number 851 and returns Aalborg', () => {
    expect(kommunenavnFraKode(851)).toBe('Aalborg');
  });

  it('accepts number 461 and returns Odense', () => {
    expect(kommunenavnFraKode(461)).toBe('Odense');
  });

  it('accepts number 860 and returns Hjørring', () => {
    expect(kommunenavnFraKode(860)).toBe('Hjørring');
  });

  // ── Null / undefined ────────────────────────────────────────────────────

  it('returns empty string for null input', () => {
    expect(kommunenavnFraKode(null)).toBe('');
  });

  it('returns empty string for undefined input', () => {
    expect(kommunenavnFraKode(undefined)).toBe('');
  });

  // ── Unknown codes ───────────────────────────────────────────────────────

  it('returns empty string for unknown code "9999"', () => {
    expect(kommunenavnFraKode('9999')).toBe('');
  });

  it('returns empty string for unknown code "0000"', () => {
    expect(kommunenavnFraKode('0000')).toBe('');
  });

  it('returns empty string for unknown numeric code 9999', () => {
    expect(kommunenavnFraKode(9999)).toBe('');
  });

  it('returns empty string for unknown code "0001"', () => {
    expect(kommunenavnFraKode('0001')).toBe('');
  });

  // ── Spot-check a selection of all 98+ kommuner ──────────────────────────

  const spotChecks: Array<[string | number, string]> = [
    ['0151', 'Ballerup'],
    ['0153', 'Brøndby'],
    ['0155', 'Dragør'],
    ['0159', 'Gladsaxe'],
    ['0169', 'Høje-Taastrup'],
    ['0173', 'Lyngby-Taarbæk'],
    ['0219', 'Hillerød'],
    ['0265', 'Roskilde'],
    ['0326', 'Kalundborg'],
    ['0360', 'Lolland'],
    ['0510', 'Haderslev'],
    ['0540', 'Sønderborg'],
    ['0561', 'Esbjerg'],
    ['0607', 'Fredericia'],
    ['0615', 'Horsens'],
    ['0621', 'Kolding'],
    ['0630', 'Vejle'],
    ['0657', 'Herning'],
    ['0706', 'Syddjurs'],
    ['0730', 'Randers'],
    ['0740', 'Silkeborg'],
    ['0746', 'Skanderborg'],
    ['0756', 'Ikast-Brande'],
    ['0760', 'Ringkøbing-Skjern'],
    ['0791', 'Viborg'],
    ['0810', 'Brønderslev'],
    ['0813', 'Frederikshavn'],
    ['0851', 'Aalborg'],
  ];

  it.each(spotChecks)('kommunenavnFraKode("%s") returns "%s"', (kode, expected) => {
    expect(kommunenavnFraKode(kode)).toBe(expected);
  });

  it('every entry in KOMMUNE_NAVN is reachable via kommunenavnFraKode', () => {
    for (const [kode, navn] of Object.entries(KOMMUNE_NAVN)) {
      expect(kommunenavnFraKode(kode)).toBe(navn);
    }
  });
});
