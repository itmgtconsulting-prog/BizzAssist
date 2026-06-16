/**
 * BIZZ-2127: Unit-tests for forsikringTypeLabel — police-boksen i "Fundne
 * forsikringer" skal kategoriseres efter den dominerende dækningskategori
 * (fx bygningsdækninger → "Ejendomsforsikring"), ikke efter business_activity
 * som for Alm. Brand-bygningspolicer er bygningens anvendelse ("Restaurant og café").
 */
import { describe, it, expect } from 'vitest';
import {
  forsikringTypeLabel,
  eksplicitForsikringstype,
} from '@/app/dashboard/forsikring/ForsikringPageClient';

/** Bygger en minimal AnalyseCoverage */
function cov(code: string, isCovered = true) {
  return {
    policy_id: 'p1',
    coverage_code: code,
    coverage_label: code,
    is_covered: isCovered,
    sum_dkk: null,
    deductible_dkk: null,
  };
}

describe('forsikringTypeLabel (BIZZ-2127)', () => {
  it('Stengade 7-casen: bygningsdækninger + business_activity "Restaurant og café" → Ejendomsforsikring', () => {
    const covs = [
      cov('brand_el'),
      cov('bygningskasko'),
      cov('udvidet_roerskade'),
      cov('hus_grundejer_ansvar'),
    ];
    expect(forsikringTypeLabel(covs, 'Restaurant og café', true)).toBe('Ejendomsforsikring');
    expect(forsikringTypeLabel(covs, 'Restaurant og café', false)).toBe('Property insurance');
  });

  it('overvejende ansvarsdækninger → Ansvarsforsikring', () => {
    const covs = [
      cov('erhvervsansvar'),
      cov('forurening'),
      cov('fareafvaergelse' /* ukendt → ignoreres */),
    ];
    expect(forsikringTypeLabel(covs, 'Erhvervsansvar', true)).toBe('Ansvarsforsikring');
  });

  it('cyber-dækninger → Cyberforsikring', () => {
    expect(forsikringTypeLabel([cov('cyber'), cov('netbank')], null, true)).toBe('Cyberforsikring');
  });

  it('løsøre-dækninger → Løsøreforsikring', () => {
    expect(forsikringTypeLabel([cov('loesoere'), cov('indbrudstyveri')], null, true)).toBe(
      'Løsøreforsikring'
    );
  });

  it('ignorerer fravalgte (is_covered=false) dækninger ved kategorisering', () => {
    // Aktiv: 1 ansvar; fravalgt: 3 bygning → ansvar dominerer
    const covs = [
      cov('erhvervsansvar', true),
      cov('brand_el', false),
      cov('bygningskasko', false),
      cov('glas', false),
    ];
    expect(forsikringTypeLabel(covs, null, true)).toBe('Ansvarsforsikring');
  });

  it('falder tilbage til business_activity når ingen kategoriserbare dækninger findes', () => {
    expect(forsikringTypeLabel([], 'Speciel niche-forsikring', true)).toBe(
      'Speciel niche-forsikring'
    );
  });

  it('generisk fallback når hverken dækninger eller business_activity findes', () => {
    expect(forsikringTypeLabel([], null, true)).toBe('Forsikring');
    expect(forsikringTypeLabel([], null, false)).toBe('Insurance');
  });

  // BIZZ-2138: En eksplicit forsikringstype i business_activity vinder over
  // dæknings-heuristikken — en blandet erhvervspolice (løsøre + bygnings-nære
  // dækninger) må ikke fejlvises som "Ejendomsforsikring".
  it('erhvervspolice med blandede dækninger + business_activity "Erhvervsforsikring" → Erhvervsforsikring', () => {
    // Reelle dækninger for police 60792275: bygning (brand_el, hærværk,
    // udvidet_rørskade) tipper ellers heuristikken til "Ejendomsforsikring".
    const covs = [
      cov('brand_el'),
      cov('haerverk'),
      cov('udvidet_roerskade'),
      cov('indbrudstyveri'),
      cov('loesoere'),
      cov('ran_roeveri'),
      cov('kriminalitet'),
    ];
    expect(forsikringTypeLabel(covs, 'Erhvervsforsikring', true)).toBe('Erhvervsforsikring');
    expect(forsikringTypeLabel(covs, 'Erhvervsforsikring', false)).toBe('Commercial insurance');
  });

  it('bygnings-anvendelse ("Restaurant og café") matcher IKKE som eksplicit type', () => {
    expect(eksplicitForsikringstype('Restaurant og café', true)).toBeNull();
  });

  it('ukendt forsikringsstreng ("Speciel niche-forsikring") matcher ikke en kendt type', () => {
    expect(eksplicitForsikringstype('Speciel niche-forsikring', true)).toBeNull();
    // … og falder derfor tilbage til business_activity-strengen som før.
    expect(forsikringTypeLabel([], 'Speciel niche-forsikring', true)).toBe(
      'Speciel niche-forsikring'
    );
  });

  it('eksplicit type genkendes uafhængigt af store/små bogstaver og engelsk label', () => {
    expect(eksplicitForsikringstype('erhvervsforsikring', true)).toBe('Erhvervsforsikring');
    expect(eksplicitForsikringstype('Bilforsikring', false)).toBe('Motor insurance');
    expect(eksplicitForsikringstype('Bygningsforsikring', true)).toBe('Ejendomsforsikring');
  });
});
