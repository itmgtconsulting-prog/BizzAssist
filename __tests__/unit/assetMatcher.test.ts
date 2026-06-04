/**
 * Unit tests for assetMatcher — BIZZ-1363.
 */

import { describe, it, expect } from 'vitest';
import { matchAssetsToPolicies, addressesMatch } from '@/app/lib/forsikring/assetMatcher';
import type { Aktiv } from '@/app/lib/forsikring/koncernWalk';
import type { ForsikringPolicy } from '@/app/lib/forsikring/types';

/** Minimal policy factory */
function makePolicy(overrides: Partial<ForsikringPolicy> = {}): ForsikringPolicy {
  return {
    id: 'pol-1',
    tenant_id: 't-1',
    document_id: null,
    policy_number: '50143392',
    insurer_name: 'Alm. Brand',
    insurer_cvr: null,
    broker_name: null,
    policyholder_name: 'Belvedere Ejendomme A/S',
    policyholder_cvr: '24301117',
    policyholder_address: null,
    property_address: 'Stengade 7, 3000 Helsingør',
    property_matrikel: null,
    property_bfe: null,
    property_entity_id: null,
    business_activity: null,
    building_use: null,
    building_area_m2: null,
    building_floors: null,
    building_year_built: null,
    building_has_basement: null,
    insurance_form: null,
    sum_insured_dkk: null,
    annual_premium_dkk: null,
    general_deductible_dkk: null,
    effective_from: null,
    effective_to: null,
    main_renewal_date: null,
    policy_issued_date: null,
    raw_metadata: {},
    created_by: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...overrides,
  };
}

describe('matchAssetsToPolicies', () => {
  it('matches ejendom via BFE (score 100)', () => {
    const aktiver: Aktiv[] = [{ type: 'ejendom', label: 'BFE 237451', bfe: 237451 }];
    const policer = [makePolicy({ property_bfe: '237451' })];
    const results = matchAssetsToPolicies(aktiver, policer);
    expect(results[0].bestMatch?.score).toBe(100);
  });

  it('matches ejendom via adresse (score 90)', () => {
    const aktiver: Aktiv[] = [
      { type: 'ejendom', label: 'Stengade 7', adresse: 'Stengade 7, 3000 Helsingør' },
    ];
    const policer = [makePolicy({ property_address: 'Stengade 7, 3000 Helsingør' })];
    const results = matchAssetsToPolicies(aktiver, policer);
    expect(results[0].bestMatch?.score).toBe(90);
  });

  it('matches ejendom via delvis adresse — husnr-prefix 47A vs 47 (score 70)', () => {
    const aktiver: Aktiv[] = [
      { type: 'ejendom', label: 'Gefionsvej 47A', adresse: 'Gefionsvej 47A, 3000 Helsingør' },
    ];
    const policer = [makePolicy({ property_address: 'Gefionsvej 47, 3000 Helsingør' })];
    const results = matchAssetsToPolicies(aktiver, policer);
    // BIZZ-1393: "47a" starts with "47" → husnr-prefix match = 70
    expect(results[0].bestMatch?.score).toBe(70);
  });

  it('returns null bestMatch for uforsikret (score < 50)', () => {
    const aktiver: Aktiv[] = [
      { type: 'ejendom', label: 'Ukendt vej 99', adresse: 'Ukendt vej 99, 9999 Ingensteds' },
    ];
    const policer = [makePolicy()];
    const results = matchAssetsToPolicies(aktiver, policer);
    expect(results[0].bestMatch).toBeNull();
  });

  it('matches virksomhed via CVR (score 100)', () => {
    const aktiver: Aktiv[] = [
      { type: 'virksomhed', label: 'Belvedere Ejendomme A/S', cvr: '24301117' },
    ];
    const policer = [makePolicy({ policyholder_cvr: '24301117' })];
    const results = matchAssetsToPolicies(aktiver, policer);
    expect(results[0].bestMatch?.score).toBe(100);
  });

  it('matches virksomhed via navn (score 75)', () => {
    const aktiver: Aktiv[] = [
      { type: 'virksomhed', label: 'Belvedere Ejendomme A/S', cvr: '99999999' },
    ];
    const policer = [makePolicy({ policyholder_cvr: null })];
    const results = matchAssetsToPolicies(aktiver, policer);
    expect(results[0].bestMatch?.score).toBe(75);
  });

  it('returns candidates sorted by score (highest first)', () => {
    const aktiver: Aktiv[] = [
      { type: 'ejendom', label: 'Stengade 7', bfe: 237451, adresse: 'Stengade 7, 3000 Helsingør' },
    ];
    const policer = [
      makePolicy({
        id: 'pol-addr',
        property_address: 'Stengade 7, 3000 Helsingør',
        property_bfe: null,
      }),
      makePolicy({ id: 'pol-bfe', property_bfe: '237451', property_address: null }),
    ];
    const results = matchAssetsToPolicies(aktiver, policer);
    expect(results[0].candidates.length).toBe(2);
    expect(results[0].bestMatch?.policy.id).toBe('pol-bfe'); // BFE = 100 > adresse = 90
  });

  it('handles empty policer array', () => {
    const aktiver: Aktiv[] = [{ type: 'ejendom', label: 'Test', bfe: 123 }];
    const results = matchAssetsToPolicies(aktiver, []);
    expect(results[0].bestMatch).toBeNull();
    expect(results[0].candidates).toHaveLength(0);
  });

  it('handles empty aktiver array', () => {
    const results = matchAssetsToPolicies([], [makePolicy()]);
    expect(results).toHaveLength(0);
  });

  it('is idempotent', () => {
    const aktiver: Aktiv[] = [{ type: 'ejendom', label: 'Test', bfe: 237451 }];
    const policer = [makePolicy({ property_bfe: '237451' })];
    const r1 = matchAssetsToPolicies(aktiver, policer);
    const r2 = matchAssetsToPolicies(aktiver, policer);
    expect(r1[0].bestMatch?.score).toBe(r2[0].bestMatch?.score);
  });
});

