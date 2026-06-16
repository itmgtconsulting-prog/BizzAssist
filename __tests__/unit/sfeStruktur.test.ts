/**
 * Unit tests for sfeStruktur (BIZZ-2096 + BIZZ-2128) — SFE-struktur-arv af police-dækning.
 *
 * Tester den rene arve-regel applySfeArv: aktiver i en SFE der er dækket af
 * en police på SFE-adressen får nedarvet match (score 75) + transparent
 * markering i rawData, mens direkte matches og fremmede SFE'er ikke røres.
 * BIZZ-2128: søster-SFE-kæden (arv på tværs af forskellige SFE'er i samme
 * ejerlav) er fjernet — den gav falsk dækning i store by-ejerlav.
 */

import { describe, it, expect } from 'vitest';
import { applySfeArv, tilAdgangsadresse, SFE_ARV_SCORE } from '@/app/lib/forsikring/sfeStruktur';
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
function makeAktiv(bfe: number, adresse: string, ejerCvr?: string): Aktiv {
  return {
    type: 'ejendom',
    label: adresse,
    bfe,
    adresse,
    ...(ejerCvr ? { rawData: { ejer_cvr: ejerCvr } } : {}),
  };
}

/** Umatchet MatchResult for et aktiv */
function unmatched(aktiv: Aktiv): MatchResult {
  return { aktiv, bestMatch: null, candidates: [] };
}

const SFE_BFE = 5322356; // Gefionsvej 47A / Fenrisvej 27A-B (matrikel 65bp)
const ANDEN_SFE = 5322351; // Fenrisvej 19 — egen SFE
const EJERLAV = 2000652; // Helsingør Markjorder

/** Police-entry med ejerlav (BIZZ-2118) */
function policyEntry(policy: ForsikringPolicy, ejerlavKode: number | null = EJERLAV) {
  return { policy, sfeAdresse: 'Gefionsvej 47A, 3000 Helsingør', ejerlavKode };
}

describe('tilAdgangsadresse — BIZZ-2124', () => {
  // Konkrete formater fra FAMILIEN PETERSEN-analysen (alle gav 0 DAWA-hits før fixet)
  it.each([
    ['Stjernegade 24H, 1 2, 3000 Helsingør', 'Stjernegade 24H, 3000 Helsingør'],
    ['Stjernegade 24H, 2 tv, 3000 Helsingør', 'Stjernegade 24H, 3000 Helsingør'],
    ['Stjernegade 24H, 2 mf, 3000 Helsingør', 'Stjernegade 24H, 3000 Helsingør'],
    ['Stjernegade 24H, 2 th, 3000 Helsingør', 'Stjernegade 24H, 3000 Helsingør'],
    ['Stjernegade 24G, 1., 3000 Helsingør', 'Stjernegade 24G, 3000 Helsingør'],
    ['Torvegade 3B, 1 th, 3000 Helsingør', 'Torvegade 3B, 3000 Helsingør'],
    ['Torvegade 3B, 3 1, 3000 Helsingør', 'Torvegade 3B, 3000 Helsingør'],
    ['Torvegade 3A, st, 3000 Helsingør', 'Torvegade 3A, 3000 Helsingør'],
    ['Torvegade 3A, st. tv, 3000 Helsingør', 'Torvegade 3A, 3000 Helsingør'],
    ['Torvegade 3A, kl, 3000 Helsingør', 'Torvegade 3A, 3000 Helsingør'],
  ])('stripper etage/dør: %s → %s', (input, expected) => {
    expect(tilAdgangsadresse(input)).toBe(expected);
  });

  it('kollapser husnummer-mellemrum fra rå PDF-form ("Torvegade 3 A")', async () => {
    expect(tilAdgangsadresse('Torvegade 3 A, 3000 Helsingør')).toBe('Torvegade 3A, 3000 Helsingør');
  });

  it('rører ikke adresser uden etage/dør (postnr-segmentet bevares)', async () => {
    expect(tilAdgangsadresse('Gefionsvej 47A, 3000 Helsingør')).toBe(
      'Gefionsvej 47A, 3000 Helsingør'
    );
    expect(tilAdgangsadresse('Fenrisvej 27B, 3000 Helsingør')).toBe(
      'Fenrisvej 27B, 3000 Helsingør'
    );
  });

  it('bevarer første segment selv hvis det ligner etage/dør (vejnavn husnr)', async () => {
    // Defensive: split må aldrig fjerne vejnavn-segmentet
    expect(tilAdgangsadresse('st, 3000 Helsingør')).toBe('st, 3000 Helsingør');
  });
});

