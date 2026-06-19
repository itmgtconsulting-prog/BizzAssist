/**
 * Unit tests for BIZZ-2138 — deterministisk korrektion af erhvervsforsikringer i
 * parserV2.
 *
 * Sikrer at en løsøre-/erhvervspolice der fejlklassificeres som
 * "Ejendomsforsikring" (fordi forsikringsstedet har en adresse) tvinges til
 * "Erhvervsforsikring", og at ægte ejendomspolicer + flertype-aftaler ikke
 * ødelægges.
 */
import { describe, it, expect } from 'vitest';
import {
  korrigerErhvervsforsikring,
  erErhvervsforsikringDokument,
  type V2ParseResult,
} from '@/app/lib/forsikring/parserV2';

/** Byg et minimalt V2ParseResult med én forsikring + én ejendoms-enhed. */
function lavResultat(markdown: string, type: string): V2ParseResult {
  return {
    markdown,
    insurances: [
      {
        identification: {
          type,
          selskab: 'Alm. Brand Forsikring A/S',
          policenummer: '60792275',
          forsikringstager: 'Familien Petersen Ejendomme A/S',
          forsikringstager_cvr: '33058446',
        },
        entities: [
          {
            entity: {
              type: 'ejendom',
              label: 'Torvegade 5',
              adresse: 'Torvegade 5, 3000 Helsingør',
              bfe: null,
              cvr: null,
              registreringsnummer: null,
            },
            coverages: [],
          },
        ],
      },
    ],
    conditions: [],
  };
}

describe('erErhvervsforsikringDokument', () => {
  it('genkender "Police - Erhvervsforsikring"-titel', () => {
    expect(erErhvervsforsikringDokument('Police - Erhvervsforsikring\nLøsøre')).toBe(true);
  });
  it('genkender betingelser nr. 2502', () => {
    expect(erErhvervsforsikringDokument('Forsikringsbetingelser nr. 2502 Erhvervsforsikring')).toBe(
      true
    );
  });
  it('returnerer false for en ren bygningspolice', () => {
    expect(
      erErhvervsforsikringDokument('Police - Ejendomsforsikring\nBrand, Storm, Rørskade på bygning')
    ).toBe(false);
  });
});

describe('korrigerErhvervsforsikring', () => {
  it('tvinger en fejlklassificeret erhvervspolice til Erhvervsforsikring', () => {
    const r = lavResultat(
      'Police - Erhvervsforsikring\nForsikringsbetingelser nr. 2502\nBrand, Tyveri, Vand på løsøre, Ran/røveri, Retshjælp',
      'Ejendomsforsikring'
    );
    korrigerErhvervsforsikring(r);
    expect(r.insurances[0].identification.type).toBe('Erhvervsforsikring');
  });

  it('beholder typen for en ægte bygningspolice uden erhvervs-signaler', () => {
    const r = lavResultat(
      'Police - Ejendomsforsikring\nForsikringssted: Torvegade 5\nBrand, Storm, Rørskade',
      'Ejendomsforsikring'
    );
    korrigerErhvervsforsikring(r);
    expect(r.insurances[0].identification.type).toBe('Ejendomsforsikring');
  });

  it('rører ikke en bilforsikring selv med erhvervs-signal i teksten', () => {
    const r = lavResultat('Police - Erhvervsforsikring og bil\nbetingelser 2502', 'Bilforsikring');
    korrigerErhvervsforsikring(r);
    expect(r.insurances[0].identification.type).toBe('Bilforsikring');
  });

  it('rører ikke et flertype-dokument (mere end én police)', () => {
    const r = lavResultat(
      'Police - Erhvervsforsikring\nbetingelser 2502\nogså Ejendomsforsikring',
      'Ejendomsforsikring'
    );
    r.insurances.push({
      identification: {
        type: 'Ansvarsforsikring',
        selskab: null,
        policenummer: '2',
        forsikringstager: null,
        forsikringstager_cvr: null,
      },
      entities: [
        {
          entity: {
            type: 'virksomhed',
            label: 'Firma',
            adresse: null,
            bfe: null,
            cvr: '12345678',
            registreringsnummer: null,
          },
          coverages: [],
        },
      ],
    });
    korrigerErhvervsforsikring(r);
    // Urørt: flertype-aftaler håndteres af prompten, ikke af det snævre guard
    expect(r.insurances[0].identification.type).toBe('Ejendomsforsikring');
  });
});
