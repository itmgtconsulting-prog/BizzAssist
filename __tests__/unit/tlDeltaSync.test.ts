/**
 * Unit-tests for BIZZ-650 Tinglysning delta-sync pure functions.
 *
 * Tester computeWindow (rolling window beregning) og extractUniqueBfes
 * (dedup af BFE'er fra Tinglysning aendringer response). Cron-routens
 * imperativt IO (fetch/upsert) testes via integration/e2e i separate suite.
 */

import { describe, it, expect } from 'vitest';
import { computeWindow, extractUniqueBfes } from '@/app/api/cron/pull-tinglysning-aendringer/route';

describe('computeWindow — BIZZ-650 rolling window', () => {
  it('returns YYYY-MM-DD strings for both dates', () => {
    const now = new Date('2026-04-21T12:34:56Z');
    const { datoFra, datoTil } = computeWindow(now, 5);
    expect(datoFra).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(datoTil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('datoTil is current date', () => {
    const now = new Date('2026-04-21T12:34:56Z');
    const { datoTil } = computeWindow(now, 5);
    expect(datoTil).toBe('2026-04-21');
  });

  it('datoFra is exactly N days before datoTil', () => {
    const now = new Date('2026-04-21T12:34:56Z');
    const { datoFra } = computeWindow(now, 5);
    expect(datoFra).toBe('2026-04-16');
  });

  it('handles window spanning month boundary', () => {
    const now = new Date('2026-05-02T00:00:00Z');
    const { datoFra, datoTil } = computeWindow(now, 5);
    expect(datoFra).toBe('2026-04-27');
    expect(datoTil).toBe('2026-05-02');
  });

  it('handles window spanning year boundary', () => {
    const now = new Date('2026-01-03T12:00:00Z');
    const { datoFra, datoTil } = computeWindow(now, 5);
    expect(datoFra).toBe('2025-12-29');
    expect(datoTil).toBe('2026-01-03');
  });

  it('window of 1 day returns yesterday → today', () => {
    const now = new Date('2026-04-21T00:00:00Z');
    const { datoFra, datoTil } = computeWindow(now, 1);
    expect(datoFra).toBe('2026-04-20');
    expect(datoTil).toBe('2026-04-21');
  });

  it('window of 30 days returns ~1 month back', () => {
    const now = new Date('2026-04-21T00:00:00Z');
    const { datoFra } = computeWindow(now, 30);
    expect(datoFra).toBe('2026-03-22');
  });
});

describe('extractUniqueBfes — Tinglysning aendringer response', () => {
  it('returns empty array for empty input', () => {
    expect(extractUniqueBfes([])).toEqual([]);
  });

  it('extracts BFE-numre as numbers', () => {
    const items = [
      { EjendomIdentifikator: { BestemtFastEjendomNummer: '123456' } },
      { EjendomIdentifikator: { BestemtFastEjendomNummer: '789012' } },
    ];
    const result = extractUniqueBfes(items);
    expect(result).toEqual(expect.arrayContaining([123456, 789012]));
    expect(result).toHaveLength(2);
  });

  it('deduplicates repeated BFE-numre (same BFE changed multiple times in window)', () => {
    const items = [
      { EjendomIdentifikator: { BestemtFastEjendomNummer: '100' } },
      { EjendomIdentifikator: { BestemtFastEjendomNummer: '200' } },
      { EjendomIdentifikator: { BestemtFastEjendomNummer: '100' } },
      { EjendomIdentifikator: { BestemtFastEjendomNummer: '100' } },
    ];
    const result = extractUniqueBfes(items);
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining([100, 200]));
  });

  it('skips items without EjendomIdentifikator', () => {
    const items = [
      { EjendomIdentifikator: { BestemtFastEjendomNummer: '500' } },
      { AendringsDato: '2026-04-21' }, // no EjendomIdentifikator
      {}, // empty
    ];
    const result = extractUniqueBfes(items);
    expect(result).toEqual([500]);
  });

  it('skips items with non-numeric BFE', () => {
    const items = [
      { EjendomIdentifikator: { BestemtFastEjendomNummer: 'abc' } },
      { EjendomIdentifikator: { BestemtFastEjendomNummer: '42' } },
    ];
    expect(extractUniqueBfes(items)).toEqual([42]);
  });

  it('skips items with empty BFE string', () => {
    const items = [
      { EjendomIdentifikator: { BestemtFastEjendomNummer: '' } },
      { EjendomIdentifikator: { BestemtFastEjendomNummer: '77' } },
    ];
    expect(extractUniqueBfes(items)).toEqual([77]);
  });

  it('skips zero or negative BFE values', () => {
    const items = [
      { EjendomIdentifikator: { BestemtFastEjendomNummer: '0' } },
      { EjendomIdentifikator: { BestemtFastEjendomNummer: '-1' } },
      { EjendomIdentifikator: { BestemtFastEjendomNummer: '100' } },
    ];
    expect(extractUniqueBfes(items)).toEqual([100]);
  });
});
