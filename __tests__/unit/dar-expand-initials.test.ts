/**
 * Unit tests for expandInitials (BIZZ-606).
 *
 * Verificerer at initial-forkortelser normaliseres så bruger-input
 * "HC", "H.C.", "hc" og "h c" alle producerer varianter der matcher
 * DAWA's officielle form "H C Møllersvej".
 */

import { describe, it, expect } from 'vitest';
import { expandInitials } from '../../app/lib/dar';

describe('expandInitials (BIZZ-606)', () => {
  it('expands uppercase compact initials "HC" to "H C" and "H.C."', () => {
    const result = expandInitials('HC Møllersvej');
    expect(result).toEqual(
      expect.arrayContaining(['HC Møllersvej', 'H C Møllersvej', 'H.C. Møllersvej'])
    );
  });

  it('expands dotted initials "H.C." to compact and space-separated', () => {
    const result = expandInitials('H.C. Møllersvej');
    expect(result).toEqual(
      expect.arrayContaining(['H.C. Møllersvej', 'HC Møllersvej', 'H C Møllersvej'])
    );
  });

  it('expands "H.C.Møllersvej" (no space) to all variants with space', () => {
    const result = expandInitials('H.C.Møllersvej');
    expect(result).toEqual(
      expect.arrayContaining(['HC Møllersvej', 'H C Møllersvej', 'H.C. Møllersvej'])
    );
  });

  it('expands space-separated single letters "H C" to compact and dotted', () => {
    const result = expandInitials('H C Møllersvej');
    expect(result).toEqual(
      expect.arrayContaining(['H C Møllersvej', 'HC Møllersvej', 'H.C. Møllersvej'])
    );
  });

  it('expands triple initials "A.P.M." correctly', () => {
    const result = expandInitials('A.P.M. Vej');
    expect(result).toEqual(expect.arrayContaining(['A.P.M. Vej', 'APM Vej', 'A P M Vej']));
  });

  it('handles lowercase initials via uppercase rebuild ("h.c. møllersvej" → "H C møllersvej")', () => {
    const result = expandInitials('h.c. møllersvej');
    expect(result).toEqual(
      expect.arrayContaining([
        'h.c. møllersvej',
        'HC møllersvej',
        'H C møllersvej',
        'H.C. møllersvej',
      ])
    );
  });

  it('does not expand regular street names without initials', () => {
    expect(expandInitials('Arnold Nielsens Boulevard')).toEqual(['Arnold Nielsens Boulevard']);
    expect(expandInitials('Bredgade 1')).toEqual(['Bredgade 1']);
    expect(expandInitials('Hans Olsen Vej')).toEqual(['Hans Olsen Vej']);
  });

  it('does not falsely expand common short words ("min gade")', () => {
    expect(expandInitials('min gade 5')).toEqual(['min gade 5']);
    expect(expandInitials('Vi er her')).toEqual(['Vi er her']);
  });

  it('handles street with house number ("H.C. Møllersvej 21")', () => {
    const result = expandInitials('H.C. Møllersvej 21');
    expect(result).toContain('HC Møllersvej 21');
    expect(result).toContain('H C Møllersvej 21');
  });

  it('handles Æ/Ø/Å in initials (rare but valid)', () => {
    const result = expandInitials('Æ.Ø. Skov');
    expect(result).toEqual(expect.arrayContaining(['ÆØ Skov', 'Æ Ø Skov']));
  });
});
