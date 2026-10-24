/**
 * Unit tests for getCompanyContact (BIZZ-2303).
 *
 * Verificerer at offentlig virksomheds-kontakt hentes fra CVR, at telefon/email
 * falder tilbage til P-enheden når virksomheds-niveauet er tomt, og at fejl/
 * manglende data degraderer til null (kaster aldrig).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/app/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { getCompanyContact } from '@/app/lib/cvr/companyContact';

/** Byg et ES-lignende svar med de givne hits. */
const esResponse = (hits: unknown[]) =>
  ({ ok: true, json: async () => ({ hits: { hits } }) }) as unknown as Response;

const ORIGINAL_ENV = { ...process.env };

describe('getCompanyContact', () => {
  beforeEach(() => {
    process.env.CVR_ES_USER = 'u';
    process.env.CVR_ES_PASS = 'p';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it('henter navn + adresse + telefon + email fra virksomheds-niveau (ingen P-enhed-kald)', async () => {
    const fetchMock = vi.fn(async () =>
      esResponse([
        {
          _source: {
            Vrvirksomhed: {
              navne: [{ navn: 'Test ApS', periode: { gyldigTil: null } }],
              beliggenhedsadresse: [
                {
                  vejnavn: 'Gungevej',
                  husnummerFra: 15,
                  postnummer: 2650,
                  postdistrikt: 'Hvidovre',
                  periode: { gyldigTil: null },
                },
              ],
              telefonnummer: [{ kontaktoplysning: '12345678', periode: { gyldigTil: null } }],
              emailadresse: [{ kontaktoplysning: 'a@b.dk', periode: { gyldigTil: null } }],
            },
          },
        },
      ])
    );
    vi.stubGlobal('fetch', fetchMock);

    const c = await getCompanyContact(12345678);
    expect(c).toEqual({
      cvr: '12345678',
      navn: 'Test ApS',
      adresse: 'Gungevej 15, 2650 Hvidovre',
      telefon: '12345678',
      email: 'a@b.dk',
    });
    // Begge kontaktfelter fundet på virksomheds-niveau → ingen P-enhed-opslag
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falder tilbage til P-enhed for telefon når virksomheds-niveau er tomt', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).includes('/virksomhed/')) {
        return esResponse([
          {
            _source: {
              Vrvirksomhed: {
                navne: [{ navn: 'Holding ApS', periode: { gyldigTil: null } }],
                beliggenhedsadresse: [
                  {
                    vejnavn: 'I C Lembrechts Alle',
                    husnummerFra: 29,
                    bogstavFra: 'B',
                    postnummer: 2650,
                    postdistrikt: 'Hvidovre',
                    periode: { gyldigTil: null },
                  },
                ],
                telefonnummer: [],
                emailadresse: [],
              },
            },
          },
        ]);
      }
      return esResponse([
        {
          _source: {
            VrproduktionsEnhed: {
              telefonNummer: [{ kontaktoplysning: '36771017', periode: { gyldigTil: null } }],
              elektroniskPost: [],
            },
          },
        },
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const c = await getCompanyContact(25260880);
    expect(c?.adresse).toBe('I C Lembrechts Alle 29B, 2650 Hvidovre');
    expect(c?.telefon).toBe('36771017');
    expect(c?.email).toBeNull();
    expect(urls.some((u) => u.includes('/produktionsenhed/'))).toBe(true);
  });

  it('returnerer null uden CVR-credentials (og rammer ikke netværket)', async () => {
    delete process.env.CVR_ES_USER;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await getCompanyContact(12345678)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returnerer null når selskabet ikke findes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => esResponse([]))
    );
    expect(await getCompanyContact(99999999)).toBeNull();
  });

  it('kaster ikke ved netværksfejl — degraderer til null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network');
      })
    );
    await expect(getCompanyContact(12345678)).resolves.toBeNull();
  });
});
