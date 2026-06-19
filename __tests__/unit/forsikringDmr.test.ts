/**
 * Unit tests for BIZZ-2144 DMR-berigelse.
 *
 * Dækker:
 *   - app/lib/forsikring/dmr.ts: normalizeRegnr, erGyldigtRegnr, parseTjekbil
 *   - gapEngine DMR-checks: GAP-BIL-AFMELDT, GAP-BIL-FORSIKRING-OPHOERT,
 *     GAP-BIL-FORSIKRING-MISMATCH, GAP-BIL-SYN-UDLOEBET
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeRegnr,
  erGyldigtRegnr,
  parseTjekbil,
  type DmrData,
} from '@/app/lib/forsikring/dmr';
import { runGapEngine } from '@/app/lib/forsikring/gapEngine';
import type { ForsikringPolicy, GapEngineInput } from '@/app/lib/forsikring/types';

// ─── dmr.ts pure helpers ──────────────────────────────────────────

describe('normalizeRegnr', () => {
  it('uppercaser og fjerner mellemrum/bindestreger', () => {
    expect(normalizeRegnr(' ce 18-728 ')).toBe('CE18728');
    expect(normalizeRegnr('ab12345')).toBe('AB12345');
  });
  it('håndterer null/undefined', () => {
    expect(normalizeRegnr(null)).toBe('');
    expect(normalizeRegnr(undefined)).toBe('');
  });
});

describe('erGyldigtRegnr', () => {
  it('accepterer almindelige danske formater', () => {
    expect(erGyldigtRegnr('CE18728')).toBe(true);
    expect(erGyldigtRegnr('AB123')).toBe(true);
    expect(erGyldigtRegnr('AB12345')).toBe(true);
  });
  it('afviser ugyldige strenge', () => {
    expect(erGyldigtRegnr('')).toBe(false);
    expect(erGyldigtRegnr('123456')).toBe(false);
    expect(erGyldigtRegnr('DROP TABLE')).toBe(false);
  });
});

describe('parseTjekbil', () => {
  it('normaliserer basis-felter og dato-format', () => {
    const d = parseTjekbil('CE18728', {
      basic: {
        regNr: 'ce18728',
        stelNr: 'WV1ZZZ',
        status: 'Registreret',
        maerkeTypeNavn: 'VOLKSWAGEN',
        modelTypeNavn: 'CADDY',
        foersteRegistreringDato: '14-03-2018',
      },
    });
    expect(d.regNr).toBe('CE18728');
    expect(d.maerke).toBe('VOLKSWAGEN');
    expect(d.foersteRegistrering).toBe('2018-03-14');
  });

  it('vælger nyeste syn og tæller selskabsskift', () => {
    const d = parseTjekbil('CE18728', {
      extended: {
        insurance: { selskab: 'Tryg', status: 'Aktiv', historik: [{}, {}, {}] },
      },
      inspectionData: {
        rapporter: [
          { synsdato: '01-02-2020', synsresultat: 'Godkendt', kmstand: 50000 },
          { synsdato: '15-06-2023', synsresultat: 'Godkendt', kmstand: 90000 },
        ],
      },
    });
    expect(d.forsikringSelskab).toBe('Tryg');
    expect(d.forsikringSkiftAntal).toBe(2); // 3 historik-rækker → 2 skift
    expect(d.sidsteSyn?.synsdato).toBe('2023-06-15');
    expect(d.sidsteSyn?.kmstand).toBe(90000);
  });
});

// ─── gapEngine DMR-checks ─────────────────────────────────────────

function makeBilPolicy(insurer: string): ForsikringPolicy {
  return {
    id: 'pol-bil',
    tenant_id: 't1',
    document_id: null,
    policy_number: 'BIL-1',
    insurer_name: insurer,
    insurer_cvr: null,
    broker_name: null,
    policyholder_name: 'Test A/S',
    policyholder_cvr: '12345678',
    policyholder_address: null,
    property_address: null,
    property_matrikel: null,
    property_bfe: null,
    property_entity_id: null,
    business_activity: 'Bilforsikring',
    building_use: null,
    building_area_m2: null,
    building_floors: null,
    building_year_built: null,
    building_has_basement: null,
    insurance_form: null,
    sum_insured_dkk: null,
    annual_premium_dkk: null,
    general_deductible_dkk: null,
    effective_from: '2024-01-01',
    effective_to: '2027-01-01',
    main_renewal_date: '2027-01-01',
    policy_issued_date: '2024-01-01',
    raw_metadata: {},
    created_by: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };
}

function makeDmr(overrides: Partial<DmrData> = {}): DmrData {
  return {
    regNr: 'CE18728',
    stelNr: null,
    status: 'Registreret',
    maerke: 'VOLKSWAGEN',
    model: 'CADDY',
    variant: null,
    drivkraft: 'Diesel',
    foersteRegistrering: '2018-03-14',
    forsikringSelskab: 'Tryg',
    forsikringStatus: 'Aktiv',
    forsikringOprettet: '2024-01-01',
    forsikringSkiftAntal: 0,
    sidsteSyn: { synsdato: '2025-01-01', synsresultat: 'Godkendt', kmstand: 90000 },
    ...overrides,
  };
}

function makeBilInput(dmr: DmrData, insurer = 'Tryg Forsikring A/S'): GapEngineInput {
  return {
    policy: makeBilPolicy(insurer),
    coverages: [],
    bbr: null,
    asOfDate: new Date('2026-06-17'),
    dmr,
    asset: { type: 'bil', matchScore: 0.9 },
  };
}

describe('runGapEngine — DMR bil-checks (BIZZ-2144)', () => {
  it('GAP-BIL-AFMELDT når bilen er afmeldt', () => {
    const gaps = runGapEngine(makeBilInput(makeDmr({ status: 'Afmeldt' })));
    expect(gaps.find((g) => g.check_id === 'GAP-BIL-AFMELDT')).toBeTruthy();
  });

  it('GAP-BIL-FORSIKRING-OPHOERT når lovpligtig dækning er ophørt', () => {
    const gaps = runGapEngine(makeBilInput(makeDmr({ forsikringStatus: 'Ophørt' })));
    const g = gaps.find((x) => x.check_id === 'GAP-BIL-FORSIKRING-OPHOERT');
    expect(g?.severity).toBe('critical');
  });

  it('GAP-BIL-FORSIKRING-MISMATCH når DMR-selskab afviger fra policen', () => {
    const gaps = runGapEngine(
      makeBilInput(makeDmr({ forsikringSelskab: 'Codan' }), 'Tryg Forsikring A/S')
    );
    expect(gaps.find((g) => g.check_id === 'GAP-BIL-FORSIKRING-MISMATCH')).toBeTruthy();
  });

  it('matcher selskab på tværs af selskabsform-suffikser (intet mismatch)', () => {
    const gaps = runGapEngine(
      makeBilInput(makeDmr({ forsikringSelskab: 'Tryg' }), 'Tryg Forsikring A/S')
    );
    expect(gaps.find((g) => g.check_id === 'GAP-BIL-FORSIKRING-MISMATCH')).toBeFalsy();
  });

  it('GAP-BIL-SYN-UDLOEBET når seneste syn er over 2 år gammelt', () => {
    const gaps = runGapEngine(
      makeBilInput(
        makeDmr({ sidsteSyn: { synsdato: '2022-01-01', synsresultat: 'Godkendt', kmstand: 1 } })
      )
    );
    expect(gaps.find((g) => g.check_id === 'GAP-BIL-SYN-UDLOEBET')).toBeTruthy();
  });

  it('ingen DMR-gaps for et sundt køretøj', () => {
    const gaps = runGapEngine(makeBilInput(makeDmr()));
    expect(gaps.filter((g) => g.check_id.startsWith('GAP-BIL-'))).toHaveLength(0);
  });

  it('ingen DMR-gaps når dmr mangler', () => {
    const input = makeBilInput(makeDmr());
    delete input.dmr;
    const gaps = runGapEngine(input);
    expect(gaps.filter((g) => g.check_id.startsWith('GAP-BIL-'))).toHaveLength(0);
  });

  it('afmeldt bil udløser ikke OPHOERT/MISMATCH/SYN samtidig', () => {
    const gaps = runGapEngine(
      makeBilInput(
        makeDmr({ status: 'Afmeldt', forsikringStatus: 'Ophørt', forsikringSelskab: 'Codan' })
      )
    );
    const ids = gaps.map((g) => g.check_id);
    expect(ids).toContain('GAP-BIL-AFMELDT');
    expect(ids).not.toContain('GAP-BIL-FORSIKRING-OPHOERT');
    expect(ids).not.toContain('GAP-BIL-FORSIKRING-MISMATCH');
    expect(ids).not.toContain('GAP-BIL-SYN-UDLOEBET');
  });
});
