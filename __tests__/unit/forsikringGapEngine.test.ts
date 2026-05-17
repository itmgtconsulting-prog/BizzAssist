/**
 * Unit tests for app/lib/forsikring/gapEngine.ts.
 *
 * Dækker:
 *   - BBR areal-mismatch threshold (15%)
 *   - Manglende standarddækninger (glas, sanitet, insekt/svamp, restværdi, stikledning)
 *   - Ældre bygning skærper insekt/svamp severity til critical
 *   - Aftale udløbet vs. udløber snart
 *   - Hovedforfald inden for varslingsperioden
 *   - BBR-anvendelse vs. police-virksomhedsart heuristik
 *   - countBySeverity tæller korrekt
 */
import { describe, it, expect } from 'vitest';
import {
  runGapEngine,
  countBySeverity,
  computeRiskScore,
  riskLabel,
  runPortfolioChecks,
} from '@/app/lib/forsikring/gapEngine';
import type { PortfolioCheckInput } from '@/app/lib/forsikring/gapEngine';
import type {
  BbrPropertyFacts,
  ForsikringCoverage,
  ForsikringPolicy,
  GapEngineInput,
} from '@/app/lib/forsikring/types';
import type { Aktiv } from '@/app/lib/forsikring/koncernWalk';
import type { MatchResult } from '@/app/lib/forsikring/assetMatcher';

// ─── Test fixtures ────────────────────────────────────────────────

/**
 * Create a baseline policy with all required fields filled in.
 * Tests override specific fields to trigger individual checks.
 */
function makePolicy(overrides: Partial<ForsikringPolicy> = {}): ForsikringPolicy {
  return {
    id: 'pol-1',
    tenant_id: 'tenant-1',
    document_id: null,
    policy_number: '50143392',
    insurer_name: 'Alm. Brand Forsikring A/S',
    insurer_cvr: '10526949',
    broker_name: 'RTM A/S',
    policyholder_name: 'Belvedere Ejendomme A/S',
    policyholder_cvr: '24301117',
    policyholder_address: 'Torvegade 5, 3000 Helsingør',
    property_address: 'Stengade 7, 3000 Helsingør',
    property_matrikel: '498 A, Helsingør Bygrunde',
    property_bfe: null,
    property_entity_id: null,
    business_activity: 'Restaurant og café',
    building_use: 'Restaurant',
    building_area_m2: 83,
    building_floors: 2,
    building_year_built: 1900,
    building_has_basement: true,
    insurance_form: 'nyvaerdi',
    sum_insured_dkk: null,
    annual_premium_dkk: 5716,
    general_deductible_dkk: 9475,
    effective_from: '2022-08-01',
    effective_to: '2028-03-31',
    main_renewal_date: '2026-04-01',
    policy_issued_date: '2022-07-08',
    raw_metadata: {},
    created_by: null,
    created_at: '2022-07-08T00:00:00Z',
    updated_at: '2022-07-08T00:00:00Z',
    ...overrides,
  };
}

/** Create a coverage row */
function makeCoverage(code: string, isCovered = true, label?: string): ForsikringCoverage {
  return {
    id: `cov-${code}`,
    tenant_id: 'tenant-1',
    policy_id: 'pol-1',
    coverage_code: code,
    coverage_label: label ?? code,
    is_covered: isCovered,
    sum_dkk: null,
    deductible_dkk: null,
    conditions_ref: null,
    notes: null,
    created_at: '2022-07-08T00:00:00Z',
  };
}

/** All 5 standard MVP coverages we care about for "fully covered" tests */
const FULL_COVERAGE_SET: ForsikringCoverage[] = [
  makeCoverage('brand_el'),
  makeCoverage('bygningskasko'),
  makeCoverage('udvidet_roerskade'),
  makeCoverage('glas'),
  makeCoverage('sanitet'),
  makeCoverage('insekt_svamp'),
  makeCoverage('restvaerdi'),
  makeCoverage('stikledning'),
  makeCoverage('hus_grundejer_ansvar'),
];

function makeInput(overrides: Partial<GapEngineInput> = {}): GapEngineInput {
  return {
    policy: makePolicy(),
    coverages: FULL_COVERAGE_SET,
    bbr: null,
    asOfDate: new Date('2026-05-13'),
    ...overrides,
  };
}

// ─── BBR areal-mismatch ───────────────────────────────────────────

