/**
 * Unit tests for DAWA helper functions.
 *
 * Dækker:
 * - rensAdresseStreng: fjerner dobbelt-komma fra DAWA-adressestrenge
 * - erDawaId: validerer UUID-format (bruges til at skelne DAWA vs mock-id)
 */

import { describe, it, expect } from 'vitest';
import { rensAdresseStreng, erDawaId } from '@/app/lib/dawa';

// ─── rensAdresseStreng ───────────────────────────────────────────────────────

describe('rensAdresseStreng', () => {
  it('fjerner dobbelt-komma fra DAWA-adressestrenge', () => {
    expect(rensAdresseStreng('Søbyvej 11, , 2650 Hvidovre')).toBe('Søbyvej 11, 2650 Hvidovre');
  });

  it('beholder normal adresse uændret', () => {
    expect(rensAdresseStreng('Arnold Nielsens Boulevard 64B, 2650 Hvidovre')).toBe(
      'Arnold Nielsens Boulevard 64B, 2650 Hvidovre'
    );
  });

  it('normaliserer adresse med etage og dør', () => {
    const input = 'Vesterbrogade 1, 2. tv, 1620 København V';
    expect(rensAdresseStreng(input)).toBe(input);
  });

  it('trimmer whitespace', () => {
    expect(rensAdresseStreng('  Søbyvej 11  ')).toBe('Søbyvej 11');
  });

  it('håndterer tom streng', () => {
    expect(rensAdresseStreng('')).toBe('');
  });

  it('håndterer flere ekstra mellemrum efter komma', () => {
    const result = rensAdresseStreng('Vejnavn 1,  2650 Hvidovre');
    expect(result).not.toContain('  ');
  });
});

// ─── erDawaId ────────────────────────────────────────────────────────────────

describe('erDawaId', () => {
  it('genkender gyldigt DAWA UUID', () => {
    expect(erDawaId('0a3f50a5-4197-32b8-e044-0003ba298018')).toBe(true);
    expect(erDawaId('64fe1896-699c-4558-92e3-20155693f9e6')).toBe(true);
  });

  it('afviser mock-id format', () => {
    expect(erDawaId('ejendom-1')).toBe(false);
    expect(erDawaId('123')).toBe(false);
    expect(erDawaId('')).toBe(false);
  });

  it('afviser delvist UUID-lignende strenge', () => {
    expect(erDawaId('0a3f50a5-4197-32b8')).toBe(false);
    expect(erDawaId('not-a-uuid-at-all-here')).toBe(false);
  });
});
