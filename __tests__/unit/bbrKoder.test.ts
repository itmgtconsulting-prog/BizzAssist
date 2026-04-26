/**
 * Unit tests for the bbrKoder module.
 *
 * Each exported lookup function is tested with:
 *  - A known valid code
 *  - A second known valid code (where the table has multiple entries)
 *  - null input  → returns '–'
 *  - undefined input → returns '–'
 *  - Unknown/invalid code → returns 'Ukendt (<kode>)'
 *
 * boligtypeTekst and ejerforholdTekst use string keys, so those get their
 * own sections with appropriate string-based inputs.
 */
import { describe, it, expect } from 'vitest';
import {
  tagKonstruktionTekst,
  tagMaterialeTekst,
  ydervaegMaterialeTekst,
  varmeInstallationTekst,
  opvarmningsformTekst,
  opvarmningsmiddelTekst,
  vandforsyningTekst,
  afloebsforholdTekst,
  supplerendeVarmeTekst,
  bygAnvendelseTekst,
  bygStatusTekst,
  enhedAnvendelseTekst,
  enhedStatusTekst,
  toiletforholdTekst,
  badeforholdTekst,
  koekkforholdTekst,
  boligtypeTekst,
  energiforsyningTekst,
  ejerforholdTekst,
  isUdfasetStatusCode,
  udfasetLabelForCode,
  BBR_STATUS_UDFASET,
  BBR_STATUS_RETIRED,
  BBR_STATUS_AKTIV,
  DAR_STATUS,
} from '@/app/lib/bbrKoder';

// ─────────────────────────────────────────────────────────────────────────────
// Helper to run the standard null / undefined / unknown pattern
// ─────────────────────────────────────────────────────────────────────────────

