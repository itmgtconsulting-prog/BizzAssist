/**
 * Unit tests for GET /api/ejerskab/chain
 *
 * BIZZ-1582: Updated to mock the direct lib functions (fetchTlEjereDirekt,
 * fetchEjfEjereDirekt) instead of intercepting HTTP self-calls, since the
 * chain route no longer makes internal HTTP requests.
 *
 * Covers:
 * - Returns property node + owner nodes when Tinglysning returns owners
 * - Returns fallback empty graph when no owner data is available
 * - company → person chain resolved via CVR ES
 * - Returns 401 when unauthenticated
 * - Returns error when bfe is missing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks (must be before any imports from the tested module) ─────────────────

vi.mock('@/lib/api/auth', () => ({
  resolveTenantId: vi.fn().mockResolvedValue({ tenantId: 'tenant-test', userId: 'user-test' }),
}));

vi.mock('@/app/lib/ejerskab/cache', () => ({
  buildChainCacheKey: vi.fn().mockReturnValue('test-cache-key'),
  getCached: vi.fn().mockResolvedValue(null),
  setCached: vi.fn().mockResolvedValue(undefined),
}));

// Mock the direct lib functions that replaced HTTP self-calls
const mockFetchTlEjere = vi.fn();
const mockFetchEjfEjere = vi.fn();

vi.mock('@/app/lib/tinglysning/fetchTlEjere', () => ({
  fetchTlEjereDirekt: (...args: unknown[]) => mockFetchTlEjere(...args),
}));

vi.mock('@/app/lib/ejerskab/fetchEjfEjereDirekt', () => ({
  fetchEjfEjereDirekt: (...args: unknown[]) => mockFetchEjfEjere(...args),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { GET } from '@/app/api/ejerskab/chain/route';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(bfe: string, adresse = 'Testvej 1', cookieValue = ''): NextRequest {
  const url = new URL(
    `http://localhost/api/ejerskab/chain?bfe=${bfe}&adresse=${encodeURIComponent(adresse)}`
  );
  const headers = new Headers();
  if (cookieValue) headers.set('cookie', cookieValue);
  return new NextRequest(url.toString(), { headers });
}

function makeJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/ejerskab/chain — auth & validation', () => {
  beforeEach(() => {
    mockFetchTlEjere.mockResolvedValue({ uuid: null, ejere: [], fejl: null });
    mockFetchEjfEjere.mockResolvedValue({ ejere: [], fejl: null });

    // Stub global fetch for CVR ES calls (company owner resolution)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeJsonResponse({ hits: { hits: [] } }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('returns 401 when resolveTenantId returns null', async () => {
    const { resolveTenantId } = await import('@/lib/api/auth');
    vi.mocked(resolveTenantId).mockResolvedValueOnce(null);

    const req = makeRequest('100165718');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 with fejl message when bfe is missing', async () => {
    const url = new URL('http://localhost/api/ejerskab/chain');
    const req = new NextRequest(url.toString());
    const res = await GET(req);
    const body = await res.json();

    expect(body.fejl).toBeTruthy();
    expect(body.nodes).toEqual([]);
  });

  it('calls fetchTlEjereDirekt with the bfe param', async () => {
    const req = makeRequest('100165718');
    await GET(req);

    expect(mockFetchTlEjere).toHaveBeenCalledWith('100165718');
  });

  it('calls fetchEjfEjereDirekt with the bfe as number', async () => {
    const req = makeRequest('100165718');
    await GET(req);

    expect(mockFetchEjfEjere).toHaveBeenCalledWith(100165718);
  });
});

describe('GET /api/ejerskab/chain — ownership graph shape', () => {
  beforeEach(() => {
    // Stub global fetch for CVR ES calls
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeJsonResponse({ hits: { hits: [] } }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('includes a property node with type "property" for the requested BFE', async () => {
    mockFetchTlEjere.mockResolvedValue({ uuid: 'uuid-1', ejere: [], fejl: null });
    mockFetchEjfEjere.mockResolvedValue({ ejere: [], fejl: null });

    const req = makeRequest('987654', 'Åboulevard 5');
    const res = await GET(req);
    const body = await res.json();

    const propNode = body.nodes.find((n: { type: string }) => n.type === 'property');
    expect(propNode).toBeDefined();
    expect(propNode.id).toBe('bfe-987654');
    expect(propNode.label).toBe('Åboulevard 5');
  });

  it('adds a company node when Tinglysning returns an owner with a CVR', async () => {
    mockFetchTlEjere.mockResolvedValue({
      uuid: 'uuid-2',
      ejere: [
        {
          navn: 'Holding ApS',
          cvr: '87654321',
          type: 'selskab',
          andel: '100%',
          adkomstType: null,
          overtagelsesdato: null,
          koebesum: null,
          adresse: null,
        },
      ],
      fejl: null,
    });
    mockFetchEjfEjere.mockResolvedValue({ ejere: [], fejl: null });

    const req = makeRequest('111222');
    const res = await GET(req);
    const body = await res.json();

    const companyNode = body.nodes.find((n: { type: string }) => n.type === 'company');
    expect(companyNode).toBeDefined();
    expect(companyNode.cvr).toBe(87654321);
  });

  it('adds a person node when Tinglysning returns an owner without CVR', async () => {
    mockFetchTlEjere.mockResolvedValue({
      uuid: 'uuid-3',
      ejere: [
        {
          navn: 'Hans Hansen',
          cvr: null,
          type: 'person',
          andel: '100%',
          adkomstType: null,
          overtagelsesdato: null,
          koebesum: null,
          adresse: null,
        },
      ],
      fejl: null,
    });
    mockFetchEjfEjere.mockResolvedValue({ ejere: [], fejl: null });

    const req = makeRequest('333444');
    const res = await GET(req);
    const body = await res.json();

    const personNode = body.nodes.find((n: { type: string }) => n.type === 'person');
    expect(personNode).toBeDefined();
    expect(personNode.label).toBe('Hans Hansen');
  });

  it('returns empty nodes (except property) when all upstream sources fail', async () => {
    mockFetchTlEjere.mockRejectedValue(new Error('Network unreachable'));
    mockFetchEjfEjere.mockRejectedValue(new Error('Network unreachable'));

    const req = makeRequest('555666');
    const res = await GET(req);
    const body = await res.json();

    // Only the property node should be present — errors must not crash the route
    expect(body.nodes.length).toBe(1);
    expect(body.nodes[0].type).toBe('property');
    expect(body.fejl).toBeNull();
  });

  it('ejerDetaljer contains owner details from Tinglysning', async () => {
    mockFetchTlEjere.mockResolvedValue({
      uuid: 'uuid-4',
      ejere: [
        {
          navn: 'Parcel ApS',
          cvr: '11223344',
          type: 'selskab',
          andel: '100%',
          adkomstType: 'skoede',
          adresse: 'Skovvej 2, 8000 Aarhus',
          overtagelsesdato: '2021-06-01',
          koebesum: 3200000,
        },
      ],
      fejl: null,
    });
    mockFetchEjfEjere.mockResolvedValue({ ejere: [], fejl: null });

    const req = makeRequest('777888');
    const res = await GET(req);
    const body = await res.json();

    expect(body.ejerDetaljer.length).toBe(1);
    const detalje = body.ejerDetaljer[0];
    expect(detalje.navn).toBe('Parcel ApS');
    expect(detalje.cvr).toBe('11223344');
    expect(detalje.koebesum).toBe(3200000);
    expect(detalje.adkomstType).toBe('skoede');
  });
});
