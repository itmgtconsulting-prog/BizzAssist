/**
 * BIZZ-842 unit tests for EJF handelstype-mapping.
 */
import { describe, it, expect } from 'vitest';
import { getHandelstypeInfo, handelstypeBadgeClasses } from '@/app/lib/ejfKoder';

describe('getHandelstypeInfo', () => {
  it('returnerer info for kode 10 (fri handel)', () => {
    const i = getHandelstypeInfo('10');
    expect(i).not.toBeNull();
    expect(i?.label).toBe('Fri handel');
    expect(i?.color).toBe('emerald');
    expect(i?.description).toContain('armslængdeprincippet');
  });

  it('returnerer info for kode 20 (familiehandel)', () => {
    const i = getHandelstypeInfo('20');
    expect(i?.label).toBe('Familiehandel');
    expect(i?.color).toBe('blue');
  });

  it('returnerer info for kode 30 (andet)', () => {
    const i = getHandelstypeInfo('30');
    expect(i?.label).toBe('Andet');
    expect(i?.color).toBe('amber');
  });

  it('returnerer info for kode 40 (ubekendt)', () => {
    const i = getHandelstypeInfo('40');
    expect(i?.label).toBe('Ubekendt');
    expect(i?.color).toBe('slate');
  });

  it('accepterer tal som kode', () => {
    expect(getHandelstypeInfo(10)?.label).toBe('Fri handel');
    expect(getHandelstypeInfo(30)?.label).toBe('Andet');
  });

  it('returnerer null for ukendte koder', () => {
    expect(getHandelstypeInfo('99')).toBeNull();
    expect(getHandelstypeInfo('xyz')).toBeNull();
    expect(getHandelstypeInfo(null)).toBeNull();
    expect(getHandelstypeInfo(undefined)).toBeNull();
    expect(getHandelstypeInfo('')).toBeNull();
  });

  it('bilingual labels', () => {
    expect(getHandelstypeInfo('10')?.labelEn).toBe('Free sale');
    expect(getHandelstypeInfo('20')?.labelEn).toBe('Family sale');
    expect(getHandelstypeInfo('30')?.labelEn).toBe('Other');
    expect(getHandelstypeInfo('40')?.labelEn).toBe('Unknown');
  });
});

describe('handelstypeBadgeClasses', () => {
  it('indeholder text/bg/border for hver farve', () => {
    const colors = ['emerald', 'blue', 'amber', 'slate'] as const;
    for (const c of colors) {
      const cls = handelstypeBadgeClasses(c);
      expect(cls).toMatch(/text-/);
      expect(cls).toMatch(/bg-/);
      expect(cls).toMatch(/border-/);
    }
  });

  it('farverne er unique pr type', () => {
    const s = new Set(
      (['emerald', 'blue', 'amber', 'slate'] as const).map(handelstypeBadgeClasses)
    );
    expect(s.size).toBe(4);
  });
});
