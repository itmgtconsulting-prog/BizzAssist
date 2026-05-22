/**
 * BIZZ-1742: Unit tests for vurderingsrapport tab generation.
 *
 * Tests:
 * 1. Zod schema validation for all 8 tab outputs
 * 2. buildTabSystemPrompt returns valid prompts for all tabs
 * 3. TAB_SCHEMAS covers all 8 tab keys
 * 4. Reference fixture validation rules
 */

import { describe, it, expect } from 'vitest';
import {
  identifikationSchema,
  bygningsdataSchema,
  energiSchema,
  vurderingSkatSchema,
  tinglysningSchema,
  servitutterSchema,
  beliggenhedSchema,
  risikoSchema,
  TAB_SCHEMAS,
  buildTabSystemPrompt,
} from '@/app/lib/vurdering/tabPrompts';
import fixture from '../../fixtures/vurderingsrapport/reference-villa-2800.json';

describe('tabPrompts Zod schemas', () => {
  it('identifikationSchema validates correct input', () => {
    const input = {
      sagsoplysninger: 'Sag 2024-001, Jensen Holding ApS',
      ejendomsbetegnelse: 'Skovvej 42, 2800 Kongens Lyngby, BFE 10012345',
      ejendomskategori: 'Parcelhus, Byzone',
      ejerforhold: 'Privatperson (kode 10)',
    };
    expect(identifikationSchema.safeParse(input).success).toBe(true);
  });

  it('bygningsdataSchema validates correct input', () => {
    const input = {
      oversigt: 'Parcelhus fra 1952, 142 m² boligareal',
      konstruktion: 'Mursten ydervæg, tegl tag, 1 etage',
      arealer: '142 m² bebygget, 845 m² grund',
      tilstand: 'Opført 1952, tilbygget 1998',
    };
    expect(bygningsdataSchema.safeParse(input).success).toBe(true);
  });

  it('energiSchema validates correct input', () => {
    const input = {
      energimaerke: 'Energimærke D (middel)',
      opvarmning: 'Fjernvarme',
      forsyning: 'Alment vandforsyningsanlæg',
      miljoevurdering: 'Middel energieffektivitet',
    };
    expect(energiSchema.safeParse(input).success).toBe(true);
  });

  it('vurderingSkatSchema validates correct input', () => {
    const input = {
      ejendomsvaerdi: 'Vurderet til 5.200.000 DKK (2024)',
      grundvaerdi: 'Grundværdi 2.800.000 DKK',
      skatteberegning: 'Grundskyld: 2.800.000 × 26,2‰ = 73.360 DKK/år',
      sammenfatning: 'Moderat skattebelastning for området',
    };
    expect(vurderingSkatSchema.safeParse(input).success).toBe(true);
  });

  it('tinglysningSchema validates correct input', () => {
    const input = {
      adkomst: 'Jensen Holding ApS ejer 100% siden 2018',
      handelshistorik: 'Købt for 4.500.000 DKK i 2018',
      haeftelser: 'Realkreditpantebrev 3.600.000 DKK, restgæld 2.900.000 DKK',
    };
    expect(tinglysningSchema.safeParse(input).success).toBe(true);
  });

  it('servitutterSchema validates correct input', () => {
    const input = {
      oversigt: '1 servitut tinglyst',
      vaesentlige: 'Byggelinje 5m fra vejskel',
      vurdering: 'Ingen væsentlig byrde',
    };
    expect(servitutterSchema.safeParse(input).success).toBe(true);
  });

  it('beliggenhedSchema validates correct input', () => {
    const input = {
      beliggenhed: 'Attraktivt villakvarter i Kongens Lyngby',
      planforhold: 'Byzone, Lyngby-Taarbæk Kommune',
      omsaettelighed: 'Høj efterspørgsel, god omsættelighed',
    };
    expect(beliggenhedSchema.safeParse(input).success).toBe(true);
  });

  it('risikoSchema validates correct input', () => {
    const input = {
      miljoe: 'Ingen kendte jordforureninger',
      klima: 'Lav oversvømmelsesrisiko',
      byggeteknisk: 'Opført 1952 — undersøg for asbest',
      samletVurdering: 'Lav samlet risiko',
    };
    expect(risikoSchema.safeParse(input).success).toBe(true);
  });

  it('schemas reject missing fields', () => {
    expect(identifikationSchema.safeParse({ sagsoplysninger: 'test' }).success).toBe(false);
    expect(bygningsdataSchema.safeParse({}).success).toBe(false);
    expect(tinglysningSchema.safeParse({ adkomst: 'test' }).success).toBe(false);
  });
});

