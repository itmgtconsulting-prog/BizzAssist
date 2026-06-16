/**
 * Unit tests for BIZZ-2157 — deterministisk korrektion af bilforsikringer i
 * parserV2.
 *
 * Sikrer at en bilpolice der fejlklassificeres som "Ejendomsforsikring" med et
 * forsikringssted tvinges til "Bilforsikring" uden forsikringssted, og at
 * blandede aftaler ikke ødelægges.
 */
import { describe, it, expect } from 'vitest';
import {
  korrigerBilforsikring,
  extractRegistreringsnummer,
  type V2ParseResult,
} from '@/app/lib/forsikring/parserV2';

/** Byg et minimalt V2ParseResult med én forsikring + én enhed. */
function lavResultat(
  markdown: string,
  type: string,
  entity: Partial<V2ParseResult['insurances'][0]['entities'][0]['entity']>
): V2ParseResult {
  return {
    markdown,
    insurances: [
      {
        identification: {
          type,
          selskab: 'Alm. Brand Forsikring A/S',
          policenummer: '172 265 995',
          forsikringstager: 'Familien Petersen Ejendomme A/S',
          forsikringstager_cvr: '33058446',
        },
        entities: [
          {
            entity: {
              type: 'ejendom',
              label: 'VW Caddy',
              adresse: null,
              bfe: null,
              cvr: null,
              registreringsnummer: null,
              ...entity,
            },
            coverages: [],
          },
        ],
      },
    ],
    conditions: [],
  };
}

describe('extractRegistreringsnummer', () => {
  it('finder reg.nr uden mellemrum', () => {
    expect(extractRegistreringsnummer('Køretøj CE18728 VW Caddy')).toBe('CE18728');
  });
  it('finder reg.nr med mellemrum', () => {
    expect(extractRegistreringsnummer('Reg.nr: CE 18728')).toBe('CE18728');
  });
  it('returnerer null når intet reg.nr', () => {
    expect(extractRegistreringsnummer('Stjernegade 17, 3000 Helsingør')).toBeNull();
  });
});

describe('korrigerBilforsikring', () => {
  it('tvinger fejlklassificeret bilpolice til Bilforsikring uden forsikringssted', () => {
    const r = lavResultat(
      'Police - Bilforsikring\nVW Caddy CE18728\nKasko, Førerulykke',
      'Ejendomsforsikring',
      { adresse: 'Stjernegade 17, 3000 Helsingør', type: 'ejendom' }
    );
    korrigerBilforsikring(r);
    const ins = r.insurances[0];
    expect(ins.identification.type).toBe('Bilforsikring');
    expect(ins.entities[0].entity.adresse).toBeNull();
    expect(ins.entities[0].entity.type).toBe('bil');
    expect(ins.entities[0].entity.registreringsnummer).toBe('CE18728');
  });

  it('beholder forsikringssted og type for en ægte ejendomspolice', () => {
    const r = lavResultat(
      'Police - Ejendomsforsikring\nForsikringssted: Stjernegade 17\nBrand, Storm, Rørskade',
      'Ejendomsforsikring',
      { adresse: 'Stjernegade 17, 3000 Helsingør', type: 'ejendom' }
    );
    korrigerBilforsikring(r);
    const ins = r.insurances[0];
    expect(ins.identification.type).toBe('Ejendomsforsikring');
    expect(ins.entities[0].entity.adresse).toBe('Stjernegade 17, 3000 Helsingør');
  });

  it('nuller adresse på en enhed med reg.nr selv i en ikke-bil-typet forsikring', () => {
    const r = lavResultat('Erhvervsforsikring med diverse dækninger', 'Erhvervsforsikring', {
      adresse: 'Adressat-adresse 5',
      registreringsnummer: 'AB12345',
    });
    // Tilføj en ekstra forsikring så det ikke er en enkelt-police (undgå reclass)
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
            label: 'X',
            adresse: null,
            bfe: null,
            cvr: null,
            registreringsnummer: null,
          },
          coverages: [],
        },
      ],
    });
    korrigerBilforsikring(r);
    // enheden MED reg.nr fik nullet adresse via bil-reglen (type→bil, da enhedHarRegnr)
    expect(r.insurances[0].entities[0].entity.adresse).toBeNull();
  });

  it('lader en flertype-aftale uden bil-signaler være urørt', () => {
    const r: V2ParseResult = {
      markdown: 'Forsikringsaftale: Ansvar + Ejendom\nForsikringssted: Torvet 1',
      insurances: [
        {
          identification: {
            type: 'Ejendomsforsikring',
            selskab: null,
            policenummer: '1',
            forsikringstager: null,
            forsikringstager_cvr: null,
          },
          entities: [
            {
              entity: {
                type: 'ejendom',
                label: 'Torvet 1',
                adresse: 'Torvet 1',
                bfe: '123',
                cvr: null,
                registreringsnummer: null,
              },
              coverages: [],
            },
          ],
        },
        {
          identification: {
            type: 'Ansvarsforsikring',
            selskab: null,
            policenummer: '1',
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
        },
      ],
      conditions: [],
    };
    korrigerBilforsikring(r);
    expect(r.insurances[0].identification.type).toBe('Ejendomsforsikring');
    expect(r.insurances[0].entities[0].entity.adresse).toBe('Torvet 1');
    expect(r.insurances[1].identification.type).toBe('Ansvarsforsikring');
  });
});
