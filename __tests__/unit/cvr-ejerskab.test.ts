/**
 * Unit tests for CVR og Ejerskab API route helper functions.
 *
 * Dækker:
 * - parseHusnr: opdeling af "64B" → { nr: 64, bogstav: "B" }
 * - gyldigNu: finder aktiv periode (gyldigTil === null) i tidsbestemte arrays
 * - parseEjertype: klassificerer ejertype ud fra Datafordeler-kode
 */

import { describe, it, expect } from 'vitest';
import { parseHusnr, gyldigNu } from '@/app/api/cvr/route';
import { parseEjertype } from '@/app/api/ejerskab/route';

// ─── parseHusnr ──────────────────────────────────────────────────────────────

describe('parseHusnr', () => {
  it('parser rent husnummer uden bogstav', () => {
    const result = parseHusnr('64');
    expect(result.nr).toBe(64);
    expect(result.bogstav).toBeNull();
  });

  it('parser husnummer med bogstav', () => {
    const result = parseHusnr('64B');
    expect(result.nr).toBe(64);
    expect(result.bogstav).toBe('B');
  });

  it('parser husnummer med mellemrum og bogstav', () => {
    const result = parseHusnr('12 A');
    expect(result.nr).toBe(12);
    expect(result.bogstav).toBe('A');
  });

  it('konverterer bogstav til uppercase', () => {
    expect(parseHusnr('7c').bogstav).toBe('C');
  });

  it('håndterer store numre', () => {
    expect(parseHusnr('999').nr).toBe(999);
  });

  it('returnerer null for ugyldigt format', () => {
    const result = parseHusnr('abc');
    expect(result.nr).toBeNull();
    expect(result.bogstav).toBeNull();
  });

  it('returnerer null for tom streng', () => {
    const result = parseHusnr('');
    expect(result.nr).toBeNull();
    expect(result.bogstav).toBeNull();
  });

  it('håndterer danske bogstaver', () => {
    const result = parseHusnr('8Æ');
    expect(result.nr).toBe(8);
    expect(result.bogstav).toBe('Æ');
  });
});

// ─── gyldigNu ────────────────────────────────────────────────────────────────

describe('gyldigNu', () => {
  type Item = { navn: string; periode?: { gyldigTil?: string | null } };

  it('finder åben periode (gyldigTil === null)', () => {
    const arr: Item[] = [
      { navn: 'Gammelt navn', periode: { gyldigTil: '2020-01-01' } },
      { navn: 'Nuværende navn', periode: { gyldigTil: null } },
    ];
    expect(gyldigNu(arr)?.navn).toBe('Nuværende navn');
  });

  it('finder åben periode når gyldigTil mangler (undefined)', () => {
    const arr: Item[] = [
      { navn: 'Navn', periode: {} }, // gyldigTil undefined ≈ null
    ];
    expect(gyldigNu(arr)?.navn).toBe('Navn');
  });

  it('falder tilbage på sidste element hvis ingen åben periode', () => {
    const arr: Item[] = [
      { navn: 'Navn 1', periode: { gyldigTil: '2019-01-01' } },
      { navn: 'Navn 2', periode: { gyldigTil: '2022-01-01' } },
    ];
    expect(gyldigNu(arr)?.navn).toBe('Navn 2');
  });

  it('returnerer null for tomt array', () => {
    expect(gyldigNu([])).toBeNull();
  });

  it('returnerer null for non-array', () => {
    expect(gyldigNu(null as unknown as [])).toBeNull();
  });

  it('returnerer eneste element i enkelt-element array', () => {
    const arr: Item[] = [{ navn: 'Eneste', periode: { gyldigTil: null } }];
    expect(gyldigNu(arr)?.navn).toBe('Eneste');
  });
});

// ─── parseEjertype ────────────────────────────────────────────────────────────

describe('parseEjertype', () => {
  it('genkender selskab via "S"', () => {
    expect(parseEjertype('S')).toBe('selskab');
  });

  it('genkender selskab via "SELSKAB" (case-insensitiv)', () => {
    expect(parseEjertype('SELSKAB')).toBe('selskab');
    expect(parseEjertype('selskab')).toBe('selskab');
  });

  it('genkender selskab via "K" (kapitalselskab)', () => {
    expect(parseEjertype('K')).toBe('selskab');
  });

  it('genkender person via "P"', () => {
    expect(parseEjertype('P')).toBe('person');
  });

  it('genkender person via "PERSON" (case-insensitiv)', () => {
    expect(parseEjertype('person')).toBe('person');
  });

  it('genkender person via "F" (fysisk person)', () => {
    expect(parseEjertype('F')).toBe('person');
  });

  it('returnerer "ukendt" for undefined', () => {
    expect(parseEjertype(undefined)).toBe('ukendt');
  });

  it('returnerer "ukendt" for ukendt kode', () => {
    expect(parseEjertype('X')).toBe('ukendt');
    expect(parseEjertype('')).toBe('ukendt');
  });
});
