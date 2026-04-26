/**
 * Unit tests for app/lib/search/virksomhedFilterSchema.ts (BIZZ-805).
 *
 * Verifies:
 *   - 5 filtre i korrekt rækkefølge (status, virksomhedsform, branche,
 *     kommune, stiftet)
 *   - matchVirksomhedFilter honorerer hver enkelt filter
 *   - legacy active-bool fallback når status-feltet er null
 *   - Stiftet range clamping
 *   - Branche/kommune dynamic options dedupes + sorterer
 *   - narrowVirksomhedFilters type-safety
 */
import { describe, it, expect } from 'vitest';
import {
  buildVirksomhedFilterSchemas,
  matchVirksomhedFilter,
  buildVirksomhedBrancheOptions,
  buildVirksomhedKommuneOptions,
  narrowVirksomhedFilters,
  VIRKSOMHED_STATUS_OPTIONS,
  type FilterableVirksomhed,
} from '@/app/lib/search/virksomhedFilterSchema';

describe('buildVirksomhedFilterSchemas', () => {
  it('returnerer 11 filtre i korrekt rækkefølge (phase 1 + regnskab phase 2)', () => {
    const schemas = buildVirksomhedFilterSchemas('da');
    expect(schemas).toHaveLength(11);
    // Phase 1
    expect(schemas[0].key).toBe('status');
    expect(schemas[1].key).toBe('virksomhedsform');
    expect(schemas[2].key).toBe('branche');
    expect(schemas[3].key).toBe('kommune');
    expect(schemas[4].key).toBe('stiftet');
    // Phase 2 — BIZZ-822 regnskab
    expect(schemas[5].key).toBe('antalAnsatte');
    expect(schemas[6].key).toBe('omsaetning');
    expect(schemas[7].key).toBe('egenkapital');
    expect(schemas[8].key).toBe('resultat');
    expect(schemas[9].key).toBe('regnskabsklasse');
    expect(schemas[10].key).toBe('selskabskapital');
  });

  it('bilingual labels — da vs en', () => {
    const da = buildVirksomhedFilterSchemas('da');
    const en = buildVirksomhedFilterSchemas('en');
    expect(da[1].label).toBe('Virksomhedsform');
    expect(en[1].label).toBe('Company type');
  });

  it('status schema indeholder alle 7 CVR-statusser', () => {
    const schemas = buildVirksomhedFilterSchemas('da');
    const statusSchema = schemas[0];
    if (statusSchema.type === 'multi-select') {
      expect(statusSchema.options.length).toBe(VIRKSOMHED_STATUS_OPTIONS.length);
      expect(statusSchema.options.map((o) => o.value)).toContain('Normal');
      expect(statusSchema.options.map((o) => o.value)).toContain('Ophørt');
    }
  });

  it('stiftet range har fornuftige bounds', () => {
    const schemas = buildVirksomhedFilterSchemas('da');
    const stiftet = schemas[4];
    if (stiftet.type === 'range') {
      expect(stiftet.min).toBe(1900);
      expect(stiftet.max).toBeGreaterThanOrEqual(2025);
    }
  });

  it('resultat dropdown default er "alle"', () => {
    const schemas = buildVirksomhedFilterSchemas('da');
    const resultat = schemas[8];
    if (resultat.type === 'dropdown') {
      expect(resultat.default).toBe('alle');
      expect(resultat.options.map((o) => o.value)).toEqual([
        'alle',
        'overskud',
        'underskud',
        'balance',
      ]);
    }
  });

  it('regnskabsklasse indeholder A/B/C-lille/C-mellem/C-stor/D', () => {
    const schemas = buildVirksomhedFilterSchemas('da');
    const klasse = schemas[9];
    if (klasse.type === 'multi-select') {
      expect(klasse.options.map((o) => o.value)).toEqual([
        'A',
        'B',
        'C-lille',
        'C-mellem',
        'C-stor',
        'D',
      ]);
    }
  });

  it('regnskab range-filtre har sensible bounds (BIZZ-822)', () => {
    const schemas = buildVirksomhedFilterSchemas('da');
    const ansatte = schemas[5];
    const omsaetning = schemas[6];
    const egenkapital = schemas[7];
    const kapital = schemas[10];
    if (ansatte.type === 'range') {
      expect(ansatte.min).toBe(0);
      expect(ansatte.max).toBe(1000);
    }
    if (omsaetning.type === 'range') {
      expect(omsaetning.min).toBe(0);
      expect(omsaetning.unit).toBe('DKK');
    }
    if (egenkapital.type === 'range') {
      // Negativ tilladt (teknisk insolvens)
      expect(egenkapital.min).toBeLessThan(0);
    }
    if (kapital.type === 'range') {
      expect(kapital.min).toBe(0);
    }
  });

  it('dynamiske options injectes via options param', () => {
    const schemas = buildVirksomhedFilterSchemas('da', {
      brancheOptions: [{ value: 'IT', label: 'IT' }],
      kommuneOptions: [{ value: 'København', label: 'København' }],
    });
    const branche = schemas[2];
    const kommune = schemas[3];
    if (branche.type === 'multi-select') {
      expect(branche.options).toHaveLength(1);
      expect(branche.options[0].value).toBe('IT');
    }
    if (kommune.type === 'multi-select') {
      expect(kommune.options[0].value).toBe('København');
    }
  });
});

