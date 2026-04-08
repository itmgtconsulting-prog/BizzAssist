/**
 * Integration tests for POST /api/export.
 *
 * Verifies:
 * - Property export generates valid xlsx buffer
 * - Company export generates valid xlsx buffer
 * - Missing data returns 400
 * - Correct content-type header
 */
import { describe, it, expect, vi } from 'vitest';
import { POST } from '@/app/api/export/route';
import { NextRequest } from 'next/server';

// Mock rate limiter so tests run without Upstash Redis env vars
vi.mock('@/app/lib/rateLimit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(null),
  rateLimit: {},
  aiRateLimit: {},
  braveRateLimit: {},
}));

// Mock auth so export tests bypass the authentication guard added in BIZZ-164
vi.mock('@/lib/api/auth', () => ({
  resolveTenantId: vi.fn().mockResolvedValue('test-tenant-id'),
}));

/**
 * Helper to create a mock NextRequest with JSON body.
 *
 * @param body - Request body object
 * @returns NextRequest instance
 */
function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/export', () => {
  it('returns 400 when type or data is missing', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it('generates a property xlsx with correct content-type', async () => {
    const res = await POST(
      makeRequest({
        type: 'property',
        data: {
          adresse: 'Vesterbrogade 1',
          postnr: '1620',
          by: 'København V',
          kommune: 'København',
          bygninger: [
            {
              anvendelse: 'Beboelse',
              opfoerelsesaar: 1920,
              samletAreal: 150,
              boligAreal: 120,
              erhvervsAreal: 30,
              etager: 3,
              tagMateriale: 'Tegl',
              ydervaegMateriale: 'Mursten',
              varmeinstallation: 'Fjernvarme',
            },
          ],
          enheder: [{ anvendelse: 'Bolig', samletAreal: 80, vaerelser: 3 }],
        },
      })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(res.headers.get('Content-Disposition')).toContain('.xlsx');

    // Verify buffer is non-empty
    const buffer = await res.arrayBuffer();
    expect(buffer.byteLength).toBeGreaterThan(100);
  });

  it('generates a company xlsx with correct content-type', async () => {
    const res = await POST(
      makeRequest({
        type: 'company',
        data: {
          cvr: '12345678',
          name: 'Test ApS',
          companyForm: 'Anpartsselskab',
          industry: 'IT',
          status: 'Aktiv',
          owners: [{ navn: 'Test Person', ejerandel: '100%' }],
        },
      })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('spreadsheetml.sheet');
  });

  it('includes filename with CVR in company export', async () => {
    const res = await POST(
      makeRequest({
        type: 'company',
        data: { cvr: '99887766', name: 'Demo' },
      })
    );

    expect(res.headers.get('Content-Disposition')).toContain('CVR99887766');
  });
});