describe('applySfeArv — BIZZ-2096', () => {
  it('nedarver dækning til umatchet aktiv i dækket SFE med score 75 og markering', async () => {
    const policy = makePolicy();
    const matches: MatchResult[] = [
      unmatched(makeAktiv(SFE_BFE, 'Gefionsvej 47A, 3000 Helsingør')),
      unmatched(makeAktiv(123456, 'Fenrisvej 27A, 3000 Helsingør')),
    ];
    const aktivSfe: AktivSfeMap = new Map([
      [0, { sfeBfe: SFE_BFE, ejerlavKode: EJERLAV }],
      [1, { sfeBfe: SFE_BFE, ejerlavKode: EJERLAV }],
    ]);
    const policySfe: PolicySfeMap = new Map([[SFE_BFE, policyEntry(policy)]]);

    const { inherited } = await applySfeArv(matches, aktivSfe, policySfe);

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

  it('nedarver IKKE til aktiv i en anden SFE uden kendt ejer (konservativ kæde)', async () => {
    const matches: MatchResult[] = [
      unmatched(makeAktiv(ANDEN_SFE, 'Fenrisvej 19, 3000 Helsingør')),
    ];
    const aktivSfe: AktivSfeMap = new Map([[0, { sfeBfe: ANDEN_SFE, ejerlavKode: EJERLAV }]]);
    const policySfe: PolicySfeMap = new Map([[SFE_BFE, policyEntry(makePolicy())]]);

    const { inherited } = await applySfeArv(matches, aktivSfe, policySfe);

    expect(inherited).toBe(0);
    expect(matches[0].bestMatch).toBeNull();
    expect(matches[0].aktiv.rawData?.daekket_via_sfe).toBeUndefined();
  });

  it('rører ikke direkte matches — direkte match vinder over arv', async () => {
    const direktePolicy = makePolicy({ id: 'pol-direkte' });
    const matches: MatchResult[] = [
      {
        aktiv: makeAktiv(SFE_BFE, 'Gefionsvej 47A, 3000 Helsingør'),
        bestMatch: { policy: direktePolicy, score: 90 },
        candidates: [],
      },
    ];
    const aktivSfe: AktivSfeMap = new Map([[0, { sfeBfe: SFE_BFE, ejerlavKode: EJERLAV }]]);
    const policySfe: PolicySfeMap = new Map([[SFE_BFE, policyEntry(makePolicy())]]);

    const { inherited } = await applySfeArv(matches, aktivSfe, policySfe);

    expect(inherited).toBe(0);
    expect(matches[0].bestMatch?.policy.id).toBe('pol-direkte');
    expect(matches[0].bestMatch?.score).toBe(90);
  });

  it('annoterer alle aktiver med sfe_bfe + sfe_niveau til UI-gruppering', async () => {
    const matches: MatchResult[] = [
      unmatched(makeAktiv(SFE_BFE, 'Gefionsvej 47A, 3000 Helsingør')),
      unmatched(makeAktiv(123456, 'Fenrisvej 27B, 3000 Helsingør')),
    ];
    const aktivSfe: AktivSfeMap = new Map([
      [0, { sfeBfe: SFE_BFE, ejerlavKode: EJERLAV }],
      [1, { sfeBfe: SFE_BFE, ejerlavKode: EJERLAV }],
    ]);

    applySfeArv(matches, aktivSfe, new Map());

    expect(matches[0].aktiv.rawData?.sfe_bfe).toBe(SFE_BFE);
    expect(matches[0].aktiv.rawData?.sfe_niveau).toBe('sfe');
    expect(matches[1].aktiv.rawData?.sfe_bfe).toBe(SFE_BFE);
    expect(matches[1].aktiv.rawData?.sfe_niveau).toBe('underliggende');
  });

  it('springer ikke-ejendom-aktiver over selv ved SFE-opslag', async () => {
    const virksomhed: Aktiv = { type: 'virksomhed', label: 'Belvedere', cvr: '24301117' };
    const matches: MatchResult[] = [{ aktiv: virksomhed, bestMatch: null, candidates: [] }];
    const aktivSfe: AktivSfeMap = new Map([[0, { sfeBfe: SFE_BFE, ejerlavKode: EJERLAV }]]);
    const policySfe: PolicySfeMap = new Map([[SFE_BFE, policyEntry(makePolicy())]]);

    expect((await applySfeArv(matches, aktivSfe, policySfe)).inherited).toBe(0);
    expect(matches[0].bestMatch).toBeNull();
  });

  it('bevarer eksisterende rawData ved annotering', async () => {
    const aktiv = makeAktiv(123456, 'Fenrisvej 27A, 3000 Helsingør');
    aktiv.rawData = { ejer_cvr: '24301117' };
    const matches: MatchResult[] = [unmatched(aktiv)];
    const aktivSfe: AktivSfeMap = new Map([[0, { sfeBfe: SFE_BFE, ejerlavKode: EJERLAV }]]);
    const policySfe: PolicySfeMap = new Map([[SFE_BFE, policyEntry(makePolicy())]]);

    applySfeArv(matches, aktivSfe, policySfe);

    expect(matches[0].aktiv.rawData?.ejer_cvr).toBe('24301117');
    expect(matches[0].aktiv.rawData?.sfe_bfe).toBe(SFE_BFE);
  });
});

describe('applySfeArv — søster-SFE (BIZZ-2128 fjerner dækning, BIZZ-2130 annoterer)', () => {
  const EJER = '24301117'; // BELVEDERE EJENDOMME A/S

  it('søster-SFE: ingen dækning (BIZZ-2128) men annoteres med soester_sfe (BIZZ-2130)', async () => {
    // Police på SFE_BFE; aktiv på ANDEN_SFE i samme ejerlav, samme ejer.
    // Må IKKE arve dækning (BIZZ-2118-kæden fjernet), men SKAL annoteres som
    // søster-SFE til policens forsikringssted (Bramstræde/Stengade-casen).
    const policy = makePolicy();
    const matches: MatchResult[] = [
      unmatched(makeAktiv(123456, 'Bramstræde 5, 3000 Helsingør', EJER)),
      unmatched(makeAktiv(ANDEN_SFE, 'Stengade 8G, 3000 Helsingør', EJER)),
    ];
    const aktivSfe: AktivSfeMap = new Map([
      [0, { sfeBfe: SFE_BFE, ejerlavKode: EJERLAV }],
      [1, { sfeBfe: ANDEN_SFE, ejerlavKode: EJERLAV }],
    ]);
    const policySfe: PolicySfeMap = new Map([[SFE_BFE, policyEntry(policy)]]);

    const { inherited } = await applySfeArv(matches, aktivSfe, policySfe);

    // Kun det direkte SFE-aktiv arver dækning
    expect(inherited).toBe(1);
    expect(matches[0].bestMatch?.score).toBe(SFE_ARV_SCORE);
    // Søster-SFE'et: INGEN dækning, men annoteret med policens forsikringssted
    expect(matches[1].bestMatch).toBeNull();
    const soester = matches[1].aktiv.rawData?.soester_sfe as
      | { sfe_bfe: number; sfe_adresse: string }
      | undefined;
    expect(soester?.sfe_bfe).toBe(SFE_BFE);
    expect(soester?.sfe_adresse).toBe('Gefionsvej 47A, 3000 Helsingør');
    expect(matches[1].aktiv.rawData?.daekket_via_sfe).toBeUndefined();
  });

  it('annoterer IKKE søster-SFE når ejeren afviger', async () => {
    const matches: MatchResult[] = [
      unmatched(makeAktiv(123456, 'Bramstræde 5, 3000 Helsingør', EJER)),
      unmatched(makeAktiv(ANDEN_SFE, 'Stengade 8G, 3000 Helsingør', '99999999')),
    ];
    const aktivSfe: AktivSfeMap = new Map([
      [0, { sfeBfe: SFE_BFE, ejerlavKode: EJERLAV }],
      [1, { sfeBfe: ANDEN_SFE, ejerlavKode: EJERLAV }],
    ]);
    const policySfe: PolicySfeMap = new Map([[SFE_BFE, policyEntry(makePolicy())]]);

    applySfeArv(matches, aktivSfe, policySfe);

    expect(matches[1].aktiv.rawData?.soester_sfe).toBeUndefined();
  });

  it('annoterer IKKE søster-SFE på tværs af ejerlav', async () => {
    const matches: MatchResult[] = [
      unmatched(makeAktiv(123456, 'Bramstræde 5, 3000 Helsingør', EJER)),
      unmatched(makeAktiv(ANDEN_SFE, 'Hovedgade 5, 8000 Aarhus', EJER)),
    ];
    const aktivSfe: AktivSfeMap = new Map([
      [0, { sfeBfe: SFE_BFE, ejerlavKode: EJERLAV }],
      [1, { sfeBfe: ANDEN_SFE, ejerlavKode: 9999999 }],
    ]);
    const policySfe: PolicySfeMap = new Map([[SFE_BFE, policyEntry(makePolicy())]]);

    applySfeArv(matches, aktivSfe, policySfe);

    expect(matches[1].aktiv.rawData?.soester_sfe).toBeUndefined();
  });

  it('markerer police som portefølje-forankret når dens SFE rummer aktiver — også uden arv', async () => {
    const matches: MatchResult[] = [
      // Direkte matchet aktiv på policens SFE — ingen arv nødvendig
      {
        aktiv: makeAktiv(123456, 'Fenrisvej 27A, 3000 Helsingør', EJER),
        bestMatch: { policy: makePolicy({ id: 'pol-direkte' }), score: 90 },
        candidates: [],
      },
    ];
    const aktivSfe: AktivSfeMap = new Map([[0, { sfeBfe: SFE_BFE, ejerlavKode: EJERLAV }]]);
    const policySfe: PolicySfeMap = new Map([[SFE_BFE, policyEntry(makePolicy())]]);

    const { inherited, portefoeljePolicyIds } = await applySfeArv(matches, aktivSfe, policySfe);

    expect(inherited).toBe(0);
    expect(portefoeljePolicyIds.has('pol-1')).toBe(true);
  });
});