describe('matchVirksomhedFilter', () => {
  const base: FilterableVirksomhed = {
    active: true,
    status: 'Normal',
    companyType: 'ApS',
    industry: 'Fast ejendom',
    kommuneNavn: 'København',
    stiftetAar: 2020,
  };

  it('tomme filtre matcher alt', () => {
    expect(matchVirksomhedFilter(base, {})).toBe(true);
  });

  it('status multi-select honoreres', () => {
    expect(matchVirksomhedFilter(base, { status: ['Normal'] })).toBe(true);
    expect(matchVirksomhedFilter(base, { status: ['Ophørt'] })).toBe(false);
    expect(matchVirksomhedFilter(base, { status: ['Normal', 'Under konkurs'] })).toBe(true);
  });

  it('legacy active-bool fallback når status er null', () => {
    const item: FilterableVirksomhed = { active: true, status: null };
    expect(matchVirksomhedFilter(item, { status: ['Normal'] })).toBe(true);
    expect(matchVirksomhedFilter(item, { status: ['Ophørt'] })).toBe(false);
    const inactive: FilterableVirksomhed = { active: false, status: null };
    expect(matchVirksomhedFilter(inactive, { status: ['Ophørt'] })).toBe(true);
  });

  it('virksomhedsform substring-match virker på kortBeskrivelse', () => {
    // CVR ES companyType leveres som "kortBeskrivelse" (fx "ApS")
    // — schema value matcher samme form. Substring-match giver plads
    // til mindre variationer som "APS" (uppercase).
    expect(matchVirksomhedFilter({ companyType: 'ApS' }, { virksomhedsform: ['ApS'] })).toBe(true);
    expect(matchVirksomhedFilter({ companyType: 'A/S' }, { virksomhedsform: ['A/S'] })).toBe(true);
    // Case-insensitive fallback
    expect(matchVirksomhedFilter({ companyType: 'aps' }, { virksomhedsform: ['ApS'] })).toBe(true);
  });

  it('branche multi-select honoreres', () => {
    expect(matchVirksomhedFilter(base, { branche: ['Fast ejendom'] })).toBe(true);
    expect(matchVirksomhedFilter(base, { branche: ['IT'] })).toBe(false);
  });

  it('kommune multi-select honoreres', () => {
    expect(matchVirksomhedFilter(base, { kommune: ['København'] })).toBe(true);
    expect(matchVirksomhedFilter(base, { kommune: ['Aarhus'] })).toBe(false);
  });

  it('stiftet range honoreres', () => {
    expect(matchVirksomhedFilter(base, { stiftet: { min: 2015, max: 2025 } })).toBe(true);
    expect(matchVirksomhedFilter(base, { stiftet: { min: 2021 } })).toBe(false);
    expect(matchVirksomhedFilter(base, { stiftet: { max: 2019 } })).toBe(false);
    expect(matchVirksomhedFilter({ stiftetAar: null }, { stiftet: { min: 2020 } })).toBe(false);
  });

  // ─── BIZZ-822 regnskab-filtre ──────────────────────────────────────────

  it('antalAnsatte range honoreres', () => {
    const item: FilterableVirksomhed = { ...base, antalAnsatte: 25 };
    expect(matchVirksomhedFilter(item, { antalAnsatte: { min: 10, max: 50 } })).toBe(true);
    expect(matchVirksomhedFilter(item, { antalAnsatte: { min: 30 } })).toBe(false);
    expect(matchVirksomhedFilter(item, { antalAnsatte: { max: 20 } })).toBe(false);
  });

  it('omsaetning + egenkapital + selskabskapital range honoreres', () => {
    const item: FilterableVirksomhed = {
      ...base,
      omsaetning: 5_000_000,
      egenkapital: 1_000_000,
      selskabskapital: 40_000,
    };
    expect(matchVirksomhedFilter(item, { omsaetning: { min: 1_000_000, max: 10_000_000 } })).toBe(
      true
    );
    expect(matchVirksomhedFilter(item, { omsaetning: { min: 6_000_000 } })).toBe(false);
    expect(matchVirksomhedFilter(item, { egenkapital: { min: 500_000 } })).toBe(true);
    expect(matchVirksomhedFilter(item, { selskabskapital: { min: 400_000 } })).toBe(false);
  });

  it('egenkapital tillader negative værdier (teknisk insolvens)', () => {
    const item: FilterableVirksomhed = { ...base, egenkapital: -500_000 };
    expect(matchVirksomhedFilter(item, { egenkapital: { max: 0 } })).toBe(true);
    expect(matchVirksomhedFilter(item, { egenkapital: { min: 0 } })).toBe(false);
  });

  it('resultat dropdown honoreres med overskud/underskud/balance', () => {
    expect(matchVirksomhedFilter({ aaretsResultat: 500_000 }, { resultat: 'overskud' })).toBe(true);
    expect(matchVirksomhedFilter({ aaretsResultat: 500_000 }, { resultat: 'underskud' })).toBe(
      false
    );
    expect(matchVirksomhedFilter({ aaretsResultat: -200_000 }, { resultat: 'underskud' })).toBe(
      true
    );
    expect(matchVirksomhedFilter({ aaretsResultat: 0 }, { resultat: 'balance' })).toBe(true);
    expect(matchVirksomhedFilter({ aaretsResultat: 1 }, { resultat: 'balance' })).toBe(false);
    // 'alle' er no-op
    expect(matchVirksomhedFilter({ aaretsResultat: -999 }, { resultat: 'alle' })).toBe(true);
  });

  it('regnskabsklasse multi-select honoreres', () => {
    expect(
      matchVirksomhedFilter({ regnskabsklasse: 'B' }, { regnskabsklasse: ['B', 'C-lille'] })
    ).toBe(true);
    expect(
      matchVirksomhedFilter({ regnskabsklasse: 'A' }, { regnskabsklasse: ['B', 'C-lille'] })
    ).toBe(false);
  });

  it('regnskab null-pass-through — virksomheder uden data udelukkes ikke', () => {
    // Hvis caller ikke har enriched regnskab-felter, lader vi item passere
    // selv når regnskab-filter er sat. Dette sikrer at phase-1-only søgninger
    // ikke pludselig returnerer 0 hits når regnskab-filter er eksplicit.
    const sparse: FilterableVirksomhed = { active: true, status: 'Normal' };
    expect(matchVirksomhedFilter(sparse, { omsaetning: { min: 1_000_000 } })).toBe(true);
    expect(matchVirksomhedFilter(sparse, { resultat: 'overskud' })).toBe(true);
    expect(matchVirksomhedFilter(sparse, { regnskabsklasse: ['C-stor'] })).toBe(true);
  });

  it('flere filtre ANDes', () => {
    expect(
      matchVirksomhedFilter(base, {
        status: ['Normal'],
        virksomhedsform: ['ApS'],
        kommune: ['København'],
      })
    ).toBe(true);
    expect(
      matchVirksomhedFilter(base, {
        status: ['Normal'],
        virksomhedsform: ['ApS'],
        kommune: ['Aarhus'], // mismatch
      })
    ).toBe(false);
  });
});

