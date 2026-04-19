/**
 * Unit tests for benyttelseskoder.ts — BIZZ-574 zone/ejerlejlighed sanity check
 * for fritids-kategori badges.
 */
import { describe, it, expect } from 'vitest';
import { formatBenyttelseOgByggeaar } from '@/app/lib/benyttelseskoder';

describe('formatBenyttelseOgByggeaar — BIZZ-574', () => {
  it('suppresses Sommerhus badge when zone is Byzone', () => {
    expect(formatBenyttelseOgByggeaar('21', 1965, 'Byzone')).toBe('(1965)');
  });

  it('suppresses Sommerhus badge when zone is Landzone', () => {
    expect(formatBenyttelseOgByggeaar('21', 1965, 'Landzone')).toBe('(1965)');
  });

  it('suppresses Sommerhus badge when zone is Udfaset', () => {
    // Regression: Thorvald Bindesbølls Plads 18 has zone=Udfaset, not Byzone.
    // v1 only checked Byzone so "Sommerhus" leaked through.
    expect(formatBenyttelseOgByggeaar('21', 1965, 'Udfaset')).toBe('(1965)');
  });

  it('keeps Sommerhus badge when zone is Sommerhuszone', () => {
    expect(formatBenyttelseOgByggeaar('21', 1965, 'Sommerhuszone')).toBe('Sommerhus (1965)');
  });

  it('keeps Sommerhus badge when zone is null (no data — trust VUR)', () => {
    expect(formatBenyttelseOgByggeaar('21', 1965, null)).toBe('Sommerhus (1965)');
    expect(formatBenyttelseOgByggeaar('21', 1965)).toBe('Sommerhus (1965)');
  });

  it('suppresses Sommerhus badge for ejerlejligheder regardless of zone', () => {
    // A "Sommerhus" (kode 21) cannot also be an ejerlejlighed. Even if zone is
    // unknown, the ejerlejlighed-flag overrides.
    expect(formatBenyttelseOgByggeaar('21', 1965, null, true)).toBe('(1965)');
  });

  it('keeps non-fritids kategori unaffected by zone', () => {
    // Værksted in Byzone is fine — not a fritids-kategori.
    expect(formatBenyttelseOgByggeaar('31', 1955, 'Byzone')).toBe('Værksted (1955)');
    // Parcelhus in Landzone is fine.
    expect(formatBenyttelseOgByggeaar('01', 1980, 'Landzone')).toBe('Parcelhus (1980)');
  });

  it('suppresses Fritidsbolig, Kolonihave, Feriehus outside sommerhuszone', () => {
    expect(formatBenyttelseOgByggeaar('22', 1980, 'Byzone')).toBe('(1980)');
    expect(formatBenyttelseOgByggeaar('23', 1980, 'Byzone')).toBe('(1980)');
    expect(formatBenyttelseOgByggeaar('24', 1980, 'Byzone')).toBe('(1980)');
  });

  it('returns null when no benyttelseskode and no byggeaar', () => {
    expect(formatBenyttelseOgByggeaar(null, null)).toBeNull();
  });
});
