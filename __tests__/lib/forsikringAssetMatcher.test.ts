/**
 * BIZZ-1529: Unit tests for forsikring/assetMatcher.
 *
 * Dækker scoreEjendom, scoreVirksomhed, scoreBil, scoreBestyrelsespost
 * + matchAssetsToPolicies dispatch. Specifikt verificeret:
 * - BIZZ-1488/1492/1552 CVR-fallback (uden bad policyholder_address fallback)
 * - BIZZ-1393 husnr-bogstav normalisering ("47 a" → "47a")
 * - BIZZ-1441 etage/dør-tolerant match
 */
import { describe, it, expect } from 'vitest';
import { matchAssetsToPolicies } from '@/app/lib/forsikring/assetMatcher';
import type { Aktiv } from '@/app/lib/forsikring/koncernWalk';
import type { ForsikringPolicy } from '@/app/lib/forsikring/types';

/** Helper: bygger en minimal ForsikringPolicy med overskrivelige felter */
function makePolicy(overrides: Partial<ForsikringPolicy> = {}): ForsikringPolicy {
  return {
    id: 'p1',
    tenant_id: 't1',
    document_id: 'd1',
    policy_number: 'POL-001',
    insurer: 'Topdanmark',
    policyholder_name: 'Test ApS',
    policyholder_cvr: null,
    policyholder_address: null,
    property_address: null,
    property_bfe: null,
    business_activity: null,
    sum_insured_dkk: null,
    annual_premium_dkk: null,
    deductible_dkk: null,
    coverage_type: null,
    valid_from: null,
    valid_to: null,
    renewal_date: null,
    raw_metadata: null,
    parsed_at: new Date().toISOString(),
    ...overrides,
  } as ForsikringPolicy;
}

/** Helper: bygger en minimal Aktiv */
function makeAktiv(overrides: Partial<Aktiv> = {}): Aktiv {
  return {
    type: 'ejendom',
    label: 'Test ejendom',
    ...overrides,
  } as Aktiv;
}

describe('matchAssetsToPolicies — ejendom-matching', () => {
  it('BFE-match scorer 100 (eksakt match)', () => {
    const aktiv = makeAktiv({ bfe: 12345 });
    const policy = makePolicy({ property_bfe: '12345' });
    const [m] = matchAssetsToPolicies([aktiv], [policy]);
    expect(m.bestMatch?.score).toBe(100);
  });

  it('Eksakt adresse-match scorer 90', () => {
    const aktiv = makeAktiv({ adresse: 'Stengade 7, 3000 Helsingør' });
    const policy = makePolicy({ property_address: 'Stengade 7, 3000 Helsingør' });
    const [m] = matchAssetsToPolicies([aktiv], [policy]);
    expect(m.bestMatch?.score).toBe(90);
  });

  it('Adresse indeholder hinanden scorer 85', () => {
    const aktiv = makeAktiv({ adresse: 'Stengade 7, 3000 Helsingør' });
    const policy = makePolicy({ property_address: 'Stengade 7' });
    const [m] = matchAssetsToPolicies([aktiv], [policy]);
    expect(m.bestMatch?.score).toBe(85);
  });

  it('Etage/dør-tolerant match (BIZZ-1441) scorer 82', () => {
    const aktiv = makeAktiv({ adresse: 'Gefionsvej 47A, 1 sal th, 3000 Helsingør' });
    const policy = makePolicy({ property_address: 'Gefionsvej 47A, 3000 Helsingør' });
    const [m] = matchAssetsToPolicies([aktiv], [policy]);
    expect(m.bestMatch?.score).toBeGreaterThanOrEqual(82);
  });

  it('Husnr-bogstav normalisering (BIZZ-1393): "47 a" matcher "47a"', () => {
    const aktiv = makeAktiv({ adresse: 'Gefionsvej 47a, 3000 Helsingør' });
    const policy = makePolicy({ property_address: 'Gefionsvej 47 a, 3000 Helsingør' });
    const [m] = matchAssetsToPolicies([aktiv], [policy]);
    expect(m.bestMatch?.score).toBeGreaterThan(0);
  });

  it('CVR-fallback (BIZZ-1488/1492/1552): tom property_address, matchende CVR', () => {
    const aktiv = makeAktiv({
      bfe: 999,
      adresse: 'Søbyvej 11, 2650 Hvidovre',
      rawData: { ejer_cvr: '24301117' },
    });
    const policy = makePolicy({
      policyholder_cvr: '24301117',
      policyholder_address: null,
      property_address: null,
    });
    const [m] = matchAssetsToPolicies([aktiv], [policy]);
    expect(m.bestMatch?.score).toBe(55); // CVR-fallback
  });

  it('CVR-fallback når adresse-match fejler men CVR matcher', () => {
    const aktiv = makeAktiv({
      adresse: 'Søbyvej 11, 2650 Hvidovre',
      rawData: { ejer_cvr: '24301117' },
    });
    const policy = makePolicy({
      policyholder_cvr: '24301117',
      property_address: 'Helt anden vej 99, 9999 Andenby',
    });
    const [m] = matchAssetsToPolicies([aktiv], [policy]);
    // Adresse-match fejler → CVR-fallback → 55
    expect(m.bestMatch?.score).toBe(55);
  });

  it('BIZZ-1488/1492/1552: bruger IKKE policyholder_address som adresse-fallback', () => {
    const aktiv = makeAktiv({ adresse: 'Gefionsvej 47A, 3000 Helsingør' });
    const policy = makePolicy({
      // policyholder_address er virksomhedens HQ — må aldrig matche en ejendom
      policyholder_address: 'Belvedere Ejendomme A/S, København S',
      property_address: null,
    });
    const [m] = matchAssetsToPolicies([aktiv], [policy]);
    // Ingen match: property_address er tom, policyholder_address bruges IKKE
    expect(m.bestMatch).toBeNull();
  });

  it('Returnerer null bestMatch under MATCH_THRESHOLD (50)', () => {
    const aktiv = makeAktiv({ adresse: 'Gefionsvej 47A' });
    const policy = makePolicy({ property_address: 'Gefionsvej 99B' });
    const [m] = matchAssetsToPolicies([aktiv], [policy]);
    // Kun vejnavn matcher → score 40 → under threshold
    expect(m.bestMatch).toBeNull();
  });

  it('Sorterer kandidater efter score (højeste først)', () => {
    const aktiv = makeAktiv({ bfe: 1, adresse: 'Stengade 7' });
    const exactBfe = makePolicy({ id: 'p1', property_bfe: '1' });
    const exactAddr = makePolicy({ id: 'p2', property_address: 'Stengade 7' });
    const [m] = matchAssetsToPolicies([aktiv], [exactAddr, exactBfe]);
    expect(m.candidates[0].policy.id).toBe('p1'); // BFE=100 > addr=90
    expect(m.candidates[1].policy.id).toBe('p2');
  });
});

