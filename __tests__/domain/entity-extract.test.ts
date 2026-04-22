/**
 * BIZZ-716: extractEntities unit tests.
 */
import { describe, it, expect } from 'vitest';
import { extractEntities } from '@/app/lib/domainEntityExtract';

describe('extractEntities — BIZZ-716', () => {
  it('extracts CVR numbers from "CVR 12345678" pattern', () => {
    const r = extractEntities('Sælger: Acme ApS, CVR 12345678. Køber: anden part.');
    expect(r.cvrs).toContain('12345678');
  });

  it('extracts CVR from "CVR-nr: 12345678" pattern', () => {
    const r = extractEntities('CVR-nr: 26316804.');
    expect(r.cvrs).toContain('26316804');
  });

  it('does not treat DDMMYYYY dates as CVRs', () => {
    const r = extractEntities('Overtagelse: 01012026. Dato: 15041999.');
    // Dates should be excluded (DD/MM/YYYY plausible)
    expect(r.cvrs).not.toContain('01012026');
    expect(r.cvrs).not.toContain('15041999');
  });

  it('extracts BFE numbers from "BFE 100165718" pattern', () => {
    const r = extractEntities('Ejendom: BFE 100165718. Andet: BFE-nr 226630.');
    expect(r.bfes).toContain('100165718');
    expect(r.bfes).toContain('226630');
  });

  it('accepts BFE in range 5-10 digits', () => {
    const r = extractEntities('BFE 12345, BFE 1234567890, BFE 1234 (too short).');
    expect(r.bfes).toContain('12345');
    expect(r.bfes).toContain('1234567890');
    expect(r.bfes).not.toContain('1234');
  });

  it('extracts CPR prefixes but the caller must not forward them to Claude', () => {
    const r = extractEntities('CPR 010190-1234. Født 150585 0199.');
    expect(r.cprPrefixes).toContain('010190');
    expect(r.cprPrefixes).toContain('150585');
  });

  it('rejects CPR-like digit runs with invalid day/month', () => {
    const r = extractEntities('Some number 991399 1234 and 321399 5678');
    // day=99 or day=32 should be rejected
    expect(r.cprPrefixes).not.toContain('991399');
    expect(r.cprPrefixes).not.toContain('321399');
  });

  it('extracts Danish addresses', () => {
    const r = extractEntities('Adresse: Hovedvejen 12, 2. tv, 2100 København Ø er solgt.');
    expect(r.addresses.some((a) => a.includes('Hovedvejen 12'))).toBe(true);
  });

  it('returns empty lists for text with no entities', () => {
    const r = extractEntities('Some prose without any identifiers.');
    expect(r.cvrs).toEqual([]);
    expect(r.bfes).toEqual([]);
    expect(r.cprPrefixes).toEqual([]);
  });

  it('dedupes repeated entities', () => {
    const r = extractEntities(
      'CVR 12345678 and later CVR 12345678 and BFE 200001 again BFE 200001'
    );
    expect(r.cvrs.filter((c) => c === '12345678')).toHaveLength(1);
    expect(r.bfes.filter((b) => b === '200001')).toHaveLength(1);
  });
});
