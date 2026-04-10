/**
 * Unit tests for GET /api/ejerskab/chain
 *
 * Covers the critical cookie-forwarding behaviour: every internal API call
 * (Tinglysning, EJF) must receive the same `cookie` header that arrived on the
 * incoming request.  Missing cookie forwarding caused empty ownership responses
 * because the internal routes rejected unauthenticated calls silently.
 *
 * Also covers:
 * - Returns property node + owner nodes when Tinglysning returns owners
 * - Returns fallback empty graph when no owner data is available
 * - company → person chain resolved via CVR ES
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks (must be before any imports from the tested module) ─────────────────

vi.mock('@/lib/api/auth', () => ({
  resolveTenantId: vi.fn().mockResolvedValue({ tenantId: 'tenant-test', userId: 'user-test' }),
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

describe('GET /api/ejerskab/chain — cookie forwarding', () => {
  let capturedFetchCalls: Array<{ url: string; headers: Record<string, string> }>;

  beforeEach(() => {
    capturedFetchCalls = [];

    // Intercept every fetch call, capture URL + headers, and return minimal stubs
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const headers: Record<string, string> = {};
        if (init?.headers) {
          const h = new Headers(init.headers as HeadersInit);
          h.forEach((value, key) => {
            headers[key] = value;
          });
        }
        capturedFetchCalls.push({ url, headers });

        // Tinglysning lookup — return uuid so summarisk is tried next
        if (url.includes('/api/tinglysning?bfe=')) {
          return makeJsonResponse({ uuid: 'tl-uuid-abc', error: null });
        }
        // Tinglysning summarisk — return one selskabsejer with CVR
        if (url.includes('/api/tinglysning/summarisk')) {
          return makeJsonResponse({
            ejere: [
              {
                navn: 'Test Holding A/S',
                cvr: '12345678',
                andel: '100%',
                adkomstType: 'skoede',
                adresse: 'Testvej 1, 2200 København N',
                overtagelsesdato: '2020-01-01',
                koebesum: 2000000,
              },
            ],
            haeftelser: [],
            servitutter: [],
          });
        }
        // CVR ES company owners — return empty so chain stops here
        if (url.includes('distribution.virk.dk')) {
          return makeJsonResponse({ hits: { hits: [] } });
        }
        // EJF fallback
        if (url.includes('/api/ejerskab?')) {
          return makeJsonResponse({ ejere: [] });
        }
        return makeJsonResponse({}, 404);
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('forwards the cookie header to the Tinglysning internal API call', async () => {
    const SESSION_COOKIE = 'sb-access-token=eyABC; sb-refresh-token=eyDEF';
    const req = makeRequest('100165718', 'Testvej 1', SESSION_COOKIE);
    await GET(req);

    const tlCall = capturedFetchCalls.find((c) => c.url.includes('/api/tinglysning?bfe='));
    expect(tlCall).toBeDefined();
    expect(tlCall!.headers['cookie']).toBe(SESSION_COOKIE);
  });

  it('forwards the cookie header to the Tinglysning summarisk call', async () => {
    const SESSION_COOKIE = 'sb-access-token=eyABC';
    const req = makeRequest('100165718', 'Testvej 1', SESSION_COOKIE);
    await GET(req);

    const sumCall = capturedFetchCalls.find((c) => c.url.includes('/api/tinglysning/summarisk'));
    expect(sumCall).toBeDefined();
    expect(sumCall!.headers['cookie']).toBe(SESSION_COOKIE);
  });

  it('forwards empty string when no cookie is present', async () => {
    const req = makeRequest('100165718');
    await GET(req);

    const tlCall = capturedFetchCalls.find((c) => c.url.includes('/api/tinglysning?bfe='));
    expect(tlCall).toBeDefined();
    // Header is either absent or empty — both are valid; must NOT be undefined with a real cookie value
    expect(tlCall!.headers['cookie'] ?? '').toBe('');
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
});

describe('GET /api/ejerskab/chain — ownership graph shape', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('includes a property node with type "property" for the requested BFE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/tinglysning?bfe=')) {
          return makeJsonResponse({ uuid: 'uuid-1', error: null });
        }
        if (url.includes('/api/tinglysning/summarisk')) {
          return makeJsonResponse({ ejere: [], haeftelser: [], servitutter: [] });
        }
        if (url.includes('/api/ejerskab?')) {
          return makeJsonResponse({ ejere: [] });
        }
        return makeJsonResponse({}, 404);
      })
    );

    const req = makeRequest('987654', 'Åboulevard 5');
    const res = await GET(req);
    const body = await res.json();

    const propNode = body.nodes.find((n: { type: string }) => n.type === 'property');
    expect(propNode).toBeDefined();
    expect(propNode.id).toBe('bfe-987654');
    expect(propNode.label).toBe('Åboulevard 5');
  });

  it('adds a company node when Tinglysning returns an owner with a CVR', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/tinglysning?bfe=')) {
          return makeJsonResponse({ uuid: 'uuid-2', error: null });
        }
        if (url.includes('/api/tinglysning/summarisk')) {
          return makeJsonResponse({
            ejere: [{ navn: 'Holding ApS', cvr: '87654321', andel: '100%' }],
            haeftelser: [],
            servitutter: [],
          });
        }
        if (url.includes('distribution.virk.dk')) {
          return makeJsonResponse({ hits: { hits: [] } });
        }
        return makeJsonResponse({}, 404);
      })
    );

    const req = makeRequest('111222');
    const res = await GET(req);
    const body = await res.json();

    const companyNode = body.nodes.find((n: { type: string }) => n.type === 'company');
    expect(companyNode).toBeDefined();
    expect(companyNode.cvr).toBe(87654321);
  });

  it('adds a person node when Tinglysning returns an owner without CVR', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/tinglysning?bfe=')) {
          return makeJsonResponse({ uuid: 'uuid-3', error: null });
        }
        if (url.includes('/api/tinglysning/summarisk')) {
          return makeJsonResponse({
            ejere: [{ navn: 'Hans Hansen', cvr: null, andel: '100%' }],
            haeftelser: [],
            servitutter: [],
          });
        }
        // CVR ES deltager search — no match
        if (url.includes('distribution.virk.dk')) {
          return makeJsonResponse({ hits: { hits: [] } });
        }
        return makeJsonResponse({}, 404);
      })
    );

    const req = makeRequest('333444');
    const res = await GET(req);
    const body = await res.json();

    const personNode = body.nodes.find((n: { type: string }) => n.type === 'person');
    expect(personNode).toBeDefined();
    expect(personNode.label).toBe('Hans Hansen');
  });

  it('returns empty nodes (except property) when all upstream sources fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network unreachable')));

    const req = makeRequest('555666');
    const res = await GET(req);
    const body = await res.json();

    // Only the property node should be present — errors must not crash the route
    expect(body.nodes.length).toBe(1);
    expect(body.nodes[0].type).toBe('property');
    expect(body.fejl).toBeNull();
  });

  it('ejerDetaljer contains owner details from Tinglysning', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/tinglysning?bfe=')) {
          return makeJsonResponse({ uuid: 'uuid-4', error: null });
        }
        if (url.includes('/api/tinglysning/summarisk')) {
          return makeJsonResponse({
            ejere: [
              {
                navn: 'Parcel ApS',
                cvr: '11223344',
                andel: '100%',
                adkomstType: 'skoede',
                adresse: 'Skovvej 2, 8000 Aarhus',
                overtagelsesdato: '2021-06-01',
                koebesum: 3200000,
              },
            ],
            haeftelser: [],
            servitutter: [],
          });
        }
        if (url.includes('distribution.virk.dk')) {
          return makeJsonResponse({ hits: { hits: [] } });
        }
        return makeJsonResponse({}, 404);
      })
    );

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
