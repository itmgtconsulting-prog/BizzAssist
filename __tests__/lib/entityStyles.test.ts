/**
 * Unit tests for app/lib/entityStyles.ts (BIZZ-806).
 *
 * Verifies:
 *   - Hver EntityKind får unique farve + ikon-komponent
 *   - getEntityBadge returnerer bilingual labels
 *   - mapLegacyType korrekt kortlægger API-type-strings
 *   - Alle 3 entities matcher de TicketSpec farve-konventioner
 */
import { describe, it, expect } from 'vitest';
import { Home, Briefcase, User } from 'lucide-react';
import {
  getEntityStyle,
  getEntityBadge,
  mapLegacyType,
  type EntityKind,
} from '@/app/lib/entityStyles';

describe('getEntityStyle', () => {
  it('ejendom → emerald + Home-ikon', () => {
    const s = getEntityStyle('ejendom');
    expect(s.Icon).toBe(Home);
    expect(s.textColor).toBe('text-emerald-400');
    expect(s.chip).toContain('emerald');
  });

  it('virksomhed → blue + Briefcase-ikon', () => {
    const s = getEntityStyle('virksomhed');
    expect(s.Icon).toBe(Briefcase);
    expect(s.textColor).toBe('text-blue-400');
    expect(s.chip).toContain('blue');
  });

  it('person → purple + User-ikon', () => {
    const s = getEntityStyle('person');
    expect(s.Icon).toBe(User);
    expect(s.textColor).toBe('text-purple-400');
    expect(s.chip).toContain('purple');
  });

  it('chip-streng indeholder bg + text + border klasser', () => {
    const s = getEntityStyle('virksomhed');
    expect(s.chip.split(' ').length).toBeGreaterThanOrEqual(3);
    expect(s.chip).toMatch(/bg-/);
    expect(s.chip).toMatch(/text-/);
    expect(s.chip).toMatch(/border-/);
  });
});

describe('getEntityBadge', () => {
  it('returns dansk label for lang=da', () => {
    expect(getEntityBadge('ejendom', 'da')).toBe('Ejendom');
    expect(getEntityBadge('virksomhed', 'da')).toBe('Virksomhed');
    expect(getEntityBadge('person', 'da')).toBe('Person');
  });

  it('returns engelsk label for lang=en', () => {
    expect(getEntityBadge('ejendom', 'en')).toBe('Property');
    expect(getEntityBadge('virksomhed', 'en')).toBe('Company');
    expect(getEntityBadge('person', 'en')).toBe('Person');
  });
});

describe('mapLegacyType', () => {
  it('kortlægger alle 3 legacy types korrekt', () => {
    expect(mapLegacyType('address')).toBe<EntityKind>('ejendom');
    expect(mapLegacyType('company')).toBe<EntityKind>('virksomhed');
    expect(mapLegacyType('person')).toBe<EntityKind>('person');
  });
});

describe('konsistens-check: alle 3 entities har unique farver', () => {
  it('tekstfarver er unique', () => {
    const colors = (['ejendom', 'virksomhed', 'person'] as EntityKind[]).map(
      (k) => getEntityStyle(k).textColor
    );
    expect(new Set(colors).size).toBe(3);
  });

  it('ikon-komponenter er unique', () => {
    const icons = (['ejendom', 'virksomhed', 'person'] as EntityKind[]).map(
      (k) => getEntityStyle(k).Icon
    );
    expect(new Set(icons).size).toBe(3);
  });
});