describe('runGapEngine — BBR areal-mismatch', () => {
  it('flagger ikke afvigelse <= 15%', () => {
    const bbr: BbrPropertyFacts = {
      bfe: '1234',
      matrikel: null,
      bebygget_areal_m2: 90, // 8.4% over police's 83
      antal_etager: null,
      opfoert_aar: null,
      has_kaelder: null,
      anvendelseskode: null,
      anvendelse_label: null,
      tag_materiale_kode: null,
    };
    const gaps = runGapEngine(makeInput({ bbr }));
    expect(gaps.find((g) => g.check_id === 'GAP-001')).toBeUndefined();
  });

  it('flagger afvigelse > 15% som critical', () => {
    const bbr: BbrPropertyFacts = {
      bfe: '1234',
      matrikel: null,
      bebygget_areal_m2: 110, // 32.5% over police's 83
      antal_etager: null,
      opfoert_aar: null,
      has_kaelder: null,
      anvendelseskode: null,
      anvendelse_label: null,
      tag_materiale_kode: null,
    };
    const gaps = runGapEngine(makeInput({ bbr }));
    const areaGap = gaps.find((g) => g.check_id === 'GAP-001');
    expect(areaGap).toBeDefined();
    expect(areaGap?.severity).toBe('critical');
  });

  it('springer over hvis bbr er null', () => {
    const gaps = runGapEngine(makeInput({ bbr: null }));
    expect(gaps.find((g) => g.check_id === 'GAP-001')).toBeUndefined();
  });

  it('springer over hvis policy_area er null', () => {
    const bbr: BbrPropertyFacts = {
      bfe: null,
      matrikel: null,
      bebygget_areal_m2: 100,
      antal_etager: null,
      opfoert_aar: null,
      has_kaelder: null,
      anvendelseskode: null,
      anvendelse_label: null,
      tag_materiale_kode: null,
    };
    const gaps = runGapEngine(makeInput({ policy: makePolicy({ building_area_m2: null }), bbr }));
    expect(gaps.find((g) => g.check_id === 'GAP-001')).toBeUndefined();
  });
});

// ─── Manglende dækninger ──────────────────────────────────────────

