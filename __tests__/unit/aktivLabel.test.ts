/**
 * Unit tests for app/lib/forsikring/aktivLabel — BIZZ-2150.
 *
 * Sikrer at adresseløse ejendomme (label = rå "BFE xxx") vises som
 * "Ukendt adresse (BFE xxx)" mens alt andet (resolvet adresse, virksomheder,
 * biler) beholder labelet uændret.
 */

import { describe, it, expect } from 'vitest';
import {
  erEjendomUdenAdresse,
  visAktivLabel,
  findDelteAdresser,
  visAktivLabelDisambig,
} from '@/app/lib/forsikring/aktivLabel';

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

describe('findDelteAdresser', () => {
  // BIZZ-2149: to ejerlejligheder med samme adresse men forskellige BFE.
  const stjernegade = [
    { type: 'ejendom', label: 'Stjernegade 24A, 3000 Helsingør', bfe: 244640 },
    { type: 'ejendom', label: 'Stjernegade 24A, 3000 Helsingør', bfe: 244655 },
    { type: 'ejendom', label: 'Torvegade 5A, 3000 Helsingør', bfe: 5319041 },
  ];

  it('finder adresse delt af to distinkte BFE', () => {
    const delte = findDelteAdresser(stjernegade, true);
    expect(delte.has('Stjernegade 24A, 3000 Helsingør')).toBe(true);
    expect(delte.has('Torvegade 5A, 3000 Helsingør')).toBe(false);
  });

  it('samme BFE to gange tæller ikke som delt', () => {
    const delte = findDelteAdresser(
      [
        { type: 'ejendom', label: 'Stengade 10A', bfe: 5319420 },
        { type: 'ejendom', label: 'Stengade 10A', bfe: 5319420 },
      ],
      true
    );
    expect(delte.size).toBe(0);
  });

  it('ignorerer virksomheder og adresseløse ejendomme', () => {
    const delte = findDelteAdresser(
      [
        { type: 'virksomhed', label: 'A/S X', bfe: null },
        { type: 'ejendom', label: 'BFE 100563298', bfe: 100563298 },
        { type: 'ejendom', label: 'BFE 100563299', bfe: 100563299 },
      ],
      true
    );
    expect(delte.size).toBe(0);
  });
});

describe('visAktivLabelDisambig', () => {
  const delte = new Set(['Stjernegade 24A, 3000 Helsingør']);

  it('tilføjer BFE-suffix på delt adresse', () => {
    expect(
      visAktivLabelDisambig(
        { type: 'ejendom', label: 'Stjernegade 24A, 3000 Helsingør', bfe: 244640 },
        true,
        delte
      )
    ).toBe('Stjernegade 24A, 3000 Helsingør (BFE 244640)');
  });

  it('bevarer unik adresse uændret', () => {
    expect(
      visAktivLabelDisambig(
        { type: 'ejendom', label: 'Torvegade 5A, 3000 Helsingør', bfe: 5319041 },
        true,
        delte
      )
    ).toBe('Torvegade 5A, 3000 Helsingør');
  });

  it('adresseløs ejendom beholder Ukendt adresse-label', () => {
    expect(
      visAktivLabelDisambig(
        { type: 'ejendom', label: 'BFE 100563298', bfe: 100563298 },
        true,
        delte
      )
    ).toBe('Ukendt adresse (BFE 100563298)');
  });
});
