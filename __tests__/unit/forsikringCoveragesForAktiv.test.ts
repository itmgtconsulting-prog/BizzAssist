/**
 * BIZZ-2121: Unit-tests for coveragesForAktiv — den grønne "Dækket"-boks skal
 * for virksomheds-aktiver aggregere dækninger fra ALLE kundens policer
 * (policyholder_cvr-match), ikke kun den ene matched_policy_id (DBRAMANTE-
 * casen: "Dækket (3)" trods 30+ dækninger på 6 delpolicer).
 */
import { describe, it, expect } from 'vitest';
import { coveragesForAktiv } from '@/app/dashboard/forsikring/ForsikringPageClient';

/** Bygger et minimalt AnalyseAktiv til testene */
function makeAktiv(over: Partial<Parameters<typeof coveragesForAktiv>[0]> = {}) {
  return {
    id: 'a1',
    type: 'virksomhed',
    label: 'DBRAMANTE1928 ApS',
    bfe: null,
    cvr: '34601704',
    adresse: null,
    matched_policy_id: 'pol-transport',
    match_score: 90,
    raw_data: null,
    ...over,
  };
}

/** Bygger en minimal AnalysePolicy */
function makePolicy(id: string, policyholderCvr: string | null) {
  return {
    id,
    policy_number: id,
    insurer_name: 'Topdanmark',
    business_activity: null,
    property_address: null,
    annual_premium_dkk: null,
    sum_insured_dkk: null,
    policyholder_cvr: policyholderCvr,
  };
}

/** Bygger en minimal AnalyseCoverage */
function makeCov(policyId: string, code: string, sum: number | null = null) {
  return {
    policy_id: policyId,
    coverage_code: code,
    coverage_label: code,
    is_covered: true,
    sum_dkk: sum,
    deductible_dkk: null,
  };
}

describe('coveragesForAktiv (BIZZ-2121)', () => {
  const covByPolicy = new Map([
    ['pol-transport', [makeCov('pol-transport', 'transport', 2717329)]],
    [
      'pol-driftstab',
      [
        makeCov('pol-driftstab', 'driftstab', 20459785),
        makeCov('pol-driftstab', 'leverandoer_aftager', 550000),
      ],
    ],
    ['pol-cyber', [makeCov('pol-cyber', 'cyber', 1116693)]],
    ['pol-anden-kunde', [makeCov('pol-anden-kunde', 'brand_el', 1)]],
  ]);
  const policies = [
    makePolicy('pol-transport', '34601704'),
    makePolicy('pol-driftstab', '34601704'),
    makePolicy('pol-cyber', '34601704'),
    makePolicy('pol-anden-kunde', '12345678'),
    makePolicy('pol-uden-cvr', null),
  ];

  it('aggregerer alle kundens policer for virksomheds-aktiv — ikke kun matched', () => {
    const res = coveragesForAktiv(makeAktiv(), policies, covByPolicy);
    const codes = res.map((c) => c.coverage_code).sort();
    expect(codes).toEqual(['cyber', 'driftstab', 'leverandoer_aftager', 'transport']);
  });

  it('medtager IKKE andre kunders policer', () => {
    const res = coveragesForAktiv(makeAktiv(), policies, covByPolicy);
    expect(res.some((c) => c.coverage_code === 'brand_el')).toBe(false);
  });

  it('ejendoms-aktiver viser fortsat kun den matchede polices dækninger', () => {
    const res = coveragesForAktiv(
      makeAktiv({ type: 'ejendom', bfe: 123, matched_policy_id: 'pol-transport' }),
      policies,
      covByPolicy
    );
    expect(res).toHaveLength(1);
    expect(res[0].coverage_code).toBe('transport');
  });

  it('falder tilbage til matched police når CVR ikke matcher nogen policer', () => {
    const res = coveragesForAktiv(makeAktiv({ cvr: '99999999' }), policies, covByPolicy);
    expect(res).toHaveLength(1);
    expect(res[0].coverage_code).toBe('transport');
  });

  it('virksomhed uden matched_policy_id får stadig kundens policer aggregeret', () => {
    const res = coveragesForAktiv(makeAktiv({ matched_policy_id: null }), policies, covByPolicy);
    const codes = res.map((c) => c.coverage_code).sort();
    expect(codes).toEqual(['cyber', 'driftstab', 'leverandoer_aftager', 'transport']);
  });
});
