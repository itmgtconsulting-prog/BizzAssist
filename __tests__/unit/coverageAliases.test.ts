/**
 * Unit tests for app/lib/forsikring/coverageAliases.ts (BIZZ-1939).
 *
 * Dækker:
 *   - resolveInsurerFamily matcher Topdanmark/If, ignorerer ukendte selskaber
 *   - effectiveCoveredCodes udvider med selskabs-aliasser (erhvervsansvar ⇒ hus_grundejer_ansvar)
 *   - Alias gælder kun for relevante selskaber, ikke globalt
 */
import { describe, it, expect } from 'vitest';
import { resolveInsurerFamily, effectiveCoveredCodes } from '@/app/lib/forsikring/coverageAliases';

describe('resolveInsurerFamily', () => {
  it('matcher Topdanmark', () => {
    expect(resolveInsurerFamily('Topdanmark - en del af If Skadeforsikring')).toBe('topdanmark');
    expect(resolveInsurerFamily('TOPDANMARK Forsikring A/S')).toBe('topdanmark');
  });

  it('matcher If som selvstændigt selskab', () => {
    expect(resolveInsurerFamily('If Skadeforsikring')).toBe('if');
  });

  it('returnerer null for selskaber uden kendte aliasser', () => {
    expect(resolveInsurerFamily('Alm. Brand Forsikring A/S')).toBeNull();
    expect(resolveInsurerFamily('Tryg Forsikring')).toBeNull();
    expect(resolveInsurerFamily('Gjensidige')).toBeNull(); // "if" må ikke matche som delstreng
    expect(resolveInsurerFamily(null)).toBeNull();
    expect(resolveInsurerFamily('')).toBeNull();
  });
});

describe('effectiveCoveredCodes', () => {
  it('udvider Topdanmark Erhvervsansvar til hus_grundejer_ansvar', () => {
    const codes = effectiveCoveredCodes('Topdanmark - en del af If Skadeforsikring', [
      { coverage_code: 'erhvervsansvar', is_covered: true },
    ]);
    expect(codes.has('erhvervsansvar')).toBe(true);
    expect(codes.has('hus_grundejer_ansvar')).toBe(true);
  });

  it('udvider IKKE for Alm. Brand', () => {
    const codes = effectiveCoveredCodes('Alm. Brand Forsikring A/S', [
      { coverage_code: 'erhvervsansvar', is_covered: true },
    ]);
    expect(codes.has('erhvervsansvar')).toBe(true);
    expect(codes.has('hus_grundejer_ansvar')).toBe(false);
  });

  it('ignorerer ikke-dækkede coverages', () => {
    const codes = effectiveCoveredCodes('Topdanmark', [
      { coverage_code: 'erhvervsansvar', is_covered: false },
    ]);
    expect(codes.has('erhvervsansvar')).toBe(false);
    expect(codes.has('hus_grundejer_ansvar')).toBe(false);
  });

  it('bevarer eksisterende hus_grundejer_ansvar-linje', () => {
    const codes = effectiveCoveredCodes('Topdanmark', [
      { coverage_code: 'hus_grundejer_ansvar', is_covered: true },
    ]);
    expect(codes.has('hus_grundejer_ansvar')).toBe(true);
  });
});
