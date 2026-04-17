/**
 * Integration tests for GET /api/adresse/jordstykke?bfe=… (BIZZ-505).
 *
 * Verifies the MAT-first / DAWA-fallback flow for BFE jordstykke lookups:
 *   - MAT GraphQL returns a jordstykke → response from MAT, DAWA `/jordstykker`
 *     is NOT called. adgangsadresseId lookup still runs via DAWA until that
 *     dependency is also migrated (separate follow-up).
 *   - MAT returns null → DAWA fallback for jordstykke too (tagged with
 *     `caller=adresse.jordstykke.bfe.fallback` for telemetry).
 *   - Invalid BFE → 400.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api/auth', () => ({
  resolveTenantId: vi.fn(() => Promise.resolve({ tenantId: 'tenant-test', userId: 'user-test' })),
}));

const mockFetchDawa = vi.fn();
vi.mock('@/app/lib/dawa', () => ({
  fetchDawa: (...args: unknown[]) => mockFetchDawa(...args),
}));

const mockMatHentJordstykkeByBfe = vi.fn();
const mockDarHentJordstykke = vi.fn();
vi.mock('@/app/lib/dar', () => ({
  matHentJordstykkeByBfe: (...args: unknown[]) => mockMatHentJordstykkeByBfe(...args),
  darHentJordstykke: (...args: unknown[]) => mockDarHentJordstykke(...args),
}));

function makeReq(bfe: string | number): NextRequest {
  return new NextRequest(`http://test/api/adresse/jordstykke?bfe=${bfe}`);
}

function mockDawaResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('GET /api/adresse/jordstykke?bfe=… — BIZZ-505 MAT-first flow', () => {
  beforeEach(() => {
    mockMatHentJordstykkeByBfe.mockReset();
    mockFetchDawa.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('rejects non-numeric BFE with 400', async () => {
    const { GET } = await import('@/app/api/adresse/jordstykke/route');
    const res = await GET(makeReq('abc'));
    expect(res.status).toBe(400);
    expect(mockMatHentJordstykkeByBfe).not.toHaveBeenCalled();
    expect(mockFetchDawa).not.toHaveBeenCalled();
  });

  it('uses MAT for jordstykke + DAWA only for adgangsadresseId', async () => {
    mockMatHentJordstykkeByBfe.mockResolvedValue({
      matrikelnr: '13a',
      registreretAreal: 450,
      vejareal: 25,
      ejerlav: { kode: 1161451, navn: 'Søgård Hgd., Kliplev Sogn' },
    });
    mockFetchDawa.mockResolvedValue(
      mockDawaResponse([{ id: '00000000-0000-0000-0000-000000000abc' }])
    );

    const { GET } = await import('@/app/api/adresse/jordstykke/route');
    const res = await GET(makeReq(100165718));
    const body = (await res.json()) as {
      matrikelnr: string;
      ejerlav: { kode: number; navn: string | null };
      adgangsadresseId: string | null;
      registreretAreal: number | null;
      vejareal: number | null;
    };

    expect(res.status).toBe(200);
    expect(body.matrikelnr).toBe('13a');
    expect(body.ejerlav.navn).toBe('Søgård Hgd., Kliplev Sogn');
    expect(body.ejerlav.kode).toBe(1161451);
    expect(body.registreretAreal).toBe(450);
    expect(body.vejareal).toBe(25);
    expect(body.adgangsadresseId).toBe('00000000-0000-0000-0000-000000000abc');

    // DAWA was called exactly once — for the adgangsadresser lookup, not for jordstykker
    expect(mockFetchDawa).toHaveBeenCalledOnce();
    const [url, , meta] = mockFetchDawa.mock.calls[0] as [
      string,
      unknown,
      { caller?: string } | undefined,
    ];
    expect(url).toContain('/adgangsadresser');
    expect(meta?.caller).toBe('adresse.jordstykke.ejerlav');
  });

  it('falls back to DAWA jordstykker when MAT returns null', async () => {
    mockMatHentJordstykkeByBfe.mockResolvedValue(null);
    // First DAWA call: jordstykker (fallback). Second: adgangsadresser.
    mockFetchDawa
      .mockResolvedValueOnce(
        mockDawaResponse([
          {
            matrikelnr: '7q',
            ejerlav: { kode: 8000, navn: 'Odense Bygrunde' },
            registreretareal: 120,
            vejareal: 0,
          },
        ])
      )
      .mockResolvedValueOnce(mockDawaResponse([{ id: '00000000-0000-0000-0000-000000000fff' }]));

    const { GET } = await import('@/app/api/adresse/jordstykke/route');
    const res = await GET(makeReq(200));
    const body = (await res.json()) as {
      matrikelnr: string;
      ejerlav: { kode: number; navn: string | null };
      adgangsadresseId: string | null;
    };

    expect(res.status).toBe(200);
    expect(body.matrikelnr).toBe('7q');
    expect(body.ejerlav.kode).toBe(8000);
    expect(body.ejerlav.navn).toBe('Odense Bygrunde');
    expect(body.adgangsadresseId).toBe('00000000-0000-0000-0000-000000000fff');

    expect(mockFetchDawa).toHaveBeenCalledTimes(2);
    const firstMeta = mockFetchDawa.mock.calls[0][2] as { caller?: string };
    expect(firstMeta.caller).toBe('adresse.jordstykke.bfe.fallback');
  });

  it('returns null when MAT null AND DAWA returns empty array', async () => {
    mockMatHentJordstykkeByBfe.mockResolvedValue(null);
    mockFetchDawa.mockResolvedValue(mockDawaResponse([]));

    const { GET } = await import('@/app/api/adresse/jordstykke/route');
    const res = await GET(makeReq(400));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toBeNull();
  });
});
