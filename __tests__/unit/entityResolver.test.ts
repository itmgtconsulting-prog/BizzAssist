/**
 * Unit tests for app/lib/entityResolver.
 *
 * Covers:
 * - resolveProperty: builds a correct PropertyEntity from BFE number
 * - resolveCompany: builds a correct CompanyEntity from CVR number
 * - resolvePerson: builds a correct PersonEntity from enhedsNummer
 * - entityBreadcrumbs: generates correct breadcrumb trails for all entity types
 * - extractEntitiesFromText: detects CVR/BFE/enhed patterns in free text
 */
import { describe, it, expect } from 'vitest';
import {
  resolveProperty,
  resolveCompany,
  resolvePerson,
  entityBreadcrumbs,
  extractEntitiesFromText,
  type PropertyEntity,
  type CompanyEntity,
  type PersonEntity,
} from '@/app/lib/entityResolver';

// ─── resolveProperty ─────────────────────────────────────────────────────────

describe('resolveProperty', () => {
  it('returns type "property"', () => {
    const entity = resolveProperty('1234567');
    expect(entity.type).toBe('property');
  });

  it('sets bfeNummer from a string argument', () => {
    const entity = resolveProperty('1234567');
    expect(entity.bfeNummer).toBe('1234567');
  });

  it('converts numeric BFE to string', () => {
    const entity = resolveProperty(9876543);
    expect(entity.bfeNummer).toBe('9876543');
  });

  it('builds the correct href', () => {
    const entity = resolveProperty('1234567');
    expect(entity.href).toBe('/dashboard/ejendomme/1234567');
  });

  it('stores the optional adresse when provided', () => {
    const entity = resolveProperty('1234567', 'Vesterbrogade 1, 1620 København V');
    expect(entity.adresse).toBe('Vesterbrogade 1, 1620 København V');
  });

  it('leaves adresse undefined when not provided', () => {
    const entity = resolveProperty('1234567');
    expect(entity.adresse).toBeUndefined();
  });

  it('handles a single-digit BFE (edge case)', () => {
    const entity = resolveProperty('1');
    expect(entity.bfeNummer).toBe('1');
    expect(entity.href).toBe('/dashboard/ejendomme/1');
  });
});

// ─── resolveCompany ───────────────────────────────────────────────────────────

describe('resolveCompany', () => {
  it('returns type "company"', () => {
    const entity = resolveCompany('12345678');
    expect(entity.type).toBe('company');
  });

  it('sets cvrNummer from a string argument', () => {
    const entity = resolveCompany('12345678');
    expect(entity.cvrNummer).toBe('12345678');
  });

  it('converts numeric CVR to string', () => {
    const entity = resolveCompany(12345678);
    expect(entity.cvrNummer).toBe('12345678');
  });

  it('builds the correct href', () => {
    const entity = resolveCompany('12345678');
    expect(entity.href).toBe('/dashboard/companies/12345678');
  });

  it('stores the optional navn when provided', () => {
    const entity = resolveCompany('12345678', 'Novo Nordisk A/S');
    expect(entity.navn).toBe('Novo Nordisk A/S');
  });

  it('leaves navn undefined when not provided', () => {
    const entity = resolveCompany('12345678');
    expect(entity.navn).toBeUndefined();
  });

  it('handles a numeric CVR with leading zero preserved as string', () => {
    // In practice CVR numbers never have leading zeros, but the API should not
    // silently drop them if supplied as a string.
    const entity = resolveCompany('01234567');
    expect(entity.cvrNummer).toBe('01234567');
    expect(entity.href).toBe('/dashboard/companies/01234567');
  });
});

// ─── resolvePerson ────────────────────────────────────────────────────────────

describe('resolvePerson', () => {
  it('returns type "person"', () => {
    const entity = resolvePerson('4000123456');
    expect(entity.type).toBe('person');
  });

  it('sets enhedsNummer from a string argument', () => {
    const entity = resolvePerson('4000123456');
    expect(entity.enhedsNummer).toBe('4000123456');
  });

  it('converts numeric enhedsNummer to string', () => {
    const entity = resolvePerson(4000123456);
    expect(entity.enhedsNummer).toBe('4000123456');
  });

  it('builds the correct href', () => {
    const entity = resolvePerson('4000123456');
    expect(entity.href).toBe('/dashboard/owners/4000123456');
  });

  it('stores the optional navn when provided', () => {
    const entity = resolvePerson('4000123456', 'Anders And');
    expect(entity.navn).toBe('Anders And');
  });

  it('leaves navn undefined when not provided', () => {
    const entity = resolvePerson('4000123456');
    expect(entity.navn).toBeUndefined();
  });
});

