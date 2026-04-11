/**
 * Integration tests for /api/cvr (CVR ElasticSearch system-to-system).
 *
 * Verifies:
 * - parseHusnr() splits number and letter correctly
 * - gyldigNu() finds the currently-valid period (gyldigTil == null)
 * - Route returns { virksomheder: [], tokenMangler: true } when credentials missing
 * - Route returns { virksomheder: [], tokenMangler: false } when vejnavn missing
 * - Route returns apiDown: true on timeout
 * - Mapping logic produces the correct CVRVirksomhed shape
 *
 * NOTE: No real network calls — all external fetches are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { parseHusnr, gyldigNu } from '@/app/api/cvr/route';

// Mock auth so route handlers can run outside a Next.js request scope
vi.mock('@/lib/api/auth', () => ({
  resolveTenantId: vi.fn().mockResolvedValue({ tenantId: 'test-tenant', userId: 'test-user' }),
}));

// ── Environment ───────────────────────────────────────────────────────────────

const VALID_USER = 'Pecunia_IT_Consulting_CVR_I_SKYEN';
const VALID_PASS = 'dummy-pass-for-tests';

// ── parseHusnr ────────────────────────────────────────────────────────────────

describe('parseHusnr', () => {
  it('splits numeric-only husnummer', () => {
    expect(parseHusnr('64')).toEqual({ nr: 64, bogstav: null });
  });

  it('splits husnummer with uppercase letter', () => {
    expect(parseHusnr('64B')).toEqual({ nr: 64, bogstav: 'B' });
  });

  it('normalises lowercase letter to uppercase', () => {
    expect(parseHusnr('12c')).toEqual({ nr: 12, bogstav: 'C' });
  });

  it('trims whitespace', () => {
    expect(parseHusnr(' 8 A ')).toEqual({ nr: 8, bogstav: 'A' });
  });

  it('returns nulls for empty string', () => {
    expect(parseHusnr('')).toEqual({ nr: null, bogstav: null });
  });
});

// ── gyldigNu ──────────────────────────────────────────────────────────────────

describe('gyldigNu', () => {
  it('returns element with gyldigTil == null (open period)', () => {
    const arr = [
      { periode: { gyldigTil: '2020-01-01' }, navn: 'Old' },
      { periode: { gyldigTil: null }, navn: 'Current' },
    ];
    expect(gyldigNu(arr)?.navn).toBe('Current');
  });

  it('returns last element as fallback when all periods are closed', () => {
    const arr = [
      { periode: { gyldigTil: '2018-01-01' }, navn: 'Older' },
      { periode: { gyldigTil: '2022-01-01' }, navn: 'Newer' },
    ];
    expect(gyldigNu(arr)?.navn).toBe('Newer');
  });

  it('returns null for empty array', () => {
    expect(gyldigNu([])).toBeNull();
  });
});

// ── Route handler ─────────────────────────────────────────────────────────────

describe('GET /api/cvr', () => {
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
    process.env = { ...originalEnv };
  });

  it('returns tokenMangler:false and empty list when vejnavn param is missing', async () => {
    const { GET } = await import('@/app/api/cvr/route');
    const req = new NextRequest('http://localhost/api/cvr');
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tokenMangler).toBe(false);
    expect(body.virksomheder).toEqual([]);
  });

  it('returns tokenMangler:true when CVR credentials are missing', async () => {
    delete process.env.CVR_ES_USER;
    delete process.env.CVR_ES_PASS;
    // Re-import to pick up env changes
    vi.resetModules();
    const { GET } = await import('@/app/api/cvr/route');
    const req = new NextRequest('http://localhost/api/cvr?vejnavn=Søbyvej&husnr=11&postnr=2650');
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tokenMangler).toBe(true);
    expect(body.virksomheder).toEqual([]);
  });

  it('returns apiDown:true when fetch throws a TimeoutError', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout');
    timeoutError.name = 'TimeoutError';
    mockFetch.mockRejectedValueOnce(timeoutError);

    vi.resetModules();
    process.env.CVR_ES_USER = VALID_USER;
    process.env.CVR_ES_PASS = VALID_PASS;
    const { GET } = await import('@/app/api/cvr/route');
    const req = new NextRequest('http://localhost/api/cvr?vejnavn=Søbyvej&husnr=11&postnr=2650');
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.apiDown).toBe(true);
    expect(body.virksomheder).toEqual([]);
  });

  it('maps ES hit correctly to CVRVirksomhed shape', async () => {
    const fakeHit = {
      _source: {
        Vrvirksomhed: {
          cvrNummer: 44718502,
          navne: [{ periode: { gyldigTil: null }, navn: 'Pecunia IT ApS' }],
          beliggenhedsadresse: [
            {
              periode: { gyldigTil: null, gyldigFra: '2022-01-01' },
              vejnavn: 'Søbyvej',
              husnummerFra: 11,
              bogstavFra: '',
              postnummer: 2650,
              postdistrikt: 'Hvidovre',
            },
          ],
          telefonnummer: [],
          emailadresse: [],
          virksomhedsform: [{ periode: { gyldigTil: null }, kortBeskrivelse: 'ApS' }],
          virksomhedsstatus: [
            { periode: { gyldigTil: null }, statuskode: 'NORMAL', gyldigFra: '2022-01-01' },
          ],
          virksomhedMetadata: { sammensatStatus: 'Aktiv' },
          livsforloeb: [{ periode: { gyldigTil: null } }],
          kvartalsbeskaeftigelse: [],
          penheder: [],
          hovedbranche: [
            {
              periode: { gyldigTil: null },
              branchekode: '620100',
              branchetekst: 'Softwareudvikling',
            },
          ],
        },
      },
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ hits: { hits: [fakeHit] } }),
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
    expect(body.virksomheder).toHaveLength(1);
    const v = body.virksomheder[0];
    expect(v.cvr).toBe(44718502);
    expect(v.navn).toBe('Pecunia IT ApS');
    expect(v.type).toBe('ApS');
    expect(v.aktiv).toBe(true);
    expect(v.branche).toBe('Softwareudvikling');
  });
});