describe('buildVirksomhedBrancheOptions', () => {
  it('dedupliker og sorterer dansk alfabetisk', () => {
    const items: FilterableVirksomhed[] = [
      { industry: 'Fast ejendom' },
      { industry: 'IT' },
      { industry: 'Fast ejendom' },
      { industry: 'Bygge' },
    ];
    const opts = buildVirksomhedBrancheOptions(items);
    expect(opts).toHaveLength(3);
    expect(opts.map((o) => o.value)).toEqual(['Bygge', 'Fast ejendom', 'IT']);
  });

  it('drops null/empty industry', () => {
    const items: FilterableVirksomhed[] = [
      { industry: null },
      { industry: '' },
      {},
      { industry: 'IT' },
    ];
    expect(buildVirksomhedBrancheOptions(items)).toHaveLength(1);
  });
});

describe('buildVirksomhedKommuneOptions', () => {
  it('dedupliker', () => {
    // Bemærk: dansk locale-compare sorterer 'Aa' som 'Å' (efter 'Ø'),
    // så København kommer før Aarhus i dansk alfabetisk rækkefølge.
    const items: FilterableVirksomhed[] = [
      { kommuneNavn: 'København' },
      { kommuneNavn: 'Aarhus' },
      { kommuneNavn: 'København' },
    ];
    const opts = buildVirksomhedKommuneOptions(items);
    expect(opts).toHaveLength(2);
    const values = opts.map((o) => o.value);
    expect(values).toContain('Aarhus');
    expect(values).toContain('København');
  });
});