// ─── entityBreadcrumbs ────────────────────────────────────────────────────────

describe('entityBreadcrumbs', () => {
  // ── Property ──────────────────────────────────────────────────────────────

  describe('for a PropertyEntity', () => {
    it('returns 3 breadcrumbs', () => {
      const entity = resolveProperty('1234567');
      expect(entityBreadcrumbs(entity)).toHaveLength(3);
    });

    it('starts with Dashboard as the root', () => {
      const crumbs = entityBreadcrumbs(resolveProperty('1234567'));
      expect(crumbs[0]).toEqual({ label: 'Dashboard', href: '/dashboard' });
    });

    it('has Ejendomme as the second crumb', () => {
      const crumbs = entityBreadcrumbs(resolveProperty('1234567'));
      expect(crumbs[1]).toEqual({ label: 'Ejendomme', href: '/dashboard/ejendomme' });
    });

    it('uses adresse as the entity label when available', () => {
      const crumbs = entityBreadcrumbs(resolveProperty('1234567', 'Vesterbrogade 1'));
      expect(crumbs[2].label).toBe('Vesterbrogade 1');
      expect(crumbs[2].href).toBe('/dashboard/ejendomme/1234567');
    });

    it('falls back to "BFE <number>" when adresse is missing', () => {
      const crumbs = entityBreadcrumbs(resolveProperty('1234567'));
      expect(crumbs[2].label).toBe('BFE 1234567');
    });
  });

  // ── Company ───────────────────────────────────────────────────────────────

  describe('for a CompanyEntity', () => {
    it('returns 3 breadcrumbs', () => {
      const entity = resolveCompany('12345678');
      expect(entityBreadcrumbs(entity)).toHaveLength(3);
    });

    it('starts with Dashboard as the root', () => {
      const crumbs = entityBreadcrumbs(resolveCompany('12345678'));
      expect(crumbs[0]).toEqual({ label: 'Dashboard', href: '/dashboard' });
    });

    it('has Virksomheder as the second crumb', () => {
      const crumbs = entityBreadcrumbs(resolveCompany('12345678'));
      expect(crumbs[1]).toEqual({ label: 'Virksomheder', href: '/dashboard/companies' });
    });

    it('uses navn as the entity label when available', () => {
      const crumbs = entityBreadcrumbs(resolveCompany('12345678', 'Novo Nordisk A/S'));
      expect(crumbs[2].label).toBe('Novo Nordisk A/S');
      expect(crumbs[2].href).toBe('/dashboard/companies/12345678');
    });

    it('falls back to "CVR <number>" when navn is missing', () => {
      const crumbs = entityBreadcrumbs(resolveCompany('12345678'));
      expect(crumbs[2].label).toBe('CVR 12345678');
    });
  });

  // ── Person ────────────────────────────────────────────────────────────────

  describe('for a PersonEntity', () => {
    it('returns 3 breadcrumbs', () => {
      const entity = resolvePerson('4000123456');
      expect(entityBreadcrumbs(entity)).toHaveLength(3);
    });

    it('starts with Dashboard as the root', () => {
      const crumbs = entityBreadcrumbs(resolvePerson('4000123456'));
      expect(crumbs[0]).toEqual({ label: 'Dashboard', href: '/dashboard' });
    });

    it('has Personer as the second crumb', () => {
      const crumbs = entityBreadcrumbs(resolvePerson('4000123456'));
      expect(crumbs[1]).toEqual({ label: 'Personer', href: '/dashboard/owners' });
    });

    it('uses navn as the entity label when available', () => {
      const crumbs = entityBreadcrumbs(resolvePerson('4000123456', 'Anders And'));
      expect(crumbs[2].label).toBe('Anders And');
      expect(crumbs[2].href).toBe('/dashboard/owners/4000123456');
    });

    it('falls back to "Enhed <number>" when navn is missing', () => {
      const crumbs = entityBreadcrumbs(resolvePerson('4000123456'));
      expect(crumbs[2].label).toBe('Enhed 4000123456');
    });
  });
});

// ─── extractEntitiesFromText ──────────────────────────────────────────────────

