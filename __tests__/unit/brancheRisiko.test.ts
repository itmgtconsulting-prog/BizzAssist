/**
 * Unit tests for brancheRisiko — BIZZ-1387.
 */

import { describe, it, expect } from 'vitest';
import { lookupBrancheKrav, isOperationelBranche } from '@/app/lib/forsikring/brancheRisiko';

describe('lookupBrancheKrav', () => {
  it('returnerer hoejrisiko for restaurant (5610)', () => {
    const krav = lookupBrancheKrav('561010');
    expect(krav).not.toBeNull();
    expect(krav?.kategori).toBe('hoejrisiko');
    expect(krav?.label).toBe('Restaurant');
    expect(krav?.kraevede_daekninger).toContain('brand');
  });

  it('returnerer holding for 6420', () => {
    const krav = lookupBrancheKrav('642020');
    expect(krav?.kategori).toBe('holding');
    expect(krav?.kraevede_daekninger).toContain('d&o');
  });

  it('returnerer hoejrisiko for byggeri (41)', () => {
    const krav = lookupBrancheKrav('411000');
    expect(krav?.kategori).toBe('hoejrisiko');
    expect(krav?.label).toBe('Byggeri');
  });

  it('returnerer hoejrisiko for udlejning (681020)', () => {
    // BIZZ-1446: Udlejning er nu hoejrisiko med specifikke krav
    const krav = lookupBrancheKrav('681020');
    expect(krav).not.toBeNull();
    expect(krav!.kategori).toBe('hoejrisiko');
    expect(krav!.kraevede_daekninger).toContain('ejendomsforsikring');
  });

  it('returnerer null for null', () => {
    expect(lookupBrancheKrav(null)).toBeNull();
  });

  it('haandterer koder med punktum', () => {
    const krav = lookupBrancheKrav('56.10.10');
    expect(krav?.kategori).toBe('hoejrisiko');
  });
});

describe('isOperationelBranche', () => {
  it('restaurant er operationel', () => {
    expect(isOperationelBranche('561010')).toBe(true);
  });

  it('holding er IKKE operationel', () => {
    expect(isOperationelBranche('642020')).toBe(false);
  });

  it('null returnerer false', () => {
    expect(isOperationelBranche(null)).toBe(false);
  });
});
