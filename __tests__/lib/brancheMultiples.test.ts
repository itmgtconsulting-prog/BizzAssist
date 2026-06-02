/**
 * BIZZ-1948: Unit tests for virksomhedshandler/brancheMultiples.
 *
 * Tester lookupBrancheMultiple, estimerVaerdi og den nye
 * beregnTransaktionsvaerdi (breakdown til AI-forklaring-popup).
 */
import { describe, it, expect } from 'vitest';
import {
  lookupBrancheMultiple,
  estimerVaerdi,
  beregnTransaktionsvaerdi,
} from '@/app/lib/virksomhedshandler/brancheMultiples';

describe('lookupBrancheMultiple', () => {
  it('returnerer null for null/tomt input', () => {
    expect(lookupBrancheMultiple(null)).toBeNull();
    expect(lookupBrancheMultiple('')).toBeNull();
    expect(lookupBrancheMultiple('1')).toBeNull();
  });

  it('matcher anlægsarbejde (42xxxx) på sektor-prefix', () => {
    const m = lookupBrancheMultiple('421100');
    expect(m?.db07_prefix).toBe('42');
    expect(m?.ev_ebitda_low).toBe(5);
    expect(m?.ev_ebitda_high).toBe(10);
  });

  it('matcher finansiel virksomhed (64xxxx)', () => {
    const m = lookupBrancheMultiple('642120');
    expect(m?.db07_prefix).toBe('64');
    expect(m?.ev_ebitda_mid).toBe(12);
  });
});

describe('estimerVaerdi', () => {
  it('returnerer null ved manglende EBITDA eller delta', () => {
    expect(estimerVaerdi('42', 0, 50)).toBeNull();
    expect(estimerVaerdi('42', 1_000_000, 0)).toBeNull();
    expect(estimerVaerdi('999', 1_000_000, 50)).toBeNull();
  });

  it('beregner range = aarsresultat × multiple × delta-faktor', () => {
    // branche 56 (Restauration): 4/6/9x
    const v = estimerVaerdi('56', 1_000_000, 50);
    expect(v).toEqual({ low: 2_000_000, mid: 3_000_000, high: 4_500_000 });
  });
});

describe('beregnTransaktionsvaerdi', () => {
  it('returnerer null ved manglende EBITDA, branche eller delta', () => {
    expect(beregnTransaktionsvaerdi('42', null, 50)).toBeNull();
    expect(beregnTransaktionsvaerdi('42', 5_000_000, 0)).toBeNull();
    expect(beregnTransaktionsvaerdi('99', 5_000_000, 50)).toBeNull();
  });

  it('matcher ticket-eksemplet: 5 mio EBITDA × 6x = 30 mio EV, 50% exit = 15 mio', () => {
    // Restauration (56): low 4, mid 6, high 9
    const b = beregnTransaktionsvaerdi('56', 5_000_000, 50);
    expect(b).not.toBeNull();
    expect(b?.ebitda_used).toBe(5_000_000);
    expect(b?.multiple).toEqual({ lav: 4, mid: 6, hoej: 9 });
    expect(b?.ev_range.mid).toBe(30_000_000);
    expect(b?.delta_pct).toBe(50);
    expect(b?.transaktionsvaerdi.mid).toBe(15_000_000);
    // low = 5M × 4 × 0.5 = 10M, high = 5M × 9 × 0.5 = 22.5M
    expect(b?.transaktionsvaerdi.lav).toBe(10_000_000);
    expect(b?.transaktionsvaerdi.hoej).toBe(22_500_000);
  });

  it('inkluderer branche-label og kilde til datakilde-visning', () => {
    const b = beregnTransaktionsvaerdi('421100', 10_000_000, 90);
    expect(b?.branche_label).toBe('Anlægsarbejde');
    expect(b?.kilde).toContain('EY');
  });
});