describe('extractEntitiesFromText', () => {
  it('returns an empty array for empty input', () => {
    expect(extractEntitiesFromText('')).toEqual([]);
  });

  it('returns an empty array when no identifiers are present', () => {
    expect(extractEntitiesFromText('Ingen relevante identifikatorer her.')).toEqual([]);
  });

  // ── CVR detection ─────────────────────────────────────────────────────────

  it('extracts a CVR number from "CVR: 12345678"', () => {
    const results = extractEntitiesFromText('Virksomheden har CVR: 12345678.');
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('company');
    expect((results[0] as CompanyEntity).cvrNummer).toBe('12345678');
  });

  it('extracts a CVR number from lowercase "cvr 12345678"', () => {
    const results = extractEntitiesFromText('Se cvr 12345678 for detaljer.');
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('company');
  });

  it('extracts a CVR number from "cvr-nr. 12345678"', () => {
    const results = extractEntitiesFromText('cvr-nr. 12345678');
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('company');
    expect((results[0] as CompanyEntity).cvrNummer).toBe('12345678');
  });

  it('deduplicates the same CVR appearing twice', () => {
    const results = extractEntitiesFromText('CVR: 12345678 og igen CVR: 12345678.');
    expect(results).toHaveLength(1);
  });

  // ── BFE detection ─────────────────────────────────────────────────────────

  it('extracts a BFE number from "BFE: 1234567"', () => {
    const results = extractEntitiesFromText('Ejendommen BFE: 1234567 ligger i Aarhus.');
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('property');
    expect((results[0] as PropertyEntity).bfeNummer).toBe('1234567');
  });

  it('extracts a BFE number from lowercase "bfe 123456"', () => {
    const results = extractEntitiesFromText('bfe 123456');
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('property');
  });

  it('deduplicates the same BFE appearing twice', () => {
    const results = extractEntitiesFromText('BFE: 1234567 og BFE: 1234567.');
    expect(results).toHaveLength(1);
  });

  // ── enhedsNummer detection ────────────────────────────────────────────────

  it('extracts an enhedsNummer from "enhed: 4000123456"', () => {
    const results = extractEntitiesFromText('Personen enhed: 4000123456 er direktør.');
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('person');
    expect((results[0] as PersonEntity).enhedsNummer).toBe('4000123456');
  });

  it('extracts an enhedsNummer from "enhedsNummer 4000123456"', () => {
    const results = extractEntitiesFromText('enhedsNummer 4000123456');
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('person');
    expect((results[0] as PersonEntity).enhedsNummer).toBe('4000123456');
  });

  it('deduplicates the same enhedsNummer appearing twice', () => {
    const results = extractEntitiesFromText('enhed: 4000123456 og enhed: 4000123456.');
    expect(results).toHaveLength(1);
  });

  // ── Mixed text ────────────────────────────────────────────────────────────

  it('extracts multiple entity types from a mixed AI response', () => {
    const text = [
      'Virksomheden med CVR: 12345678 ejer ejendommen BFE: 1234567.',
      'Direktøren har enhedsNummer 4000123456.',
    ].join(' ');

    const results = extractEntitiesFromText(text);
    expect(results).toHaveLength(3);

    const types = results.map((e) => e.type);
    expect(types).toContain('company');
    expect(types).toContain('property');
    expect(types).toContain('person');
  });

  it('preserves insertion order — CVR before BFE before enhedsNummer', () => {
    const text = 'CVR: 12345678, BFE: 7654321, enhedsNummer 4000111222.';
    const results = extractEntitiesFromText(text);
    expect(results[0].type).toBe('company');
    expect(results[1].type).toBe('property');
    expect(results[2].type).toBe('person');
  });

  it('returns entities with correct hrefs', () => {
    const text = 'CVR: 12345678 og BFE: 7654321 og enhed: 4000111222.';
    const results = extractEntitiesFromText(text);

    const company = results.find((e) => e.type === 'company') as CompanyEntity;
    const property = results.find((e) => e.type === 'property') as PropertyEntity;
    const person = results.find((e) => e.type === 'person') as PersonEntity;

    expect(company?.href).toBe('/dashboard/companies/12345678');
    expect(property?.href).toBe('/dashboard/ejendomme/7654321');
    expect(person?.href).toBe('/dashboard/owners/4000111222');
  });

  it('handles two different CVR numbers in one string', () => {
    const text = 'CVR: 11111111 og CVR: 22222222.';
    const results = extractEntitiesFromText(text);
    expect(results).toHaveLength(2);
    const cvrs = results.map((e) => (e as CompanyEntity).cvrNummer);
    expect(cvrs).toContain('11111111');
    expect(cvrs).toContain('22222222');
  });

  it('is safe to call multiple times — regex state is reset between calls', () => {
    const text = 'CVR: 12345678';
    const first = extractEntitiesFromText(text);
    const second = extractEntitiesFromText(text);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });
});