function describeNumericLookup(
  label: string,
  fn: (kode: number | null | undefined) => string,
  validCases: Array<[number, string]>,
  unknownCode = 9999
) {
  describe(label, () => {
    it.each(validCases)('code %i → "%s"', (kode, expected) => {
      expect(fn(kode)).toBe(expected);
    });

    it('returns "–" for null', () => {
      expect(fn(null)).toBe('–');
    });

    it('returns "–" for undefined', () => {
      expect(fn(undefined)).toBe('–');
    });

    it(`returns "Ukendt (${unknownCode})" for unknown code`, () => {
      expect(fn(unknownCode)).toBe(`Ukendt (${unknownCode})`);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Numeric-keyed lookup functions
// ─────────────────────────────────────────────────────────────────────────────

describeNumericLookup('tagKonstruktionTekst', tagKonstruktionTekst, [
  [1, 'Fladt tag'],
  [2, 'Ensidig taghældning'],
  [3, 'Sadeltag'],
  [4, 'Valmet tag'],
  [5, 'Mansardtag'],
  [6, 'Andet tag'],
  [7, 'Ingen oplysning'],
]);

describeNumericLookup('tagMaterialeTekst', tagMaterialeTekst, [
  [1, 'Betontagsten'],
  [2, 'Tegltagsten'],
  [3, 'Fibercement/asbest'],
  [4, 'Cementsten'],
  [5, 'Naturskifer'],
  [6, 'Fibercement (non-asbest)'],
  [7, 'Metalplader'],
  [8, 'Strå/rør'],
  [10, 'Tagpap m. ophæng'],
  [11, 'Tagpap u. ophæng'],
  [12, 'Glas'],
  [20, 'Grønt tag'],
  [90, 'Andet materiale'],
  [99, 'Ingen oplysning'],
]);

describeNumericLookup('ydervaegMaterialeTekst', ydervaegMaterialeTekst, [
  [1, 'Mursten'],
  [2, 'Letbeton/gasbeton'],
  [3, 'Fibercement/eternit (asbest)'],
  [4, 'Bindingsværk'],
  [5, 'Træ'],
  [6, 'Betonsten'],
  [7, 'Metal'],
  [8, 'Glas'],
  [10, 'Fibercement (non-asbest)'],
  [11, 'Ingen ydervæg'],
  [12, 'Letklinker'],
  [13, 'Plast'],
  [14, 'Beton'],
  [20, 'Kombination'],
  [90, 'Andet materiale'],
  [99, 'Ingen oplysning'],
]);

describeNumericLookup('varmeInstallationTekst', varmeInstallationTekst, [
  [1, 'Fjernvarme / blokvarme'],
  [2, 'Centralvarme, 1 anlæg'],
  [3, 'Ovne til fast/flydende brændsel'],
  [4, 'Varmepumpe'],
  [5, 'Centralvarme, 2 anlæg'],
  [6, 'Biobrændselsanlæg'],
  [7, 'Elvarme'],
  [8, 'Gasradiator'],
  [9, 'Ingen varmeinstallation'],
  [10, 'Solvarme'],
  [99, 'Ingen oplysning'],
]);

describeNumericLookup('opvarmningsformTekst', opvarmningsformTekst, [
  [1, 'Damp'],
  [2, 'Varmt vand'],
  [3, 'El'],
  [4, 'Luft'],
  [5, 'Strålevarme'],
  [6, 'Jordvarme'],
  [9, 'Ingen'],
  [99, 'Ingen oplysning'],
]);

describeNumericLookup('vandforsyningTekst', vandforsyningTekst, [
  [1, 'Alment vandforsyningsanlæg'],
  [2, 'Privat vandforsyningsanlæg'],
  [3, 'Enkeltindvinding'],
  [4, 'Brønd'],
  [6, 'Ingen vandindlæg'],
  [7, 'Blandet vandforsyning'],
  [9, 'Ingen oplysning'],
]);

describeNumericLookup('afloebsforholdTekst', afloebsforholdTekst, [
  [1, 'Afløb til kloaksystem'],
  [2, 'Afløb til samletank'],
  [3, 'Afløb til spildevandsanlæg'],
  [4, 'Afløb til spildevandssystem'],
  [5, 'Intet afløb'],
  [6, 'Blandet afløb'],
  [9, 'Ingen oplysning'],
  [10, 'Afløb til anden recipient'],
  [11, 'Afløb til havmiljø'],
  [20, 'Afløb til kommunal kloak'],
  [29, 'Ingen oplysning'],
]);

describeNumericLookup('supplerendeVarmeTekst', supplerendeVarmeTekst, [
  [1, 'Varmepumpe'],
  [2, 'Brændeovn / pejs'],
  [3, 'Solpaneler / solfangere'],
  [4, 'Gasradiator(er)'],
  [5, 'Elradiator(er)'],
  [6, 'Biogasanlæg'],
  [7, 'Andet'],
  [99, 'Ingen oplysning'],
]);

describeNumericLookup('bygAnvendelseTekst', bygAnvendelseTekst, [
  [110, 'Stuehus til landbrugsejendom'],
  [120, 'Fritliggende enfamilieshus'],
  [130, 'Række-, kæde- eller dobbelthus'],
  [140, 'Etagebolig til helårsbeboelse'],
  [190, 'Anden helårsbeboelse'],
  [210, 'Erhvervsmæssig produktion'],
  [221, 'Bygning til industri med integreret produktionsapparat'],
  [310, 'Transport/garage'],
  [321, 'Bygning til kontor'],
  [331, 'Café/restaurant'],
  [416, 'Skole'],
  [510, 'Sommerhus'],
  [520, 'Kolonihavehus'],
  [530, 'Feriehus til udlejning'],
  [540, 'Campinghytte'],
  [910, 'Garage'],
  [920, 'Carport'],
  [930, 'Udhus'],
  [999, 'Ingen oplysning'],
]);

describeNumericLookup('bygStatusTekst', bygStatusTekst, [
  [1, 'Projekteret bygning'],
  [2, 'Bygning under opførelse'],
  [3, 'Bygning opført'],
  [4, 'Nedrevet/slettet'],
  [5, 'Kondemneret'],
  [6, 'Bygning opført'],
  [7, 'Midlertidig opførelse'],
  [10, 'Bygning nedrevet'],
  [11, 'Bygning bortfaldet'],
]);

describeNumericLookup('enhedAnvendelseTekst', enhedAnvendelseTekst, [
  [110, 'Helårsbeboelse'],
  [120, 'Helårsbeboelse'],
  [121, 'Helårsbeboelse (ejerbolig)'],
  [122, 'Helårsbeboelse (udlejning)'],
  [130, 'Rækkehus'],
  [140, 'Etagelejlighed'],
  [310, 'Transport/garage'],
  [320, 'Kontor/handel/lager/administration'],
  [321, 'Kontor'],
  [322, 'Butik'],
  [910, 'Garage'],
  [920, 'Carport'],
  [990, 'Andet'],
]);

describeNumericLookup('enhedStatusTekst', enhedStatusTekst, [
  [1, 'Til udlejning'],
  [2, 'Beboet af ejer'],
  [3, 'Ledigt'],
  [4, 'Til salg'],
  [5, 'Under opførelse'],
  [6, 'Under nedrivning'],
  [10, 'Nedrevet'],
  [11, 'Bortfaldet'],
]);

describeNumericLookup('toiletforholdTekst', toiletforholdTekst, [
  [1, 'Eget toilet'],
  [2, 'Fælles toilet'],
  [3, 'Ingen toilet'],
  [10, 'Ikke oplyst'],
]);

describeNumericLookup('badeforholdTekst', badeforholdTekst, [
  [1, 'Eget bad'],
  [2, 'Fælles bad'],
  [3, 'Ingen bad'],
  [10, 'Ikke oplyst'],
]);

describeNumericLookup('koekkforholdTekst', koekkforholdTekst, [
  [1, 'Eget køkken med afløb og kogeinstallation'],
  [2, 'Eget køkken med afløb, uden kogeinstallation'],
  [3, 'Eget køkken uden afløb'],
  [4, 'Fælles køkken'],
  [5, 'Ingen køkken'],
  [10, 'Ikke oplyst'],
]);

describeNumericLookup('energiforsyningTekst', energiforsyningTekst, [
  [1, 'Gas fra værk'],
  [2, '230 V el fra værk'],
  [3, '400 V el fra værk'],
  [4, '230 V el + gas fra værk'],
  [5, '400 V el + gas fra værk'],
  [6, 'Hverken el eller gas'],
]);

// ─────────────────────────────────────────────────────────────────────────────
// opvarmningsmiddelTekst — alias for opvarmningsformTekst
// ─────────────────────────────────────────────────────────────────────────────

describe('opvarmningsmiddelTekst (alias for opvarmningsformTekst)', () => {
  it('code 1 → "Damp"', () => {
    expect(opvarmningsmiddelTekst(1)).toBe('Damp');
  });

  it('code 3 → "El"', () => {
    expect(opvarmningsmiddelTekst(3)).toBe('El');
  });

  it('code 99 → "Ingen oplysning"', () => {
    expect(opvarmningsmiddelTekst(99)).toBe('Ingen oplysning');
  });

  it('returns "–" for null', () => {
    expect(opvarmningsmiddelTekst(null)).toBe('–');
  });

  it('returns "–" for undefined', () => {
    expect(opvarmningsmiddelTekst(undefined)).toBe('–');
  });

  it('returns "Ukendt (42)" for unknown code 42', () => {
    expect(opvarmningsmiddelTekst(42)).toBe('Ukendt (42)');
  });

  it('produces the same result as opvarmningsformTekst for all valid codes', () => {
    const codes = [1, 2, 3, 4, 5, 6, 9, 99];
    for (const code of codes) {
      expect(opvarmningsmiddelTekst(code)).toBe(opvarmningsformTekst(code));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// boligtypeTekst — string-keyed lookup
// ─────────────────────────────────────────────────────────────────────────────

describe('boligtypeTekst', () => {
  const cases: Array<[string, string]> = [
    ['1', 'Egentlig beboelseslejlighed'],
    ['2', 'Blandet bolig og erhverv'],
    ['3', 'Enkeltværelse'],
    ['4', 'Fællesbolig'],
    ['5', 'Sommer-/fritidsbolig'],
    ['E', 'Andet (erhverv/institution)'],
  ];

  it.each(cases)('code "%s" → "%s"', (kode, expected) => {
    expect(boligtypeTekst(kode)).toBe(expected);
  });

  it('returns "–" for null', () => {
    expect(boligtypeTekst(null)).toBe('–');
  });

  it('returns "–" for undefined', () => {
    expect(boligtypeTekst(undefined)).toBe('–');
  });

  it('returns "–" for empty string', () => {
    expect(boligtypeTekst('')).toBe('–');
  });

  it('returns "Ukendt (X)" for unknown string code', () => {
    expect(boligtypeTekst('X')).toBe('Ukendt (X)');
  });

  it('returns "Ukendt (9)" for unknown code "9"', () => {
    expect(boligtypeTekst('9')).toBe('Ukendt (9)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ejerforholdTekst — string-keyed lookup
// ─────────────────────────────────────────────────────────────────────────────

describe('ejerforholdTekst', () => {
  const cases: Array<[string, string]> = [
    ['10', 'Privatpersoner eller I/S'],
    ['20', 'A/S, ApS eller P/S'],
    ['30', 'Forening, legat eller selvejende institution'],
    ['40', 'Offentlig myndighed'],
    ['41', 'Staten'],
    ['50', 'Andelsboligforening'],
    ['60', 'Almennyttigt boligselskab'],
    ['70', 'Fond'],
    ['80', 'Andet'],
    ['90', 'Ikke oplyst'],
  ];

  it.each(cases)('code "%s" → "%s"', (kode, expected) => {
    expect(ejerforholdTekst(kode)).toBe(expected);
  });

  it('returns "–" for null', () => {
    expect(ejerforholdTekst(null)).toBe('–');
  });

  it('returns "–" for undefined', () => {
    expect(ejerforholdTekst(undefined)).toBe('–');
  });

  it('returns "–" for empty string', () => {
    expect(ejerforholdTekst('')).toBe('–');
  });

  it('returns "Ukendt (99)" for unknown code "99"', () => {
    expect(ejerforholdTekst('99')).toBe('Ukendt (99)');
  });

  it('returns "Ukendt (1)" for unknown code "1"', () => {
    expect(ejerforholdTekst('1')).toBe('Ukendt (1)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BIZZ-825: Udfaset-kode-mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('BBR_STATUS_UDFASET constant', () => {
  it('contains exactly {4, 10, 11}', () => {
    expect(BBR_STATUS_UDFASET.has(4)).toBe(true);
    expect(BBR_STATUS_UDFASET.has(10)).toBe(true);
    expect(BBR_STATUS_UDFASET.has(11)).toBe(true);
    expect(BBR_STATUS_UDFASET.size).toBe(3);
  });
});

describe('isUdfasetStatusCode', () => {
  it('returns true for retired codes', () => {
    expect(isUdfasetStatusCode(4)).toBe(true);
    expect(isUdfasetStatusCode(10)).toBe(true);
    expect(isUdfasetStatusCode(11)).toBe(true);
  });

  it('returns false for active codes', () => {
    expect(isUdfasetStatusCode(1)).toBe(false);
    expect(isUdfasetStatusCode(3)).toBe(false);
    expect(isUdfasetStatusCode(5)).toBe(false);
  });

  it('accepts numeric strings for robustness', () => {
    expect(isUdfasetStatusCode('4')).toBe(true);
    expect(isUdfasetStatusCode('10')).toBe(true);
    expect(isUdfasetStatusCode('3')).toBe(false);
  });

  it('returns false for null/undefined/non-numeric', () => {
    expect(isUdfasetStatusCode(null)).toBe(false);
    expect(isUdfasetStatusCode(undefined)).toBe(false);
    expect(isUdfasetStatusCode('abc')).toBe(false);
    expect(isUdfasetStatusCode('')).toBe(false);
  });
});

describe('udfasetLabelForCode', () => {
  it('returns DA label by default', () => {
    expect(udfasetLabelForCode(4)).toBe('Nedrevet/slettet');
    expect(udfasetLabelForCode(10)).toBe('Bygning nedrevet');
    expect(udfasetLabelForCode(11)).toBe('Bygning bortfaldet');
  });

  it('returns EN label when requested', () => {
    expect(udfasetLabelForCode(4, 'en')).toBe('Demolished/deleted');
    expect(udfasetLabelForCode(10, 'en')).toBe('Building demolished');
    expect(udfasetLabelForCode(3, 'en')).toBe('Building constructed');
  });

  it('returns null for unknown/missing', () => {
    expect(udfasetLabelForCode(null)).toBeNull();
    expect(udfasetLabelForCode(undefined)).toBeNull();
    expect(udfasetLabelForCode(999)).toBeNull();
    expect(udfasetLabelForCode('abc')).toBeNull();
  });

  it('accepts numeric strings', () => {
    expect(udfasetLabelForCode('4')).toBe('Nedrevet/slettet');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BIZZ-836: BBR_STATUS_RETIRED, BBR_STATUS_AKTIV, DAR_STATUS
// ─────────────────────────────────────────────────────────────────────────────

describe('BBR_STATUS_RETIRED', () => {
  it('contains all retired status labels', () => {
    expect(BBR_STATUS_RETIRED.has('Nedrevet/slettet')).toBe(true);
    expect(BBR_STATUS_RETIRED.has('Bygning nedrevet')).toBe(true);
    expect(BBR_STATUS_RETIRED.has('Bygning bortfaldet')).toBe(true);
  });

  it('does not contain active labels', () => {
    expect(BBR_STATUS_RETIRED.has('Bygning opført')).toBe(false);
    expect(BBR_STATUS_RETIRED.has('Projekteret bygning')).toBe(false);
  });

  it('is consistent with BBR_STATUS_UDFASET code set', () => {
    expect(BBR_STATUS_RETIRED.size).toBe(BBR_STATUS_UDFASET.size);
  });
});

describe('BBR_STATUS_AKTIV', () => {
  it('contains active status codes as strings', () => {
    for (const code of ['1', '2', '3', '6', '7']) {
      expect(BBR_STATUS_AKTIV.has(code)).toBe(true);
    }
  });

  it('excludes retired codes', () => {
    for (const code of ['4', '10', '11']) {
      expect(BBR_STATUS_AKTIV.has(code)).toBe(false);
    }
  });
});

describe('DAR_STATUS', () => {
  it('has correct Danish status values', () => {
    expect(DAR_STATUS.Gaeldende).toBe('Gældende');
    expect(DAR_STATUS.Forelobig).toBe('Foreløbig');
    expect(DAR_STATUS.Nedlagt).toBe('Nedlagt');
    expect(DAR_STATUS.Henlagt).toBe('Henlagt');
  });

  it('has exactly 4 entries', () => {
    expect(Object.keys(DAR_STATUS)).toHaveLength(4);
  });
});
