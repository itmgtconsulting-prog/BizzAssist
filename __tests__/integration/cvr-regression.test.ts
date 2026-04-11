/**
 * Regression tests for /api/cvr — CVR ElasticSearch route.
 *
 * These tests use **realistic** ES responses based on known companies at known
 * addresses. They verify the full pipeline: query → fetch → map → deduplicate →
 * sort → response shape.
 *
 * Known test data:
 *   - Arnold Nielsens Boulevard 64, 2650 Hvidovre (post office / multiple companies)
 *   - Søbyvej 11, 2650 Hvidovre (Pecunia IT / BizzAssist address)
 *
 * If these tests break after a code change, the CVR tab in the property detail
 * page is likely broken too.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock auth so route handlers can run outside a Next.js request scope
vi.mock('@/lib/api/auth', () => ({
  resolveTenantId: vi.fn().mockResolvedValue({ tenantId: 'test-tenant', userId: 'test-user' }),
}));

// ── Env & fetch mock ─────────────────────────────────────────────────────────

const VALID_USER = 'Pecunia_IT_Consulting_CVR_I_SKYEN';
const VALID_PASS = 'dummy-pass';
let mockFetch: ReturnType<typeof vi.fn>;
const originalEnv = { ...process.env };

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
  process.env.CVR_ES_USER = VALID_USER;
  process.env.CVR_ES_PASS = VALID_PASS;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  process.env = { ...originalEnv };
});

// ── Realistic ES hits ────────────────────────────────────────────────────────

/** Active company currently at the searched address */
function makeActiveHit(overrides?: Record<string, unknown>) {
  return {
    _source: {
      Vrvirksomhed: {
        cvrNummer: 44718502,
        navne: [{ periode: { gyldigTil: null }, navn: 'Pecunia IT ApS' }],
        beliggenhedsadresse: [
          {
            periode: { gyldigFra: '2022-04-01', gyldigTil: null },
            vejnavn: 'Søbyvej',
            husnummerFra: 11,
            bogstavFra: '',
            postnummer: 2650,
            postdistrikt: 'Hvidovre',
          },
        ],
        telefonnummer: [{ periode: { gyldigTil: null }, kontaktoplysning: '12345678' }],
        emailadresse: [{ periode: { gyldigTil: null }, kontaktoplysning: 'info@pecunia-it.dk' }],
        virksomhedsform: [{ periode: { gyldigTil: null }, kortBeskrivelse: 'ApS' }],
        virksomhedsstatus: [
          {
            periode: { gyldigTil: null },
            statuskode: 'NORMAL',
            gyldigFra: '2022-04-01',
          },
        ],
        virksomhedMetadata: { sammensatStatus: 'Aktiv' },
        livsforloeb: [{ periode: { gyldigTil: null } }],
        kvartalsbeskaeftigelse: [{ periode: { gyldigTil: null }, antalAnsatte: 3 }],
        penheder: [],
        hovedbranche: [
          {
            periode: { gyldigTil: null },
            branchekode: '620100',
            branchetekst: 'Computerprogrammering',
          },
        ],
        ...overrides,
      },
    },
  };
}

