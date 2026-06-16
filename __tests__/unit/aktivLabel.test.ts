/**
 * Unit tests for app/lib/forsikring/aktivLabel — BIZZ-2150.
 *
 * Sikrer at adresseløse ejendomme (label = rå "BFE xxx") vises som
 * "Ukendt adresse (BFE xxx)" mens alt andet (resolvet adresse, virksomheder,
 * biler) beholder labelet uændret.
 */

import { describe, it, expect } from 'vitest';
import { erEjendomUdenAdresse, visAktivLabel } from '@/app/lib/forsikring/aktivLabel';

describe('erEjendomUdenAdresse', () => {
  it('true for ejendom med rå BFE-label', () => {
    expect(erEjendomUdenAdresse({ type: 'ejendom', label: 'BFE 100563298' })).toBe(true);
  });

  it('false for ejendom med resolvet adresse', () => {
    expect(erEjendomUdenAdresse({ type: 'ejendom', label: 'Stengade 10A' })).toBe(false);
  });

  it('false for virksomhed/bil uanset label', () => {
    expect(erEjendomUdenAdresse({ type: 'virksomhed', label: 'BFE 123' })).toBe(false);
    expect(erEjendomUdenAdresse({ type: 'bil', label: 'BFE 123' })).toBe(false);
  });

  it('false for null/undefined label', () => {
    expect(erEjendomUdenAdresse({ type: 'ejendom', label: null })).toBe(false);
    expect(erEjendomUdenAdresse({ type: 'ejendom' })).toBe(false);
  });
});

describe('visAktivLabel', () => {
  it('omslutter rå BFE-label på dansk', () => {
    expect(visAktivLabel({ type: 'ejendom', label: 'BFE 100563298' }, true)).toBe(
      'Ukendt adresse (BFE 100563298)'
    );
  });

  it('omslutter rå BFE-label på engelsk', () => {
    expect(visAktivLabel({ type: 'ejendom', label: 'BFE 100563298' }, false)).toBe(
      'Unknown address (BFE 100563298)'
    );
  });

  it('bevarer resolvet adresse uændret', () => {
    expect(visAktivLabel({ type: 'ejendom', label: 'Stengade 10A' }, true)).toBe('Stengade 10A');
  });

  it('bevarer virksomheds-label uændret', () => {
    expect(visAktivLabel({ type: 'virksomhed', label: 'FAMILIEN PETERSEN A/S' }, true)).toBe(
      'FAMILIEN PETERSEN A/S'
    );
  });
});
