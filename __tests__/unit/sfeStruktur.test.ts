/**
 * Unit tests for sfeStruktur (BIZZ-2096) — SFE-struktur-arv af police-dækning.
 *
 * Tester den rene arve-regel applySfeArv: aktiver i en SFE der er dækket af
 * en police på SFE-adressen får nedarvet match (score 75) + transparent
 * markering i rawData, mens direkte matches og fremmede SFE'er ikke røres.
 */

import { describe, it, expect } from 'vitest';
import { applySfeArv, SFE_ARV_SCORE } from '@/app/lib/forsikring/sfeStruktur';
import type { AktivSfeMap, PolicySfeMap } from '@/app/lib/forsikring/sfeStruktur';
import type { MatchResult } from '@/app/lib/forsikring/assetMatcher';
import type { Aktiv } from '@/app/lib/forsikring/koncernWalk';
import type { ForsikringPolicy } from '@/app/lib/forsikring/types';

/** Minimal policy-fixture (BELVEDERE-scenariet fra ticketen) */
function makePolicy(overrides: Partial<ForsikringPolicy> = {}): ForsikringPolicy {
  return {
    id: 'pol-1',
    tenant_id: 'tenant-1',
    document_id: null,
    policy_number: '50143392',
    insurer_name: 'Alm. Brand Forsikring A/S',
    insurer_cvr: '10526949',
    broker_name: null,
    policyholder_name: 'Belvedere Ejendomme A/S',
    policyholder_cvr: '24301117',
    policyholder_address: 'Torvegade 5, 3000 Helsingør',
    property_address: 'Gefionsvej 47A, 3000 Helsingør',
    property_matrikel: '65bp, Helsingør Markjorder',
    property_bfe: null,
    property_entity_id: null,
    business_activity: 'Udlejning af ejendomme',
    building_use: 'Beboelse',
    building_area_m2: null,
    building_floors: null,
    building_year_built: null,
    building_has_basement: null,
    insurance_form: 'nyvaerdi',
    sum_insured_dkk: null,
    annual_premium_dkk: null,
    general_deductible_dkk: null,
    effective_from: null,
    effective_to: null,
    main_renewal_date: null,
    policy_issued_date: null,
    raw_metadata: {},
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Ejendoms-aktiv fixture */
function makeAktiv(bfe: number, adresse: string): Aktiv {
  return { type: 'ejendom', label: adresse, bfe, adresse };
}

/** Umatchet MatchResult for et aktiv */
function unmatched(aktiv: Aktiv): MatchResult {
  return { aktiv, bestMatch: null, candidates: [] };
}

const SFE_BFE = 5322356; // Gefionsvej 47A / Fenrisvej 27A-B (matrikel 65bp)
const ANDEN_SFE = 5322351; // Fenrisvej 19 — egen SFE

describe('applySfeArv — BIZZ-2096', () => {
  it('nedarver dækning til umatchet aktiv i dækket SFE med score 75 og markering', () => {
    const policy = makePolicy();
    const matches: MatchResult[] = [
      unmatched(makeAktiv(SFE_BFE, 'Gefionsvej 47A, 3000 Helsingør')),
      unmatched(makeAktiv(123456, 'Fenrisvej 27A, 3000 Helsingør')),
    ];
    const aktivSfe: AktivSfeMap = new Map([
      [0, SFE_BFE],
      [1, SFE_BFE],
    ]);
    const policySfe: PolicySfeMap = new Map([
      [SFE_BFE, { policy, sfeAdresse: 'Gefionsvej 47A, 3000 Helsingør' }],
    ]);

    const inherited = applySfeArv(matches, aktivSfe, policySfe);

    expect(inherited).toBe(2);
    for (const m of matches) {
      expect(m.bestMatch?.policy.id).toBe('pol-1');
      expect(m.bestMatch?.score).toBe(SFE_ARV_SCORE);
      expect(
        (m.aktiv.rawData?.daekket_via_sfe as { sfe_bfe: number; sfe_adresse: string }).sfe_bfe
      ).toBe(SFE_BFE);
      expect((m.aktiv.rawData?.daekket_via_sfe as { sfe_adresse: string }).sfe_adresse).toBe(
        'Gefionsvej 47A, 3000 Helsingør'
      );
    }
  });

  it('nedarver IKKE til aktiv i en anden SFE (Fenrisvej 19 forbliver uforsikret)', () => {
    const matches: MatchResult[] = [
      unmatched(makeAktiv(ANDEN_SFE, 'Fenrisvej 19, 3000 Helsingør')),
    ];
    const aktivSfe: AktivSfeMap = new Map([[0, ANDEN_SFE]]);
    const policySfe: PolicySfeMap = new Map([
      [SFE_BFE, { policy: makePolicy(), sfeAdresse: 'Gefionsvej 47A, 3000 Helsingør' }],
    ]);

    const inherited = applySfeArv(matches, aktivSfe, policySfe);

    expect(inherited).toBe(0);
    expect(matches[0].bestMatch).toBeNull();
    expect(matches[0].aktiv.rawData?.daekket_via_sfe).toBeUndefined();
  });

  it('rører ikke direkte matches — direkte match vinder over arv', () => {
    const direktePolicy = makePolicy({ id: 'pol-direkte' });
    const matches: MatchResult[] = [
      {
        aktiv: makeAktiv(SFE_BFE, 'Gefionsvej 47A, 3000 Helsingør'),
        bestMatch: { policy: direktePolicy, score: 90 },
        candidates: [],
      },
    ];
    const aktivSfe: AktivSfeMap = new Map([[0, SFE_BFE]]);
    const policySfe: PolicySfeMap = new Map([
      [SFE_BFE, { policy: makePolicy(), sfeAdresse: 'Gefionsvej 47A, 3000 Helsingør' }],
    ]);

    const inherited = applySfeArv(matches, aktivSfe, policySfe);

    expect(inherited).toBe(0);
    expect(matches[0].bestMatch?.policy.id).toBe('pol-direkte');
    expect(matches[0].bestMatch?.score).toBe(90);
  });

  it('annoterer alle aktiver med sfe_bfe + sfe_niveau til UI-gruppering', () => {
    const matches: MatchResult[] = [
      unmatched(makeAktiv(SFE_BFE, 'Gefionsvej 47A, 3000 Helsingør')),
      unmatched(makeAktiv(123456, 'Fenrisvej 27B, 3000 Helsingør')),
    ];
    const aktivSfe: AktivSfeMap = new Map([
      [0, SFE_BFE],
      [1, SFE_BFE],
    ]);

    applySfeArv(matches, aktivSfe, new Map());

    expect(matches[0].aktiv.rawData?.sfe_bfe).toBe(SFE_BFE);
    expect(matches[0].aktiv.rawData?.sfe_niveau).toBe('sfe');
    expect(matches[1].aktiv.rawData?.sfe_bfe).toBe(SFE_BFE);
    expect(matches[1].aktiv.rawData?.sfe_niveau).toBe('underliggende');
  });

  it('springer ikke-ejendom-aktiver over selv ved SFE-opslag', () => {
    const virksomhed: Aktiv = { type: 'virksomhed', label: 'Belvedere', cvr: '24301117' };
    const matches: MatchResult[] = [{ aktiv: virksomhed, bestMatch: null, candidates: [] }];
    const aktivSfe: AktivSfeMap = new Map([[0, SFE_BFE]]);
    const policySfe: PolicySfeMap = new Map([
      [SFE_BFE, { policy: makePolicy(), sfeAdresse: 'Gefionsvej 47A, 3000 Helsingør' }],
    ]);

    expect(applySfeArv(matches, aktivSfe, policySfe)).toBe(0);
    expect(matches[0].bestMatch).toBeNull();
  });

  it('bevarer eksisterende rawData ved annotering', () => {
    const aktiv = makeAktiv(123456, 'Fenrisvej 27A, 3000 Helsingør');
    aktiv.rawData = { ejer_cvr: '24301117' };
    const matches: MatchResult[] = [unmatched(aktiv)];
    const aktivSfe: AktivSfeMap = new Map([[0, SFE_BFE]]);
    const policySfe: PolicySfeMap = new Map([
      [SFE_BFE, { policy: makePolicy(), sfeAdresse: 'Gefionsvej 47A, 3000 Helsingør' }],
    ]);

    applySfeArv(matches, aktivSfe, policySfe);

    expect(matches[0].aktiv.rawData?.ejer_cvr).toBe('24301117');
    expect(matches[0].aktiv.rawData?.sfe_bfe).toBe(SFE_BFE);
  });
});
