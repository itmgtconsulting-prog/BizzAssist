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
  getEjendomKindStyle,
  type EntityKind,
  type EjendomKind,
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

  it('link-streng har hover, focus-visible og transition (BIZZ-853)', () => {
    for (const kind of ['ejendom', 'virksomhed', 'person'] as EntityKind[]) {
      const s = getEntityStyle(kind);
      expect(s.link).toMatch(/hover:text-/);
      expect(s.link).toMatch(/focus-visible:ring/);
      expect(s.link).toMatch(/transition-colors/);
      expect(s.link).toMatch(/cursor-pointer/);
    }
  });

  it('person link-hover er purple, virksomhed er blue, ejendom er emerald (BIZZ-853)', () => {
    expect(getEntityStyle('person').link).toContain('hover:text-purple-400');
    expect(getEntityStyle('virksomhed').link).toContain('hover:text-blue-400');
    expect(getEntityStyle('ejendom').link).toContain('hover:text-emerald-400');
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

// ─── BIZZ-859: EjendomKind styles ──────────────────────────────────────────

describe('getEjendomKindStyle (BIZZ-859)', () => {
  const KINDS: EjendomKind[] = ['sfe', 'hovedejendom', 'ejerlejlighed', 'bygning'];

  it('returns style for all 4 property kinds', () => {
    for (const kind of KINDS) {
      const s = getEjendomKindStyle(kind);
      expect(s).toBeDefined();
      expect(s.badgeDa).toBeTruthy();
      expect(s.badgeEn).toBeTruthy();
      expect(s.chip).toMatch(/bg-/);
      expect(s.tooltipDa).toBeTruthy();
      expect(s.tooltipEn).toBeTruthy();
    }
  });

  it('sfe and hovedejendom use amber, ejerlejlighed uses emerald, bygning uses blue', () => {
    expect(getEjendomKindStyle('sfe').chip).toContain('amber');
    expect(getEjendomKindStyle('hovedejendom').chip).toContain('amber');
    expect(getEjendomKindStyle('ejerlejlighed').chip).toContain('emerald');
    expect(getEjendomKindStyle('bygning').chip).toContain('blue');
  });

  it('labels match terminology table', () => {
    expect(getEjendomKindStyle('sfe').badgeDa).toBe('SFE');
    expect(getEjendomKindStyle('hovedejendom').badgeDa).toBe('Hovedejendom');
    expect(getEjendomKindStyle('ejerlejlighed').badgeDa).toBe('Ejerlejlighed');
    expect(getEjendomKindStyle('bygning').badgeDa).toBe('Bygning');
  });
});