describe('addressesMatch (BIZZ-1973)', () => {
  it('matcher identiske adresser', () => {
    expect(
      addressesMatch('Stjernegade 17A, 3000 Helsingør', 'Stjernegade 17A, 3000 Helsingør')
    ).toBe(true);
  });

  it('er husnummer-bogstav-agnostisk: "Stjernegade 17" = "Stjernegade 17A"', () => {
    expect(
      addressesMatch('Stjernegade 17, 3000 Helsingør', 'Stjernegade 17A, 3000 Helsingør')
    ).toBe(true);
  });

  it('matcher trods manglende postnr på den ene side', () => {
    expect(addressesMatch('Stengade 7', 'Stengade 7, 3000 Helsingør')).toBe(true);
  });

  it('matcher æ/ø/å mod ae/oe/aa-stavning', () => {
    expect(
      addressesMatch('Gefionsvej 47A, 3000 Helsingør', 'Gefionsvej 47a, 3000 Helsingoer')
    ).toBe(true);
  });

  it('matcher trods etage/dør-forskel', () => {
    expect(
      addressesMatch('Kaffevej 31, 3000 Helsingør', 'Kaffevej 31, 1. tv, 3000 Helsingør')
    ).toBe(true);
  });

  it('matcher IKKE forskellige veje (Torvegade 5A vs Stjernegade 17A)', () => {
    expect(addressesMatch('Torvegade 5A, 3000 Helsingør', 'Stjernegade 17A, 3000 Helsingør')).toBe(
      false
    );
  });

  it('matcher IKKE samme vej+husnr i forskellige byer (postnr afviger)', () => {
    expect(addressesMatch('Hovedgade 5, 3000 Helsingør', 'Hovedgade 5, 8000 Aarhus')).toBe(false);
  });

  it('matcher IKKE forskelligt husnummer på samme vej', () => {
    expect(addressesMatch('Stengade 7, 3000 Helsingør', 'Stengade 48, 3000 Helsingør')).toBe(false);
  });

  it('returnerer false for tom/null input', () => {
    expect(addressesMatch(null, 'Stengade 7')).toBe(false);
    expect(addressesMatch('Stengade 7', '')).toBe(false);
  });
});