describe('runGapEngine — manglende dækninger', () => {
  it('flagger glas som warning når den mangler', () => {
    const coverages = FULL_COVERAGE_SET.filter((c) => c.coverage_code !== 'glas');
    const gaps = runGapEngine(makeInput({ coverages }));
    const glasGap = gaps.find((g) => g.check_id === 'GAP-010');
    expect(glasGap).toBeDefined();
    expect(glasGap?.severity).toBe('warning');
  });

  it('flagger sanitet som info når den mangler', () => {
    const coverages = FULL_COVERAGE_SET.filter((c) => c.coverage_code !== 'sanitet');
    const gaps = runGapEngine(makeInput({ coverages }));
    expect(gaps.find((g) => g.check_id === 'GAP-011')?.severity).toBe('info');
  });

  it('flagger insekt/svamp som warning på unge bygninger', () => {
    const coverages = FULL_COVERAGE_SET.filter((c) => c.coverage_code !== 'insekt_svamp');
    const gaps = runGapEngine(
      makeInput({
        coverages,
        policy: makePolicy({ building_year_built: 2010 }),
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-012')?.severity).toBe('warning');
  });

  it('skærper insekt/svamp til critical på bygninger >50 år', () => {
    const coverages = FULL_COVERAGE_SET.filter((c) => c.coverage_code !== 'insekt_svamp');
    const gaps = runGapEngine(
      makeInput({
        coverages,
        policy: makePolicy({ building_year_built: 1900 }),
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-012')?.severity).toBe('critical');
  });

  it('respekterer is_covered=false som "ikke dækket"', () => {
    const coverages = FULL_COVERAGE_SET.map((c) =>
      c.coverage_code === 'glas' ? { ...c, is_covered: false } : c
    );
    const gaps = runGapEngine(makeInput({ coverages }));
    expect(gaps.find((g) => g.check_id === 'GAP-010')).toBeDefined();
  });

  it('flagger restværdi og stikledning når begge mangler', () => {
    const coverages = FULL_COVERAGE_SET.filter(
      (c) => c.coverage_code !== 'restvaerdi' && c.coverage_code !== 'stikledning'
    );
    const gaps = runGapEngine(makeInput({ coverages }));
    expect(gaps.find((g) => g.check_id === 'GAP-013')).toBeDefined();
    expect(gaps.find((g) => g.check_id === 'GAP-014')).toBeDefined();
  });
});

// ─── Aftale-tjeks ─────────────────────────────────────────────────

describe('runGapEngine — aftale-tjeks', () => {
  it('flagger udløbet aftale som critical', () => {
    const policy = makePolicy({ effective_to: '2024-01-01' });
    const gaps = runGapEngine(makeInput({ policy }));
    const expGap = gaps.find((g) => g.check_id === 'GAP-030');
    expect(expGap?.severity).toBe('critical');
    expect(expGap?.title).toContain('udløbet');
  });

  it('flagger udløb inden for 30 dage som warning', () => {
    const policy = makePolicy({ effective_to: '2026-06-01' });
    const gaps = runGapEngine(makeInput({ policy, asOfDate: new Date('2026-05-13') }));
    const expGap = gaps.find((g) => g.check_id === 'GAP-030');
    expect(expGap?.severity).toBe('warning');
  });

  it('flagger ikke udløb 6+ måneder ude i fremtiden', () => {
    const policy = makePolicy({ effective_to: '2028-03-31' });
    const gaps = runGapEngine(makeInput({ policy, asOfDate: new Date('2026-05-13') }));
    expect(gaps.find((g) => g.check_id === 'GAP-030')).toBeUndefined();
  });

  it('flagger hovedforfald inden for varslingsperioden', () => {
    const policy = makePolicy({
      effective_to: '2030-01-01',
      main_renewal_date: '2026-07-01',
    });
    const gaps = runGapEngine(makeInput({ policy, asOfDate: new Date('2026-05-13') }));
    expect(gaps.find((g) => g.check_id === 'GAP-031')?.severity).toBe('info');
  });
});

// ─── BBR-anvendelse vs. business_activity ────────────────────────

describe('runGapEngine — anvendelse-mismatch', () => {
  it('flagger ikke når police og BBR har overlappende ord', () => {
    const bbr: BbrPropertyFacts = {
      bfe: null,
      matrikel: null,
      bebygget_areal_m2: 80, // close enough to police 83
      antal_etager: null,
      opfoert_aar: null,
      has_kaelder: null,
      anvendelseskode: null,
      anvendelse_label: 'Restaurant',
      tag_materiale_kode: null,
    };
    const gaps = runGapEngine(makeInput({ bbr }));
    expect(gaps.find((g) => g.check_id === 'GAP-040')).toBeUndefined();
  });

  it('flagger når der ikke er overlap mellem police og BBR', () => {
    const policy = makePolicy({ business_activity: 'Sprøjtelakering' });
    const bbr: BbrPropertyFacts = {
      bfe: null,
      matrikel: null,
      bebygget_areal_m2: 80,
      antal_etager: null,
      opfoert_aar: null,
      has_kaelder: null,
      anvendelseskode: null,
      anvendelse_label: 'Beboelse',
      tag_materiale_kode: null,
    };
    const gaps = runGapEngine(makeInput({ policy, bbr }));
    expect(gaps.find((g) => g.check_id === 'GAP-040')?.severity).toBe('warning');
  });
});

// ─── countBySeverity ─────────────────────────────────────────────

describe('countBySeverity', () => {
  it('tæller 0 for tom liste', () => {
    expect(countBySeverity([])).toEqual({ critical: 0, warning: 0, info: 0 });
  });

  it('tæller korrekt på tværs af severities', () => {
    const gaps = runGapEngine(
      makeInput({
        coverages: [makeCoverage('brand_el')], // mangler stort set alt
        policy: makePolicy({
          building_year_built: 1900,
          effective_to: '2024-01-01',
        }),
      })
    );
    const counts = countBySeverity(gaps);
    expect(counts.critical + counts.warning + counts.info).toBe(gaps.length);
    expect(counts.critical).toBeGreaterThan(0);
  });
});

// ─── BIZZ-1364: Asset-level checks ──────────────────────────────

describe('runGapEngine — asset-level checks', () => {
  it('GAP-100: flagger uforsikret aktiv (matchScore 0)', () => {
    const gaps = runGapEngine(
      makeInput({
        asset: { type: 'ejendom', vaerdiDkk: 2_000_000, matchScore: 0 },
      })
    );
    const gap = gaps.find((g) => g.check_id === 'GAP-100');
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe('critical'); // > 1M
  });

  it('GAP-100: flagger ikke når matchScore > 0', () => {
    const gaps = runGapEngine(
      makeInput({
        asset: { type: 'ejendom', vaerdiDkk: 500_000, matchScore: 90 },
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-100')).toBeUndefined();
  });

  it('GAP-100: warning for lav-værdi aktiv', () => {
    const gaps = runGapEngine(
      makeInput({
        asset: { type: 'ejendom', vaerdiDkk: 500_000, matchScore: 0 },
      })
    );
    const gap = gaps.find((g) => g.check_id === 'GAP-100');
    expect(gap?.severity).toBe('warning'); // < 1M
  });

  it('GAP-101: flagger underforsikret (sum < 90% af værdi)', () => {
    const gaps = runGapEngine(
      makeInput({
        policy: makePolicy({ sum_insured_dkk: 3_000_000 }),
        asset: { type: 'ejendom', vaerdiDkk: 5_000_000 },
      })
    );
    const gap = gaps.find((g) => g.check_id === 'GAP-101');
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe('critical'); // 60% < 70%
  });

  it('GAP-101: flagger ikke når sum >= 90% af værdi', () => {
    const gaps = runGapEngine(
      makeInput({
        policy: makePolicy({ sum_insured_dkk: 4_600_000 }),
        asset: { type: 'ejendom', vaerdiDkk: 5_000_000 },
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-101')).toBeUndefined();
  });

  it('GAP-102: flagger når hæftelser > forsikringssum', () => {
    const gaps = runGapEngine(
      makeInput({
        policy: makePolicy({ sum_insured_dkk: 3_000_000 }),
        asset: { type: 'ejendom', haeftelserDkk: 5_000_000 },
      })
    );
    const gap = gaps.find((g) => g.check_id === 'GAP-102');
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe('critical');
  });

  it('GAP-102: flagger ikke når sum >= hæftelser', () => {
    const gaps = runGapEngine(
      makeInput({
        policy: makePolicy({ sum_insured_dkk: 5_000_000 }),
        asset: { type: 'ejendom', haeftelserDkk: 3_000_000 },
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-102')).toBeUndefined();
  });

  it('GAP-103: flagger bestyrelsespost uden D&O', () => {
    const gaps = runGapEngine(
      makeInput({
        asset: { type: 'bestyrelsespost', virksomhedsform: 'A/S' },
      })
    );
    const gap = gaps.find((g) => g.check_id === 'GAP-103');
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe('critical'); // A/S
  });

  it('GAP-103: warning for ApS bestyrelsespost', () => {
    const gaps = runGapEngine(
      makeInput({
        asset: { type: 'bestyrelsespost', virksomhedsform: 'ApS' },
      })
    );
    const gap = gaps.find((g) => g.check_id === 'GAP-103');
    expect(gap?.severity).toBe('warning'); // ApS
  });

  it('GAP-103: flagger ikke for ejendom-aktiv', () => {
    const gaps = runGapEngine(
      makeInput({
        asset: { type: 'ejendom' },
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-103')).toBeUndefined();
  });

  it('ingen asset-checks når asset er undefined', () => {
    const gaps = runGapEngine(makeInput({}));
    const assetGaps = gaps.filter((g) =>
      ['GAP-100', 'GAP-101', 'GAP-102', 'GAP-103'].includes(g.check_id)
    );
    expect(assetGaps).toHaveLength(0);
  });
});

// ─── BIZZ-1365: Risk-scoring ────────────────────────────────────

describe('computeRiskScore', () => {
  it('returnerer base-score for GAP-100 (uforsikret)', () => {
    const gap = runGapEngine(
      makeInput({ asset: { type: 'ejendom', vaerdiDkk: 2_000_000, matchScore: 0 } })
    ).find((g) => g.check_id === 'GAP-100')!;
    expect(computeRiskScore(gap)).toBe(60); // base score
  });

  it('tilføjer +15 for bygning > 50 år', () => {
    const gap = runGapEngine(
      makeInput({ asset: { type: 'ejendom', vaerdiDkk: 2_000_000, matchScore: 0 } })
    ).find((g) => g.check_id === 'GAP-100')!;
    expect(computeRiskScore(gap, { type: 'ejendom', byggeaar: 1900 })).toBe(75);
  });

  it('tilføjer +20 for værdi > 10M', () => {
    const gap = runGapEngine(
      makeInput({ asset: { type: 'ejendom', vaerdiDkk: 15_000_000, matchScore: 0 } })
    ).find((g) => g.check_id === 'GAP-100')!;
    expect(computeRiskScore(gap, { type: 'ejendom', vaerdiDkk: 15_000_000 })).toBe(80);
  });

  it('capper ved 100', () => {
    const gap = runGapEngine(
      makeInput({ asset: { type: 'ejendom', vaerdiDkk: 15_000_000, matchScore: 0 } })
    ).find((g) => g.check_id === 'GAP-100')!;
    const score = computeRiskScore(gap, {
      type: 'ejendom',
      vaerdiDkk: 15_000_000,
      byggeaar: 1900,
      haeftelserDkk: 5_000_000,
    });
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe('riskLabel', () => {
  it('0-25 = lav', () => expect(riskLabel(20)).toBe('lav'));
  it('26-50 = middel', () => expect(riskLabel(40)).toBe('middel'));
  it('51-75 = høj', () => expect(riskLabel(60)).toBe('høj'));
  it('76-100 = kritisk', () => expect(riskLabel(85)).toBe('kritisk'));
});

// ─── BIZZ-1377: Branchekode-checks ─────────────────────────────

describe('runGapEngine — branchekode-checks', () => {
  it('GAP-050: flagger multibranche med uforsikret bibranche', () => {
    const gaps = runGapEngine(
      makeInput({
        policy: makePolicy({ business_activity: 'Ejendomsudlejning' }),
        branche: {
          hovedbranche: '681020',
          hovedbranche_tekst: 'Udlejning af erhvervsejendomme',
          bibrancher: [{ kode: '561010', tekst: 'Restauranter' }],
        },
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-050')).toBeDefined();
  });

  it('GAP-050: flagger ikke uden bibrancher', () => {
    const gaps = runGapEngine(
      makeInput({
        branche: {
          hovedbranche: '681020',
          hovedbranche_tekst: 'Udlejning',
          bibrancher: [],
        },
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-050')).toBeUndefined();
  });

  it('GAP-051: flagger højrisiko restaurant-branche', () => {
    const gaps = runGapEngine(
      makeInput({
        policy: makePolicy({ business_activity: 'Restaurant' }),
        branche: {
          hovedbranche: '561010',
          hovedbranche_tekst: 'Restauranter',
          bibrancher: [],
        },
      })
    );
    const gap = gaps.find((g) => g.check_id === 'GAP-051');
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe('critical');
  });

  it('GAP-052: flagger CVR/police-mismatch', () => {
    const gaps = runGapEngine(
      makeInput({
        policy: makePolicy({ business_activity: 'Kontorejendom' }),
        branche: {
          hovedbranche: '561010',
          hovedbranche_tekst: 'Restauranter og caféer',
          bibrancher: [],
        },
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-052')).toBeDefined();
  });

  it('GAP-052: flagger ikke ved overlap', () => {
    const gaps = runGapEngine(
      makeInput({
        policy: makePolicy({ business_activity: 'Restaurant og café' }),
        branche: {
          hovedbranche: '561010',
          hovedbranche_tekst: 'Restauranter',
          bibrancher: [],
        },
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-052')).toBeUndefined();
  });

  it('GAP-053: flagger holding med operationel bibranche', () => {
    const gaps = runGapEngine(
      makeInput({
        branche: {
          hovedbranche: '642020',
          hovedbranche_tekst: 'Holdingselskaber',
          bibrancher: [{ kode: '561010', tekst: 'Restaurant' }],
        },
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-053')).toBeDefined();
  });
});

// ─── Portefølje-checks ──────────────────────────────────────────

/** Helper: byg en minimal MatchResult */
function makeMatch(aktiv: Aktiv, policy?: ForsikringPolicy, score = 90): MatchResult {
  return {
    aktiv,
    bestMatch: policy ? { policy, score } : null,
    candidates: policy ? [{ policy, score }] : [],
  };
}

/** Helper: byg en portefølje-check input med fornuftige defaults */
function makePortfolioInput(overrides: Partial<PortfolioCheckInput> = {}): PortfolioCheckInput {
  return {
    aktiver: [],
    matches: [],
    policer: [],
    coveragesByPolicy: new Map(),
    ...overrides,
  };
}

describe('runPortfolioChecks — GAP-060: D&O for A/S', () => {
  it('flagger A/S uden D&O-police som critical', () => {
    const gaps = runPortfolioChecks(
      makePortfolioInput({
        policer: [makePolicy({ business_activity: 'Ejendomsudlejning' })],
        virksomhedsform: 'A/S',
      })
    );
    const gap = gaps.find((g) => g.check_id === 'GAP-060');
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe('critical');
  });

  it('flagger ApS som warning', () => {
    const gaps = runPortfolioChecks(
      makePortfolioInput({
        policer: [makePolicy()],
        virksomhedsform: 'ApS',
      })
    );
    const gap = gaps.find((g) => g.check_id === 'GAP-060');
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe('warning');
  });

  it('flagger ikke når D&O-police findes', () => {
    const gaps = runPortfolioChecks(
      makePortfolioInput({
        policer: [makePolicy({ raw_metadata: { type: 'D&O Bestyrelsesansvar' } })],
        virksomhedsform: 'A/S',
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-060')).toBeUndefined();
  });

  it('flagger ikke for enkeltmandsvirksomhed', () => {
    const gaps = runPortfolioChecks(
      makePortfolioInput({
        policer: [makePolicy()],
        virksomhedsform: 'Enkeltmandsvirksomhed',
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-060')).toBeUndefined();
  });
});

describe('runPortfolioChecks — GAP-061: Huslejetab per ejendom', () => {
  it('flagger manglende huslejetab for udlejningsselskab', () => {
    const pol = makePolicy();
    const ejendomme: Aktiv[] = Array.from({ length: 5 }, (_, i) => ({
      type: 'ejendom' as const,
      label: `BFE ${1000 + i}`,
      bfe: 1000 + i,
    }));
    const matches: MatchResult[] = ejendomme.map((a) => makeMatch(a, pol));
    const coveragesByPolicy = new Map<string, ForsikringCoverage[]>();
    // Kun 1 police har huslejetab
    coveragesByPolicy.set(pol.id, [makeCoverage('huslejetab', true)]);

    const gaps = runPortfolioChecks(
      makePortfolioInput({
        aktiver: ejendomme,
        matches,
        policer: [pol],
        coveragesByPolicy,
        branche: {
          hovedbranche: '681020',
          hovedbranche_tekst: 'Udlejning af ejendomme',
          bibrancher: [],
        },
      })
    );
    // Alle 5 matcher samme police der HAR huslejetab → 0 mangler
    // (dette er lidt forvirrende men korrekt — alle ejendomme matcher pol-1 som har huslejetab)
    expect(gaps.find((g) => g.check_id === 'GAP-061')).toBeUndefined();
  });

  it('flagger når ingen ejendomme har huslejetab-dækning', () => {
    const pol = makePolicy();
    const ejendomme: Aktiv[] = Array.from({ length: 5 }, (_, i) => ({
      type: 'ejendom' as const,
      label: `BFE ${1000 + i}`,
      bfe: 1000 + i,
    }));
    const matches: MatchResult[] = ejendomme.map((a) => makeMatch(a, pol));
    const coveragesByPolicy = new Map<string, ForsikringCoverage[]>();
    // Police har INGEN huslejetab
    coveragesByPolicy.set(pol.id, [makeCoverage('brand_el')]);

    const gaps = runPortfolioChecks(
      makePortfolioInput({
        aktiver: ejendomme,
        matches,
        policer: [pol],
        coveragesByPolicy,
        branche: {
          hovedbranche: '681020',
          hovedbranche_tekst: 'Udlejning af ejendomme',
          bibrancher: [],
        },
      })
    );
    const gap = gaps.find((g) => g.check_id === 'GAP-061');
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe('critical');
    expect(gap?.title).toContain('5');
  });
});

describe('runPortfolioChecks — GAP-062: Kollektiv bygningsforsikring', () => {
  it('anbefaler kollektiv ved >3 ejendomme med mange policer', () => {
    const ejendomme: Aktiv[] = Array.from({ length: 6 }, (_, i) => ({
      type: 'ejendom' as const,
      label: `Ejendom ${i}`,
      bfe: 100 + i,
    }));
    // Hver ejendom har sin egen police (6 separate policer)
    const policer = ejendomme.map((_, i) => makePolicy({ id: `pol-${i}` }));
    const matches = ejendomme.map((a, i) => makeMatch(a, policer[i]));

    const gaps = runPortfolioChecks(makePortfolioInput({ aktiver: ejendomme, matches, policer }));
    expect(gaps.find((g) => g.check_id === 'GAP-062')).toBeDefined();
  });

  it('flagger ikke ved <=3 ejendomme', () => {
    const ejendomme: Aktiv[] = Array.from({ length: 3 }, (_, i) => ({
      type: 'ejendom' as const,
      label: `Ejendom ${i}`,
      bfe: 100 + i,
    }));
    const pol = makePolicy();
    const matches = ejendomme.map((a) => makeMatch(a, pol));

    const gaps = runPortfolioChecks(
      makePortfolioInput({ aktiver: ejendomme, matches, policer: [pol] })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-062')).toBeUndefined();
  });
});

describe('runPortfolioChecks — GAP-063: Cyber-forsikring', () => {
  it('flagger udlejningsselskab uden cyber', () => {
    const gaps = runPortfolioChecks(
      makePortfolioInput({
        policer: [makePolicy()],
        aktiver: [
          { type: 'ejendom', label: 'BFE 1', bfe: 1 },
          { type: 'ejendom', label: 'BFE 2', bfe: 2 },
        ],
        branche: {
          hovedbranche: '681020',
          hovedbranche_tekst: 'Udlejning af erhvervsejendomme',
          bibrancher: [],
        },
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-063')).toBeDefined();
  });

  it('flagger ikke for industri-branche', () => {
    const gaps = runPortfolioChecks(
      makePortfolioInput({
        policer: [makePolicy()],
        aktiver: [],
        branche: {
          hovedbranche: '251100',
          hovedbranche_tekst: 'Metalforarbejdning',
          bibrancher: [],
        },
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-063')).toBeUndefined();
  });
});

describe('runPortfolioChecks — GAP-064: Retshjælp', () => {
  it('flagger manglende retshjælp', () => {
    const pol = makePolicy();
    const coveragesByPolicy = new Map<string, ForsikringCoverage[]>();
    coveragesByPolicy.set(pol.id, [makeCoverage('brand_el')]);

    const gaps = runPortfolioChecks(makePortfolioInput({ policer: [pol], coveragesByPolicy }));
    expect(gaps.find((g) => g.check_id === 'GAP-064')).toBeDefined();
  });

  it('flagger ikke når retshjælp er i dækninger', () => {
    const pol = makePolicy();
    const coveragesByPolicy = new Map<string, ForsikringCoverage[]>();
    coveragesByPolicy.set(pol.id, [
      makeCoverage('brand_el'),
      { ...makeCoverage('retshjaelp'), coverage_label: 'Retshjælp' },
    ]);

    const gaps = runPortfolioChecks(makePortfolioInput({ policer: [pol], coveragesByPolicy }));
    expect(gaps.find((g) => g.check_id === 'GAP-064')).toBeUndefined();
  });
});

describe('runPortfolioChecks — GAP-065: Driftstab for udlejning', () => {
  it('flagger udlejningsselskab uden driftstab', () => {
    const pol = makePolicy();
    const coveragesByPolicy = new Map<string, ForsikringCoverage[]>();
    coveragesByPolicy.set(pol.id, [makeCoverage('brand_el'), makeCoverage('huslejetab')]);

    const gaps = runPortfolioChecks(
      makePortfolioInput({
        policer: [pol],
        coveragesByPolicy,
        aktiver: Array.from({ length: 10 }, (_, i) => ({
          type: 'ejendom' as const,
          label: `BFE ${i}`,
          bfe: i,
        })),
        branche: {
          hovedbranche: '681020',
          hovedbranche_tekst: 'Udlejning af ejendomme',
          bibrancher: [],
        },
      })
    );
    const gap = gaps.find((g) => g.check_id === 'GAP-065');
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe('critical');
    expect(gap?.title).toContain('driftstab');
  });

  it('flagger ikke når driftstab-dækning eksisterer', () => {
    const pol = makePolicy();
    const coveragesByPolicy = new Map<string, ForsikringCoverage[]>();
    coveragesByPolicy.set(pol.id, [makeCoverage('driftstab')]);

    const gaps = runPortfolioChecks(
      makePortfolioInput({
        policer: [pol],
        coveragesByPolicy,
        aktiver: [{ type: 'ejendom', label: 'BFE 1', bfe: 1 }],
        branche: {
          hovedbranche: '681020',
          hovedbranche_tekst: 'Udlejning',
          bibrancher: [],
        },
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-065')).toBeUndefined();
  });
});

describe('runPortfolioChecks — GAP-067: Branchekrav-aggregat', () => {
  it('flagger manglende huslejetab+driftstab+hus_grundejer for udlejning', () => {
    const pol = makePolicy({ business_activity: 'Ejendomsudlejning' });
    const coveragesByPolicy = new Map<string, ForsikringCoverage[]>();
    coveragesByPolicy.set(pol.id, [makeCoverage('brand_el'), makeCoverage('bygningskasko')]);

    const gaps = runPortfolioChecks(
      makePortfolioInput({
        policer: [pol],
        coveragesByPolicy,
        branche: {
          hovedbranche: '681020',
          hovedbranche_tekst: 'Udlejning af erhvervsejendomme',
          bibrancher: [],
        },
      })
    );
    const gap = gaps.find((g) => g.check_id === 'GAP-067');
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe('critical');
    const manglende = (gap?.source_data as { manglende_krav?: string[] }).manglende_krav ?? [];
    expect(manglende).toContain('huslejetab');
    expect(manglende).toContain('driftstab');
    expect(manglende).toContain('hus_grundejer_ansvar');
    expect(manglende).toContain('erhvervsansvar');
  });

  it('aggregerer krav fra bibrancher', () => {
    const pol = makePolicy({ business_activity: 'Ejendomsudlejning' });
    const coveragesByPolicy = new Map<string, ForsikringCoverage[]>();
    coveragesByPolicy.set(pol.id, [
      makeCoverage('bygningskasko'),
      makeCoverage('erhvervsansvar'),
      makeCoverage('huslejetab'),
      makeCoverage('driftstab'),
      makeCoverage('hus_grundejer_ansvar'),
    ]);

    const gaps = runPortfolioChecks(
      makePortfolioInput({
        policer: [pol],
        coveragesByPolicy,
        branche: {
          hovedbranche: '681020',
          hovedbranche_tekst: 'Udlejning',
          // Bibranche: restaurant (kræver brand, erhvervsansvar, driftstab, produktansvar)
          bibrancher: [{ kode: '561010', tekst: 'Restaurant' }],
        },
      })
    );
    const gap = gaps.find((g) => g.check_id === 'GAP-067');
    expect(gap).toBeDefined();
    const manglende = (gap?.source_data as { manglende_krav?: string[] }).manglende_krav ?? [];
    // brand mangler (kun bygningskasko er der)
    expect(manglende).toContain('brand');
  });

  it('flagger ikke når alle branchekrav er opfyldt', () => {
    const pol = makePolicy({ business_activity: 'Ejendomsudlejning' });
    const coveragesByPolicy = new Map<string, ForsikringCoverage[]>();
    coveragesByPolicy.set(pol.id, [
      makeCoverage('bygningskasko'),
      makeCoverage('erhvervsansvar'),
      makeCoverage('huslejetab'),
      makeCoverage('driftstab'),
      makeCoverage('hus_grundejer_ansvar'),
    ]);

    const gaps = runPortfolioChecks(
      makePortfolioInput({
        policer: [pol],
        coveragesByPolicy,
        branche: {
          hovedbranche: '681020',
          hovedbranche_tekst: 'Udlejning',
          bibrancher: [],
        },
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-067')).toBeUndefined();
  });

  it('accepterer dækning via policy-tekst for krav uden CoverageCode-modstykke', () => {
    // Holdingselskab kræver "d&o" — tjekkes via policy-tekst
    const pol = makePolicy({
      business_activity: 'Holdingaktivitet',
      raw_metadata: { type: 'D&O Bestyrelsesansvar' },
    });
    const coveragesByPolicy = new Map<string, ForsikringCoverage[]>();
    coveragesByPolicy.set(pol.id, []);

    const gaps = runPortfolioChecks(
      makePortfolioInput({
        policer: [pol],
        coveragesByPolicy,
        branche: {
          hovedbranche: '642020',
          hovedbranche_tekst: 'Holding',
          bibrancher: [],
        },
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-067')).toBeUndefined();
  });

  it('returnerer null for standard-branche uden krav', () => {
    const pol = makePolicy();
    const gaps = runPortfolioChecks(
      makePortfolioInput({
        policer: [pol],
        coveragesByPolicy: new Map([[pol.id, []]]),
        branche: {
          hovedbranche: '999999', // ukendt branche
          hovedbranche_tekst: 'Ukendt',
          bibrancher: [],
        },
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-067')).toBeUndefined();
  });
});

describe('runPortfolioChecks — GAP-066: Lav præmie', () => {
  it('flagger ekstremt lav præmie per ejendom', () => {
    const ejendomme: Aktiv[] = Array.from({ length: 17 }, (_, i) => ({
      type: 'ejendom' as const,
      label: `BFE ${i}`,
      bfe: i,
    }));
    // 16.176 kr for 17 ejendomme = ~951 kr/ejendom
    const gaps = runPortfolioChecks(
      makePortfolioInput({
        policer: [makePolicy({ annual_premium_dkk: 16176 })],
        aktiver: ejendomme,
      })
    );
    const gap = gaps.find((g) => g.check_id === 'GAP-066');
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe('critical');
  });

  it('flagger ikke ved normal præmie per ejendom', () => {
    const ejendomme: Aktiv[] = Array.from({ length: 5 }, (_, i) => ({
      type: 'ejendom' as const,
      label: `BFE ${i}`,
      bfe: i,
    }));
    // 50.000 kr for 5 ejendomme = 10.000 kr/ejendom
    const gaps = runPortfolioChecks(
      makePortfolioInput({
        policer: [makePolicy({ annual_premium_dkk: 50000 })],
        aktiver: ejendomme,
      })
    );
    expect(gaps.find((g) => g.check_id === 'GAP-066')).toBeUndefined();
  });
});
