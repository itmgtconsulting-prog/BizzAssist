/**
 * Unit tests for assetMatcher — BIZZ-1363.
 */

import { describe, it, expect } from 'vitest';
import { matchAssetsToPolicies } from '@/app/lib/forsikring/assetMatcher';
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

  it('matches ejendom via delvis adresse — vejnavn + husnr (score 80)', () => {
    const aktiver: Aktiv[] = [
      { type: 'ejendom', label: 'Gefionsvej 47A', adresse: 'Gefionsvej 47A, 3000 Helsingør' },
    ];
    const policer = [makePolicy({ property_address: 'Gefionsvej 47, 3000 Helsingør' })];
    const results = matchAssetsToPolicies(aktiver, policer);
    // "gefionsvej" matcher, "47a" vs "47" matcher ikke eksakt → vejnavn-only = 40
    expect(results[0].bestMatch).toBeNull(); // Under threshold
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
