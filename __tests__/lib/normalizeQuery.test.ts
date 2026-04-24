/**
 * BIZZ-843 unit tests for adresse-query-normalisering.
 */
import { describe, it, expect } from 'vitest';
import { expandAddressQueryVariants, hasInitialPrefix } from '@/app/lib/search/normalizeQuery';

describe('expandAddressQueryVariants', () => {
  it('ekspander glued initialer ("HC Møllersvej")', () => {
    const v = expandAddressQueryVariants('HC Møllersvej 21');
    expect(v).toContain('HC Møllersvej 21');
    expect(v).toContain('H C Møllersvej 21');
  });

  it('strip punktummer og mellemrum ("H.C. Andersens")', () => {
    const v = expandAddressQueryVariants('H.C. Andersens Boulevard 12');
    expect(v).toContain('H.C. Andersens Boulevard 12');
    expect(v).toContain('H C Andersens Boulevard 12');
  });

  it('strip punktummer med ekstra mellemrum ("H. C. Andersens")', () => {
    const v = expandAddressQueryVariants('H. C. Andersens Boulevard');
    expect(v.some((s) => s === 'H C Andersens Boulevard')).toBe(true);
  });

  it('allerede normaliseret giver én variant', () => {
    const v = expandAddressQueryVariants('H C Andersens Boulevard');
    expect(v).toHaveLength(1);
    expect(v[0]).toBe('H C Andersens Boulevard');
  });

  it('ekspander fully-glued ("HCAndersens")', () => {
    const v = expandAddressQueryVariants('HCAndersens Boulevard');
    expect(v).toContain('HCAndersens Boulevard');
    expect(v).toContain('H C Andersens Boulevard');
  });

  it('tre initialer ekspanderes', () => {
    const v = expandAddressQueryVariants('CFM Jensen');
    expect(v).toContain('CFM Jensen');
    expect(v).toContain('C F M Jensen');
  });

  it('almindelige vejnavne berøres ikke', () => {
    expect(expandAddressQueryVariants('Strandvejen 12')).toEqual(['Strandvejen 12']);
    expect(expandAddressQueryVariants('Møllersvej 21')).toEqual(['Møllersvej 21']);
    expect(expandAddressQueryVariants('Hovedgaden 5')).toEqual(['Hovedgaden 5']);
  });

  it('tom string returnerer tom liste', () => {
    expect(expandAddressQueryVariants('')).toEqual([]);
    expect(expandAddressQueryVariants('   ')).toEqual([]);
  });

  it('trimmer whitespace', () => {
    const v = expandAddressQueryVariants('  HC Møllersvej  ');
    expect(v[0]).toBe('HC Møllersvej');
    expect(v).toContain('H C Møllersvej');
  });

  it('respekterer max 3 varianter cap', () => {
    const v = expandAddressQueryVariants('H.C. Andersens');
    expect(v.length).toBeLessThanOrEqual(3);
  });

  it('fire initialer ekspanderes ("ABCD Gade")', () => {
    const v = expandAddressQueryVariants('ABCD Gade');
    expect(v).toContain('A B C D Gade');
  });

  it('glued 3 letter initialer ekspanderes ("CFMJensens")', () => {
    const v = expandAddressQueryVariants('CFMJensens Gade');
    expect(v).toContain('C F M Jensens Gade');
  });
});

describe('hasInitialPrefix', () => {
  it('detekterer initialer med punktum', () => {
    expect(hasInitialPrefix('H.C. Andersens')).toBe(true);
    expect(hasInitialPrefix('H. C. Andersens')).toBe(true);
  });

  it('detekterer glued initialer med mellemrum', () => {
    expect(hasInitialPrefix('HC Møllersvej')).toBe(true);
    expect(hasInitialPrefix('CFM Jensen')).toBe(true);
  });

  it('detekterer fully-glued initialer', () => {
    expect(hasInitialPrefix('HCAndersens Boulevard')).toBe(true);
  });

  it('returnerer false for almindelige vejnavne', () => {
    expect(hasInitialPrefix('Strandvejen 12')).toBe(false);
    expect(hasInitialPrefix('Møllersvej 21')).toBe(false);
    expect(hasInitialPrefix('Jens Olsens Vej')).toBe(false);
  });

  it('returnerer false for allerede space-separerede initialer', () => {
    expect(hasInitialPrefix('H C Andersens')).toBe(false);
  });
});