describe('narrowVirksomhedFilters', () => {
  it('mapper gyldige felter inkl. regnskab phase-2', () => {
    const raw = {
      status: ['Normal'],
      virksomhedsform: ['ApS'],
      branche: ['IT'],
      kommune: ['København'],
      stiftet: { min: 2020, max: 2025 },
      antalAnsatte: { min: 10 },
      omsaetning: { min: 1_000_000, max: 10_000_000 },
      egenkapital: { min: 0 },
      resultat: 'overskud',
      regnskabsklasse: ['B', 'C-lille'],
      selskabskapital: { min: 40_000 },
    };
    expect(narrowVirksomhedFilters(raw)).toEqual(raw);
  });

  it('drops invalid types', () => {
    const raw = {
      status: 'Normal', // ikke array
      stiftet: [2020, 2025], // array, ikke objekt
      omsaetning: 'mange', // ikke objekt
      resultat: 42, // ikke string
      regnskabsklasse: 'B', // ikke array
    };
    expect(narrowVirksomhedFilters(raw)).toEqual({
      status: undefined,
      virksomhedsform: undefined,
      branche: undefined,
      kommune: undefined,
      stiftet: undefined,
      antalAnsatte: undefined,
      omsaetning: undefined,
      egenkapital: undefined,
      resultat: undefined,
      regnskabsklasse: undefined,
      selskabskapital: undefined,
    });
  });
});