/** Defunct company that was previously at the searched address */
function makeDefunctHit() {
  return {
    _source: {
      Vrvirksomhed: {
        cvrNummer: 12345678,
        navne: [
          { periode: { gyldigTil: '2018-01-01' }, navn: 'GammelFirma ApS' },
          { periode: { gyldigTil: null }, navn: 'GammelFirma IVS (under afvikling)' },
        ],
        beliggenhedsadresse: [
          {
            periode: { gyldigFra: '2015-03-01', gyldigTil: '2019-06-30' },
            vejnavn: 'Søbyvej',
            husnummerFra: 11,
            bogstavFra: '',
            postnummer: 2650,
            postdistrikt: 'Hvidovre',
          },
          {
            periode: { gyldigFra: '2019-07-01', gyldigTil: null },
            vejnavn: 'Vesterbrogade',
            husnummerFra: 100,
            bogstavFra: '',
            postnummer: 1620,
            postdistrikt: 'København V',
          },
        ],
        telefonnummer: [],
        emailadresse: [],
        virksomhedsform: [{ periode: { gyldigTil: null }, kortBeskrivelse: 'IVS' }],
        virksomhedsstatus: [
          {
            periode: { gyldigTil: null },
            statuskode: 'UNDER_FRIVILLIG_LIKVIDATION',
            gyldigFra: '2020-01-01',
          },
        ],
        virksomhedMetadata: { sammensatStatus: 'Ophørt' },
        livsforloeb: [{ periode: { gyldigTil: '2021-03-15' } }],
        kvartalsbeskaeftigelse: [],
        penheder: [],
        hovedbranche: [
          {
            periode: { gyldigTil: null },
            branchekode: '561010',
            branchetekst: 'Restauranter',
          },
        ],
      },
    },
  };
}

