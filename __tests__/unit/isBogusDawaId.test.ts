/**
 * BIZZ-2188: isBogusDawaId — kilde-uafhængig format-validering af dawa_id.
 * DAWA-UUID er lowercase hex; VP-interne uppercase GUID'er er bogus og skal
 * re-resolves (ellers "Adresse ikke fundet" på ejendoms-detaljesiden).
 */
import { describe, it, expect } from 'vitest';
import { isBogusDawaId } from '@/app/lib/bfeAdresse';

describe('isBogusDawaId (BIZZ-2188)', () => {
  it('accepterer gyldigt lowercase DAWA-UUID', () => {
    expect(isBogusDawaId('0a3f507c-c891-32b8-e044-0003ba298018')).toBe(false);
  });
  it('flagger uppercase VP-GUID som bogus', () => {
    expect(isBogusDawaId('677CBBF2-D4D1-4891-BDD5-9F3DF67C7D72')).toBe(true);
  });
  it('flagger vilkårlig ikke-UUID-streng som bogus', () => {
    expect(isBogusDawaId('vp-internal-123')).toBe(true);
  });
  it('behandler null/undefined/tom som IKKE-bogus (ingen dawa_id at rette)', () => {
    expect(isBogusDawaId(null)).toBe(false);
    expect(isBogusDawaId(undefined)).toBe(false);
    expect(isBogusDawaId('')).toBe(false);
  });
});
