/**
 * Integration tests for GET /api/adresse/husnumre-bbox (BIZZ-504).
 *
 * Verifies the DAR-first / DAWA-fallback flow for bbox address lookups:
 *   - Oversized bbox → 400 with helpful error (both paths skipped)
 *   - DAR WFS returns features → response from DAR, DAWA NOT called
 *   - DAR returns null → DAWA fallback, tagged with telemetry caller
 *   - DAWA fallback throws → 502
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

const mockDarHusnumreBbox = vi.fn();
vi.mock('@/app/lib/dar', () => ({
  darHusnumreBbox: (...args: unknown[]) => mockDarHusnumreBbox(...args),
}));

function makeReq(w: number, s: number, e: number, n: number): NextRequest {
  return new NextRequest(`http://test/api/adresse/husnumre-bbox?w=${w}&s=${s}&e=${e}&n=${n}`);
}

function mockDawaResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('GET /api/adresse/husnumre-bbox — BIZZ-504 DAR-first flow', () => {
  beforeEach(() => {
    mockDarHusnumreBbox.mockReset();
    mockFetchDawa.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('rejects oversized bboxes (> 0.3° in either axis) before calling any provider', async () => {
    const { GET } = await import('@/app/api/adresse/husnumre-bbox/route');
    const res = await GET(makeReq(12.0, 55.6, 12.5, 55.7)); // lngSpan=0.5
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(400);
    expect(body.error).toContain('Bbox for stor');
    expect(mockDarHusnumreBbox).not.toHaveBeenCalled();
    expect(mockFetchDawa).not.toHaveBeenCalled();
  });

  it('uses DAR when DAR returns a FeatureCollection — DAWA is not called', async () => {
    mockDarHusnumreBbox.mockResolvedValue({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [12.5858, 55.6835] },
          properties: { husnr: '1' },
        },
      ],
    });

    const { GET } = await import('@/app/api/adresse/husnumre-bbox/route');
    const res = await GET(makeReq(12.58, 55.68, 12.59, 55.69));
    const body = (await res.json()) as {
      type: string;
      features: Array<{ properties: { husnr: string } }>;
    };

    expect(res.status).toBe(200);
    expect(body.type).toBe('FeatureCollection');
    expect(body.features).toHaveLength(1);
    expect(body.features[0].properties.husnr).toBe('1');
    expect(mockDarHusnumreBbox).toHaveBeenCalledOnce();
    expect(mockFetchDawa).not.toHaveBeenCalled();
  });

  it('falls back to DAWA when DAR returns null, tagged with caller telemetry', async () => {
    mockDarHusnumreBbox.mockResolvedValue(null);
    mockFetchDawa.mockResolvedValue(
      mockDawaResponse([
        { x: 12.57, y: 55.675, husnr: '4' },
        { x: 12.571, y: 55.676, husnr: '6' },
      ])
    );

    const { GET } = await import('@/app/api/adresse/husnumre-bbox/route');
    const res = await GET(makeReq(12.56, 55.67, 12.58, 55.68));
    const body = (await res.json()) as {
      features: Array<{ properties: { husnr: string }; geometry: { coordinates: number[] } }>;
    };

    expect(res.status).toBe(200);
    expect(body.features).toHaveLength(2);
    expect(body.features[0].properties.husnr).toBe('4');
    expect(body.features[0].geometry.coordinates).toEqual([12.57, 55.675]);

    expect(mockFetchDawa).toHaveBeenCalledOnce();
    const [, , meta] = mockFetchDawa.mock.calls[0] as [
      string,
      unknown,
      { caller?: string } | undefined,
    ];
    expect(meta?.caller).toBe('adresse.husnumre-bbox.fallback');
  });

  it('returns 502 when DAWA fallback throws', async () => {
    mockDarHusnumreBbox.mockResolvedValue(null);
    mockFetchDawa.mockRejectedValue(new Error('network fail'));

    const { GET } = await import('@/app/api/adresse/husnumre-bbox/route');
    const res = await GET(makeReq(12.56, 55.67, 12.58, 55.68));
    expect(res.status).toBe(502);
  });

  it('returns empty FeatureCollection when DAWA fallback returns non-ok', async () => {
    mockDarHusnumreBbox.mockResolvedValue(null);
    mockFetchDawa.mockResolvedValue(mockDawaResponse(null, false));

    const { GET } = await import('@/app/api/adresse/husnumre-bbox/route');
    const res = await GET(makeReq(12.56, 55.67, 12.58, 55.68));
    const body = (await res.json()) as { type: string; features: unknown[] };

    expect(res.status).toBe(200);
    expect(body.type).toBe('FeatureCollection');
    expect(body.features).toHaveLength(0);
  });
});
