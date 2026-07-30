/**
 * Unit tests for entityHref() i NotifikationsDropdown (BIZZ-2195).
 *
 * Verificerer at en notifikation navigerer til den RIGTIGE detaljeside afhængigt
 * af entitetstype (ejendom/virksomhed/person), så dropdownen kan vise alle
 * notifikationer man har fået mail på med korrekt klik-igennem.
 */
import { describe, it, expect } from 'vitest';
import { entityHref } from '@/app/components/NotifikationsDropdown';

describe('entityHref', () => {
  it('navigates property notifications to the ejendom detail page', () => {
    expect(entityHref('property', 'dawa-123')).toBe('/dashboard/ejendomme/dawa-123');
  });

  it('navigates company notifications to the company detail page', () => {
    expect(entityHref('company', '12345678')).toBe('/dashboard/companies/12345678');
  });

  it('navigates person notifications to the owner detail page', () => {
    expect(entityHref('person', 'enhed-999')).toBe('/dashboard/owners/enhed-999');
  });
});