describe('TAB_SCHEMAS registry', () => {
  const allTabs = [
    'identifikation',
    'bygningsdata',
    'energi',
    'vurdering_skat',
    'tinglysning',
    'servitutter',
    'beliggenhed',
    'risiko',
  ];

  it('covers all 8 tab keys', () => {
    for (const key of allTabs) {
      expect(TAB_SCHEMAS[key]).toBeDefined();
    }
  });

  it('has no extra keys', () => {
    expect(Object.keys(TAB_SCHEMAS).sort()).toEqual(allTabs.sort());
  });
});

describe('buildTabSystemPrompt', () => {
  const allTabs = [
    'identifikation',
    'bygningsdata',
    'energi',
    'vurdering_skat',
    'tinglysning',
    'servitutter',
    'beliggenhed',
    'risiko',
  ];

  it('returns non-null prompt for all tab keys', () => {
    for (const key of allTabs) {
      const prompt = buildTabSystemPrompt(key, 'realkredit', 'SAG-001');
      expect(prompt).not.toBeNull();
      expect(typeof prompt).toBe('string');
      expect(prompt!.length).toBeGreaterThan(50);
    }
  });

  it('returns null for unknown tab key', () => {
    expect(buildTabSystemPrompt('nonexistent', 'realkredit')).toBeNull();
  });

  it('includes rapport tone in prompts', () => {
    const prompt = buildTabSystemPrompt('bygningsdata', 'bankraadgiver');
    expect(prompt).toContain('bankraadgiver');
  });

  it('includes sagNummer in identifikation prompt', () => {
    const prompt = buildTabSystemPrompt('identifikation', 'realkredit', 'SAG-2024-001');
    expect(prompt).toContain('SAG-2024-001');
  });
});

describe('reference fixture validation', () => {
  it('fixture has all 8 tabs', () => {
    const tabs = Object.keys(fixture.tabs);
    expect(tabs).toContain('identifikation');
    expect(tabs).toContain('bygningsdata');
    expect(tabs).toContain('energi');
    expect(tabs).toContain('vurdering_skat');
    expect(tabs).toContain('tinglysning');
    expect(tabs).toContain('servitutter');
    expect(tabs).toContain('beliggenhed');
    expect(tabs).toContain('risiko');
  });

  it('exact match fields have expected values', () => {
    expect(fixture.tabs.identifikation.bfe).toBe(10012345);
    expect(fixture.tabs.vurdering_skat.ejendomsvaerdi).toBe(5200000);
    expect(fixture.tabs.vurdering_skat.grundvaerdi).toBe(2800000);
    expect(fixture.tabs.bygningsdata.opfoerelsesaar).toBe(1952);
    expect(fixture.tabs.bygningsdata.samletBoligareal).toBe(142);
    expect(fixture.tabs.tinglysning.salgshistorik[0].kontantPris).toBe(4500000);
  });

  it('non-null fields are populated', () => {
    expect(fixture.tabs.identifikation.adresse).toBeTruthy();
    expect(fixture.tabs.identifikation.kommune).toBeTruthy();
    expect(fixture.tabs.bygningsdata.grundareal).toBeTruthy();
    expect(fixture.tabs.energi.energimaerke).toBeTruthy();
    expect(fixture.tabs.tinglysning.ejere.length).toBeGreaterThan(0);
  });

  it('referenceejendomme have kvm-pris', () => {
    const refs = fixture.tabs.risiko.referenceejendomme;
    expect(refs.length).toBeGreaterThanOrEqual(3);
    for (const ref of refs) {
      expect(ref.kvmPris).toBeGreaterThan(0);
      expect(ref.adresse).toBeTruthy();
      expect(ref.salgsdato).toBeTruthy();
    }
  });

  it('trykproevning is within reasonable bounds', () => {
    const tp = fixture.tabs.risiko.trykproevning;
    expect(tp.ejendomKvmPris).toBeGreaterThan(0);
    expect(tp.referenceMedianKvmPris).toBeGreaterThan(0);
    expect(Math.abs(tp.afvigelseProcent)).toBeLessThan(50);
  });
});