/** Company matched via P-enhed (production unit), not juridisk adresse */
function makePenhedHit() {
  return {
    _source: {
      Vrvirksomhed: {
        cvrNummer: 99887766,
        navne: [{ periode: { gyldigTil: null }, navn: 'Hovedkontor A/S' }],
        beliggenhedsadresse: [
          {
            periode: { gyldigFra: '2010-01-01', gyldigTil: null },
            vejnavn: 'Nørregade',
            husnummerFra: 1,
            bogstavFra: '',
            postnummer: 1165,
            postdistrikt: 'København K',
          },
        ],
        telefonnummer: [],
        emailadresse: [],
        virksomhedsform: [{ periode: { gyldigTil: null }, kortBeskrivelse: 'A/S' }],
        virksomhedsstatus: [
          {
            periode: { gyldigTil: null },
            statuskode: 'NORMAL',
            gyldigFra: '2010-01-01',
          },
        ],
        virksomhedMetadata: { sammensatStatus: 'Aktiv' },
        livsforloeb: [{ periode: { gyldigTil: null } }],
        kvartalsbeskaeftigelse: [],
        penheder: [
          {
            beliggenhedsadresse: [
              {
                periode: { gyldigFra: '2020-01-01', gyldigTil: null },
                vejnavn: 'Søbyvej',
                husnummerFra: 11,
                bogstavFra: '',
                postnummer: 2650,
                postdistrikt: 'Hvidovre',
              },
            ],
          },
        ],
        hovedbranche: [
          {
            periode: { gyldigTil: null },
            branchekode: '702200',
            branchetekst: 'Virksomhedsrådgivning og anden rådgivning om driftsledelse',
          },
        ],
      },
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CVR regression — Søbyvej 11, 2650 Hvidovre', () => {
  it('maps an active company at the searched address with all fields', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ hits: { hits: [makeActiveHit()] } }),
    });

    vi.resetModules();
    process.env.CVR_ES_USER = VALID_USER;
    process.env.CVR_ES_PASS = VALID_PASS;
    const { GET } = await import('@/app/api/cvr/route');
    const req = new NextRequest(
      'http://localhost/api/cvr?vejnavn=S%C3%B8byvej&husnr=11&postnr=2650'
    );
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tokenMangler).toBe(false);
    expect(body.virksomheder).toHaveLength(1);

    const v = body.virksomheder[0];
    expect(v.cvr).toBe(44718502);
    expect(v.navn).toBe('Pecunia IT ApS');
    expect(v.adresse).toBe('Søbyvej 11');
    expect(v.postnr).toBe('2650');
    expect(v.by).toBe('Hvidovre');
    expect(v.telefon).toBe('12345678');
    expect(v.email).toBe('info@pecunia-it.dk');
    expect(v.branchekode).toBe(620100);
    expect(v.branche).toBe('Computerprogrammering');
    expect(v.type).toBe('ApS');
    expect(v.ansatte).toBe(3);
    expect(v.aktiv).toBe(true);
    expect(v.aktivFra).toBe('2022-04-01');
    expect(v.påAdressen).toBe(true);
    expect(v.adresseFra).toBe('2022-04-01');
    expect(v.adresseTil).toBeNull();
  });

  it('marks a defunct company as NOT on the address and includes move-away date', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ hits: { hits: [makeDefunctHit()] } }),
    });

    vi.resetModules();
    process.env.CVR_ES_USER = VALID_USER;
    process.env.CVR_ES_PASS = VALID_PASS;
    const { GET } = await import('@/app/api/cvr/route');
    const req = new NextRequest(
      'http://localhost/api/cvr?vejnavn=S%C3%B8byvej&husnr=11&postnr=2650'
    );
    const res = await GET(req);
    const body = await res.json();

    expect(body.virksomheder).toHaveLength(1);
    const v = body.virksomheder[0];
    expect(v.cvr).toBe(12345678);
    expect(v.aktiv).toBe(false);
    // Beliggenhedsadresse moved to Vesterbrogade — no longer at Søbyvej
    expect(v.påAdressen).toBe(false);
    expect(v.adresseFra).toBe('2015-03-01');
    expect(v.adresseTil).toBe('2019-06-30');
  });

  it('sorts active companies before defunct companies', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        hits: { hits: [makeDefunctHit(), makePenhedHit(), makeActiveHit()] },
      }),
    });

    vi.resetModules();
    process.env.CVR_ES_USER = VALID_USER;
    process.env.CVR_ES_PASS = VALID_PASS;
    const { GET } = await import('@/app/api/cvr/route');
    const req = new NextRequest(
      'http://localhost/api/cvr?vejnavn=S%C3%B8byvej&husnr=11&postnr=2650'
    );
    const res = await GET(req);
    const body = await res.json();

    expect(body.virksomheder).toHaveLength(3);
    // Both active companies (Pecunia IT + Hovedkontor A/S) come before defunct
    const activeCompanies = body.virksomheder.filter((v: { aktiv: boolean }) => v.aktiv);
    const defunctCompanies = body.virksomheder.filter((v: { aktiv: boolean }) => !v.aktiv);
    expect(activeCompanies).toHaveLength(2);
    expect(defunctCompanies).toHaveLength(1);
    // Defunct is always last
    expect(body.virksomheder[2].cvr).toBe(12345678); // GammelFirma — ophørt
    expect(body.virksomheder[2].aktiv).toBe(false);
  });

  it('deduplicates companies appearing in both beliggenhedsadresse and P-enhed results', async () => {
    // Same CVR appears twice — should be deduped to one
    const dup = makeActiveHit();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        hits: { hits: [dup, dup] },
      }),
    });

    vi.resetModules();
    process.env.CVR_ES_USER = VALID_USER;
    process.env.CVR_ES_PASS = VALID_PASS;
    const { GET } = await import('@/app/api/cvr/route');
    const req = new NextRequest(
      'http://localhost/api/cvr?vejnavn=S%C3%B8byvej&husnr=11&postnr=2650'
    );
    const res = await GET(req);
    const body = await res.json();

    expect(body.virksomheder).toHaveLength(1);
    expect(body.virksomheder[0].cvr).toBe(44718502);
  });

  it('handles husnummer with letter (e.g. 64B)', async () => {
    const hit = makeActiveHit({
      beliggenhedsadresse: [
        {
          periode: { gyldigFra: '2020-01-01', gyldigTil: null },
          vejnavn: 'Arnold Nielsens Boulevard',
          husnummerFra: 64,
          bogstavFra: 'B',
          postnummer: 2650,
          postdistrikt: 'Hvidovre',
        },
      ],
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ hits: { hits: [hit] } }),
    });

    vi.resetModules();
    process.env.CVR_ES_USER = VALID_USER;
    process.env.CVR_ES_PASS = VALID_PASS;
    const { GET } = await import('@/app/api/cvr/route');
    const req = new NextRequest(
      'http://localhost/api/cvr?vejnavn=Arnold+Nielsens+Boulevard&husnr=64B&postnr=2650'
    );
    const res = await GET(req);
    const body = await res.json();

    expect(body.virksomheder).toHaveLength(1);
    expect(body.virksomheder[0].adresse).toBe('Arnold Nielsens Boulevard 64B');
    expect(body.virksomheder[0].påAdressen).toBe(true);
  });

  it('includes etage and dør in ES query when provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ hits: { hits: [] } }),
    });

    vi.resetModules();
    process.env.CVR_ES_USER = VALID_USER;
    process.env.CVR_ES_PASS = VALID_PASS;
    const { GET } = await import('@/app/api/cvr/route');
    const req = new NextRequest(
      'http://localhost/api/cvr?vejnavn=S%C3%B8byvej&husnr=11&postnr=2650&etage=2&doer=th'
    );
    await GET(req);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const beligMust = body.query.bool.should[0].nested.query.bool.must;
    // Should have filters for etage and dør
    expect(beligMust).toContainEqual({
      match: { 'Vrvirksomhed.beliggenhedsadresse.etage': '2' },
    });
    expect(beligMust).toContainEqual({
      match: { 'Vrvirksomhed.beliggenhedsadresse.sidedoer': 'th' },
    });
  });

  it('sends correct Authorization header to CVR ES', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ hits: { hits: [] } }),
    });

    vi.resetModules();
    process.env.CVR_ES_USER = VALID_USER;
    process.env.CVR_ES_PASS = VALID_PASS;
    const { GET } = await import('@/app/api/cvr/route');
    const req = new NextRequest(
      'http://localhost/api/cvr?vejnavn=S%C3%B8byvej&husnr=11&postnr=2650'
    );
    await GET(req);

    const expectedAuth = Buffer.from(`${VALID_USER}:${VALID_PASS}`).toString('base64');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('distribution.virk.dk'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Basic ${expectedAuth}`,
        }),
      })
    );
  });

  it('returns empty list gracefully when ES returns non-200', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    });

    vi.resetModules();
    process.env.CVR_ES_USER = VALID_USER;
    process.env.CVR_ES_PASS = VALID_PASS;
    const { GET } = await import('@/app/api/cvr/route');
    const req = new NextRequest(
      'http://localhost/api/cvr?vejnavn=S%C3%B8byvej&husnr=11&postnr=2650'
    );
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.virksomheder).toEqual([]);
    expect(body.tokenMangler).toBe(false);
  });

  it('handles company with multiple name periods (picks current)', async () => {
    const hit = makeActiveHit({
      navne: [
        { periode: { gyldigFra: '2018-01-01', gyldigTil: '2022-03-31' }, navn: 'OldName ApS' },
        { periode: { gyldigFra: '2022-04-01', gyldigTil: null }, navn: 'NewName ApS' },
      ],
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ hits: { hits: [hit] } }),
    });

    vi.resetModules();
    process.env.CVR_ES_USER = VALID_USER;
    process.env.CVR_ES_PASS = VALID_PASS;
    const { GET } = await import('@/app/api/cvr/route');
    const req = new NextRequest(
      'http://localhost/api/cvr?vejnavn=S%C3%B8byvej&husnr=11&postnr=2650'
    );
    const res = await GET(req);
    const body = await res.json();

    expect(body.virksomheder[0].navn).toBe('NewName ApS');
  });

  it('sets Cache-Control header on successful response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ hits: { hits: [makeActiveHit()] } }),
    });

    vi.resetModules();
    process.env.CVR_ES_USER = VALID_USER;
    process.env.CVR_ES_PASS = VALID_PASS;
    const { GET } = await import('@/app/api/cvr/route');
    const req = new NextRequest(
      'http://localhost/api/cvr?vejnavn=S%C3%B8byvej&husnr=11&postnr=2650'
    );
    const res = await GET(req);

    expect(res.headers.get('cache-control')).toContain('s-maxage=1800');
  });
});
