/**
 * BIZZ-2080: Tests for getMatchBegrundelse — afledning af menneskelæsbar
 * match-begrundelse fra (aktiv-type, match_score).
 */
import { describe, it, expect } from 'vitest';
import { getMatchBegrundelse } from '@/app/lib/forsikring/matchBegrundelse';

describe('getMatchBegrundelse', () => {
  it('returnerer BFE-begrundelse for ejendom score 100 (da)', () => {
    expect(getMatchBegrundelse('ejendom', 100, true)).toBe('BFE-nummer matcher policens ejendom');
  });

  it('returnerer engelsk tekst når da=false', () => {
    expect(getMatchBegrundelse('ejendom', 100, false)).toBe(
      'BFE number matches the policy property'
    );
  });

  it('dækker alle ejendoms-scores fra assetMatcher (90/85/82/80/70)', () => {
    for (const score of [90, 85, 82, 80, 70]) {
      const tekst = getMatchBegrundelse('ejendom', score, true);
      expect(tekst).toBeTruthy();
      expect(tekst).not.toBe('Automatisk match');
    }
  });

  it('dækker alle virksomheds-scores fra assetMatcher (100/75/70/60)', () => {
    expect(getMatchBegrundelse('virksomhed', 100, true)).toContain('CVR');
    expect(getMatchBegrundelse('virksomhed', 75, true)).toContain('navn');
    expect(getMatchBegrundelse('virksomhed', 70, true)).toContain('erhverv');
    expect(getMatchBegrundelse('virksomhed', 60, true)).toContain('delvist');
  });

  it('dækker bil og bestyrelsespost', () => {
    expect(getMatchBegrundelse('bil', 100, true)).toContain('Registreringsnummer');
    expect(getMatchBegrundelse('bestyrelsespost', 100, true)).toContain('D&O');
  });

  it('returnerer null når score mangler', () => {
    expect(getMatchBegrundelse('ejendom', null, true)).toBeNull();
    expect(getMatchBegrundelse('ejendom', undefined, true)).toBeNull();
  });

  it('falder tilbage til generisk tekst for ukendt score/type', () => {
    expect(getMatchBegrundelse('ejendom', 55, true)).toBe('Automatisk match');
    expect(getMatchBegrundelse('ukendt-type', 100, false)).toBe('Automatic match');
  });
});
