/**
 * BIZZ-1529: Unit tests for forsikring/brancheRisiko.
 *
 * Tester lookupBrancheKrav (DB07 branche → krav) og isOperationelBranche.
 */
import { describe, it, expect } from 'vitest';
import { lookupBrancheKrav, isOperationelBranche } from '@/app/lib/forsikring/brancheRisiko';

describe('lookupBrancheKrav', () => {
  it('returnerer null for null input', () => {
    expect(lookupBrancheKrav(null)).toBeNull();
  });

  it('returnerer null for ukendt branchekode', () => {
    expect(lookupBrancheKrav('999999')).toBeNull();
  });

  it('matcher restaurant (5610...)', () => {
    const k = lookupBrancheKrav('561010');
    expect(k?.kategori).toBe('hoejrisiko');
    expect(k?.label).toBe('Restaurant');
    expect(k?.kraevede_daekninger).toContain('brand');
    expect(k?.kraevede_daekninger).toContain('produktansvar');
  });

  it('matcher hotel (5510)', () => {
    const k = lookupBrancheKrav('551020');
    expect(k?.label).toBe('Hotel');
    expect(k?.kraevede_daekninger).toContain('rejsegods');
  });

  it('matcher byggeri (41)', () => {
    const k = lookupBrancheKrav('412000');
    expect(k?.label).toBe('Bygningsfærdiggørelse');
    expect(k?.kraevede_daekninger).toContain('all-risk');
    expect(k?.kraevede_daekninger).toContain('arbejdsskade');
  });

  it('normaliserer punktum i koden ("56.10.10" → "561010")', () => {
    const k = lookupBrancheKrav('56.10.10');
    expect(k?.label).toBe('Restaurant');
  });

  it('længste prefix vinder (specifik over generel)', () => {
    // 4520 (autoværksted) skal vinde over 45 (handel med motorkøretøjer)
    const specifik = lookupBrancheKrav('452010');
    expect(specifik?.label).toBe('Autoværksted/lakering');

    // 6810 (boligudlejning) skal vinde over 68 (ejendomsmægler/admin)
    const ejendom = lookupBrancheKrav('681020');
    expect(ejendom?.label).toBe('Udlejning af boliger');
  });
});

describe('isOperationelBranche', () => {
  it('returnerer false for null', () => {
    expect(isOperationelBranche(null)).toBe(false);
  });

  it('returnerer false for holding (642x)', () => {
    expect(isOperationelBranche('642010')).toBe(false);
  });

  it('returnerer false for ikke-finansielle holdings (6420)', () => {
    expect(isOperationelBranche('6420')).toBe(false);
  });

  it('returnerer false for hovedkvarter-aktiviteter (7010)', () => {
    expect(isOperationelBranche('701000')).toBe(false);
  });

  it('returnerer true for restaurant (5610)', () => {
    expect(isOperationelBranche('561010')).toBe(true);
  });

  it('returnerer true for byggeri (41)', () => {
    expect(isOperationelBranche('412000')).toBe(true);
  });

  it('normaliserer punktummer', () => {
    expect(isOperationelBranche('64.20.10')).toBe(false);
  });
});
