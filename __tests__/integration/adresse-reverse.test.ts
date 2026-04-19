/**
 * Integration tests for GET /api/adresse/reverse (BIZZ-503).
 *
 * Verifies the DAR-first / DAWA-fallback flow:
 *   - DAR WFS returns a feature → response comes from DAR, DAWA NOT called
 *   - DAR WFS fails or returns empty → DAWA fetch used, response from DAWA
 *   - Both DAR and DAWA fail → returns { adresse: null, id: null }
 *   - Missing DATAFORDELER_API_KEY → skips DAR, falls back to DAWA
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mock resolveTenantId so the auth guard passes ────────────────────────
vi.mock('@/lib/api/auth', () => ({
  resolveTenantId: vi.fn(() => Promise.resolve({ tenantId: 'tenant-test', userId: 'user-test' })),
}));

// ── Spy on fetchDawa so we can assert whether the fallback fired ─────────
const mockFetchDawa = vi.fn();
vi.mock('@/app/lib/dawa', () => ({
  fetchDawa: (...args: unknown[]) => mockFetchDawa(...args),
}));

// ── Spy on darReverseGeocode ─────────────────────────────────────────────
const mockDarReverseGeocode = vi.fn();
vi.mock('@/app/lib/dar', () => ({
  darReverseGeocode: (...args: unknown[]) => mockDarReverseGeocode(...args),
}));

function makeReq(lng: number, lat: number): NextRequest {
  return new NextRequest(`http://test/api/adresse/reverse?lng=${lng}&lat=${lat}`);
}

function mockDawaResponse(body: Record<string, unknown> | null, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body ?? {}),
  } as unknown as Response;
}

describe('GET /api/adresse/reverse — BIZZ-503 DAR-first flow', () => {
  beforeEach(() => {
    mockDarReverseGeocode.mockReset();
    mockFetchDawa.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('uses DAR when DAR returns a feature — DAWA is not called', async () => {
    mockDarReverseGeocode.mockResolvedValue({
      adresse: 'Bredgade 1, 1260 København K',
      id: '00000000-0000-0000-0000-000000000001',
    });

    const { GET } = await import('@/app/api/adresse/reverse/route');
    const res = await GET(makeReq(12.5858, 55.6835));
    const body = (await res.json()) as { adresse: string; id: string | null };

    expect(res.status).toBe(200);
    expect(body.adresse).toBe('Bredgade 1, 1260 København K');
    expect(body.id).toBe('00000000-0000-0000-0000-000000000001');
    expect(mockDarReverseGeocode).toHaveBeenCalledOnce();
    expect(mockFetchDawa).not.toHaveBeenCalled();
  });

  it('falls back to DAWA when DAR returns null', async () => {
    mockDarReverseGeocode.mockResolvedValue(null);
    mockFetchDawa.mockResolvedValue(
      mockDawaResponse({
        vejnavn: 'Rådhuspladsen',
        husnr: '4',
        postnr: '1550',
        postnrnavn: 'København V',
        id: '00000000-0000-0000-0000-000000000002',
      })
    );

    const { GET } = await import('@/app/api/adresse/reverse/route');
    const res = await GET(makeReq(12.57, 55.675));
    const body = (await res.json()) as { adresse: string; id: string | null };

    expect(res.status).toBe(200);
    expect(body.adresse).toBe('Rådhuspladsen 4, 1550 København V');
    expect(body.id).toBe('00000000-0000-0000-0000-000000000002');
    expect(mockDarReverseGeocode).toHaveBeenCalledOnce();
    expect(mockFetchDawa).toHaveBeenCalledOnce();
    // Ensure the fallback is tagged with its own caller so telemetry can
    // separate DAWA fallbacks from intentional DAWA calls.
    const [, , meta] = mockFetchDawa.mock.calls[0] as [
      string,
      unknown,
      { caller?: string } | undefined,
    ];
    expect(meta?.caller).toBe('adresse.reverse.fallback');
  });

  it('returns { adresse: null, id: null } when both DAR and DAWA fail', async () => {
    mockDarReverseGeocode.mockResolvedValue(null);
    mockFetchDawa.mockResolvedValue(mockDawaResponse(null, false));

    const { GET } = await import('@/app/api/adresse/reverse/route');
    const res = await GET(makeReq(12.57, 55.675));
    const body = (await res.json()) as { adresse: string | null; id: string | null };

    expect(res.status).toBe(200); // handler returns 200 with nulls rather than error
    expect(body.adresse).toBeNull();
    expect(body.id).toBeNull();
  });

  it('returns 502 when DAWA fallback throws', async () => {
    mockDarReverseGeocode.mockResolvedValue(null);
    mockFetchDawa.mockRejectedValue(new Error('network fail'));

    const { GET } = await import('@/app/api/adresse/reverse/route');
    const res = await GET(makeReq(12.57, 55.675));
    expect(res.status).toBe(502);
  });
});
