/**
 * Unit tests for crossChecks — BIZZ-1372/1373/1374.
 *
 * Tests for pure functions (detectKlyngerisiko, detectRestaurantKrav,
 * detectAnbefalinger). BBR/Tinglysning/VUR cross-checks require
 * live API calls and are tested via E2E.
 */

import { describe, it, expect } from 'vitest';
import {
  detectKlyngerisiko,
  detectRestaurantKrav,
  detectAnbefalinger,
} from '@/app/lib/forsikring/crossChecks';
import type { Aktiv } from '@/app/lib/forsikring/koncernWalk';
import type { MatchResult } from '@/app/lib/forsikring/assetMatcher';
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
    sum_insured_dkk: 5_000_000,
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

/** Helper: match-result factory */
function makeMatch(aktiv: Aktiv, policy: ForsikringPolicy | null = null, score = 90): MatchResult {
  return {
    aktiv,
    bestMatch: policy ? { policy, score } : null,
    candidates: policy ? [{ policy, score }] : [],
  };
}

describe('detectKlyngerisiko', () => {
  it('flagger når > 50% af sum er i ét postnummer', () => {
    const matches: MatchResult[] = [
      makeMatch(
        { type: 'ejendom', label: 'A', adresse: 'Stengade 7, 3000 Helsingør' },
        makePolicy({ sum_insured_dkk: 8_000_000, property_address: 'Stengade 7, 3000 Helsingør' })
      ),
      makeMatch(
        { type: 'ejendom', label: 'B', adresse: 'Gefionsvej 45, 3000 Helsingør' },
        makePolicy({
          id: 'pol-2',
          sum_insured_dkk: 4_000_000,
          property_address: 'Gefionsvej 45, 3000 Helsingør',
        })
      ),
      makeMatch(
        { type: 'ejendom', label: 'C', adresse: 'Vestergade 1, 2650 Hvidovre' },
        makePolicy({
          id: 'pol-3',
          sum_insured_dkk: 2_000_000,
          property_address: 'Vestergade 1, 2650 Hvidovre',
        })
      ),
    ];
    const aktiver = matches.map((m) => m.aktiv);
    const gaps = detectKlyngerisiko(aktiver, matches);

    // 3000 har 12M/14M = 85% → flagger
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0].check_id).toBe('GAP-105');
  });

  it('flagger ikke når jævnt fordelt', () => {
    const matches: MatchResult[] = [
      makeMatch(
        { type: 'ejendom', label: 'A', adresse: 'Stengade 7, 3000 Helsingør' },
        makePolicy({ sum_insured_dkk: 5_000_000 })
      ),
      makeMatch(
        { type: 'ejendom', label: 'B', adresse: 'Vestergade 1, 2650 Hvidovre' },
        makePolicy({
          id: 'pol-2',
          sum_insured_dkk: 5_000_000,
          property_address: 'Vestergade 1, 2650 Hvidovre',
        })
      ),
    ];
    const gaps = detectKlyngerisiko(
      matches.map((m) => m.aktiv),
      matches
    );
    expect(gaps).toHaveLength(0); // 50/50 → ikke > 50%
  });
});

describe('detectRestaurantKrav', () => {
  it('flagger restaurant-ejendom', () => {
    const matches: MatchResult[] = [
      makeMatch(
        { type: 'ejendom', label: 'Stengade 7' },
        makePolicy({ business_activity: 'Restaurant og café' })
      ),
    ];
    const gaps = detectRestaurantKrav(
      matches.map((m) => m.aktiv),
      matches
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0].check_id).toBe('GAP-106');
  });

  it('flagger ikke ikke-restaurant', () => {
    const matches: MatchResult[] = [
      makeMatch(
        { type: 'ejendom', label: 'Kontor' },
        makePolicy({ business_activity: 'Kontorejendom' })
      ),
    ];
    const gaps = detectRestaurantKrav(
      matches.map((m) => m.aktiv),
      matches
    );
    expect(gaps).toHaveLength(0);
  });
});

describe('detectAnbefalinger', () => {
  it('anbefaler D&O for A/S bestyrelsespost', () => {
    const aktiver: Aktiv[] = [
      { type: 'bestyrelsespost', label: 'Bestyrelse', rawData: { virksomhedsform: 'A/S' } },
    ];
    const matches: MatchResult[] = [makeMatch(aktiver[0], makePolicy())];
    const gaps = detectAnbefalinger(aktiver, matches);
    expect(gaps.find((g) => g.check_id === 'GAP-107')).toBeDefined();
  });

  it('anbefaler driftstab for udlejning', () => {
    const aktiver: Aktiv[] = [{ type: 'ejendom', label: 'Udlejning' }];
    const matches: MatchResult[] = [
      makeMatch(aktiver[0], makePolicy({ business_activity: 'Udlejning af erhvervsejendom' })),
    ];
    const gaps = detectAnbefalinger(aktiver, matches);
    expect(gaps.find((g) => g.check_id === 'GAP-109')).toBeDefined();
  });

  it('anbefaler cyber for virksomhed med ansatte', () => {
    const aktiver: Aktiv[] = [{ type: 'virksomhed', label: 'Test ApS', ansatte: 10 }];
    const matches: MatchResult[] = [makeMatch(aktiver[0], makePolicy())];
    const gaps = detectAnbefalinger(aktiver, matches);
    expect(gaps.find((g) => g.check_id === 'GAP-108')).toBeDefined();
  });
});