describe('matchAssetsToPolicies — virksomhed-matching', () => {
  it('CVR-match scorer 100', () => {
    const aktiv = makeAktiv({ type: 'virksomhed', cvr: '12345678' });
    const policy = makePolicy({ policyholder_cvr: '12345678' });
    const [m] = matchAssetsToPolicies([aktiv], [policy]);
    expect(m.bestMatch?.score).toBe(100);
  });

  it('Navn-match scorer 75', () => {
    const aktiv = makeAktiv({ type: 'virksomhed', label: 'BizzAssist ApS' });
    const policy = makePolicy({ policyholder_name: 'BizzAssist ApS' });
    const [m] = matchAssetsToPolicies([aktiv], [policy]);
    expect(m.bestMatch?.score).toBe(75);
  });

  it('Delvis navne-match scorer 60', () => {
    const aktiv = makeAktiv({ type: 'virksomhed', label: 'BizzAssist Holding ApS' });
    const policy = makePolicy({ policyholder_name: 'BizzAssist Holding' });
    const [m] = matchAssetsToPolicies([aktiv], [policy]);
    expect(m.bestMatch?.score).toBe(60);
  });
});

describe('matchAssetsToPolicies — bil-matching', () => {
  it('Registreringsnr-match scorer 100', () => {
    const aktiv = makeAktiv({ type: 'bil', regnr: 'AB12345' });
    const policy = makePolicy({
      property_address: 'Bil med reg AB12345',
    });
    const [m] = matchAssetsToPolicies([aktiv], [policy]);
    expect(m.bestMatch?.score).toBe(100);
  });

  it('Ingen regnr giver score 0', () => {
    const aktiv = makeAktiv({ type: 'bil', regnr: undefined });
    const policy = makePolicy();
    const [m] = matchAssetsToPolicies([aktiv], [policy]);
    expect(m.bestMatch).toBeNull();
  });
});

describe('matchAssetsToPolicies — bestyrelsespost-matching', () => {
  it('D&O policy med CVR-match scorer 100', () => {
    const aktiv = makeAktiv({ type: 'bestyrelsespost', cvr: '12345678' });
    const policy = makePolicy({
      policyholder_cvr: '12345678',
      business_activity: 'D&O bestyrelsesansvar',
    });
    const [m] = matchAssetsToPolicies([aktiv], [policy]);
    expect(m.bestMatch?.score).toBe(100);
  });

  it('Ikke-D&O policy ignoreres', () => {
    const aktiv = makeAktiv({ type: 'bestyrelsespost', cvr: '12345678' });
    const policy = makePolicy({
      policyholder_cvr: '12345678',
      business_activity: 'Bygningsforsikring',
    });
    const [m] = matchAssetsToPolicies([aktiv], [policy]);
    expect(m.bestMatch).toBeNull();
  });
});

describe('matchAssetsToPolicies — edge cases', () => {
  it('Tom aktiver-array returnerer tomt array', () => {
    const result = matchAssetsToPolicies([], [makePolicy()]);
    expect(result).toEqual([]);
  });

  it('Tom policer-array gør alle aktiver uforsikrede', () => {
    const result = matchAssetsToPolicies([makeAktiv()], []);
    expect(result).toHaveLength(1);
    expect(result[0].bestMatch).toBeNull();
  });

  it('Aktiv uden bfe + adresse + CVR matcher intet', () => {
    const aktiv = makeAktiv({ bfe: undefined, adresse: undefined, label: 'BFE 12345' });
    const policy = makePolicy({ property_address: 'Stengade 7' });
    const [m] = matchAssetsToPolicies([aktiv], [policy]);
    expect(m.bestMatch).toBeNull();
  });
});
