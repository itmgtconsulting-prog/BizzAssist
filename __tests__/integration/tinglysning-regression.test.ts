/**
 * Regression tests for /api/tinglysning — Tinglysningsretten HTTP API route.
 *
 * These tests use **realistic** responses based on the known test property
 * BFE 100165718 (the default test-ejendom in test.tinglysning.dk).
 *
 * They verify the full pipeline: parameter validation → cert check → mTLS
 * fetch → JSON parse → XML parse → response shape.
 *
 * No real network calls — https.request is mocked at the module level.
 *
 * If these tests break after a code change, the Tinglysning tab in the
 * property detail page is likely broken too.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Test data ────────────────────────────────────────────────────────────────

/**
 * Realistic JSON response from /ejendom/hovednoteringsnummer
 */
const SEARCH_RESPONSE_JSON = JSON.stringify({
  items: [
    {
      uuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      adresse: 'Thorvald Bindesbølls Plads 18, 1800 Frederiksberg C',
      vedroerende: 'Frederiksberg matr.nr. 12a',
      ejendomsVurdering: 5400000,
      grundVaerdi: 2700000,
      vurderingsDato: '2024-01-01',
      ejendomsnummer: '1001234',
      kommuneNummer: '0147',
    },
  ],
});

/**
 * Realistic XML response from /ejdsummarisk/{uuid}
 */
const SUMMARISK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ns7:EjendomSummarisk xmlns:ns7="http://rep.oio.dk/tinglysning.dk/schema/elektronisk/">
  <ns7:Ejerlejlighed>
    <ns7:Ejerlejlighedsnummer>42</ns7:Ejerlejlighedsnummer>
    <ns7:ArealOplysninger>
      <ns7:Tekst>Ejerlejlighedens tinglyste areal</ns7:Tekst>
      <ns7:Vaerdi>85 kvm</ns7:Vaerdi>
    </ns7:ArealOplysninger>
    <ns7:Fordelingstal>
      <ns7:Taeller>234</ns7:Taeller>
      <ns7:Naevner>10000</ns7:Naevner>
    </ns7:Fordelingstal>
  </ns7:Ejerlejlighed>
</ns7:EjendomSummarisk>`;

// ── Mutable mock state ───────────────────────────────────────────────────────
// vi.mock is hoisted to the top, so we use mutable references that individual
// tests can reconfigure before calling the route handler.

/** Queued https responses — shift() in order for each https.request call */
let httpsResponses: { status: number; body: string }[] = [];

// ── Top-level mocks (hoisted) ────────────────────────────────────────────────

vi.mock('@/app/lib/rateLimit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(null),
  heavyRateLimit: {},
}));

vi.mock('@/lib/api/auth', () => ({
  resolveTenantId: vi.fn().mockResolvedValue({ tenantId: 'test-tenant', userId: 'test-user' }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue(Buffer.from('fake-pfx')),
  },
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue(Buffer.from('fake-pfx')),
}));

vi.mock('path', () => ({
  default: {
    resolve: vi.fn((...args: string[]) => args.join('/')),
  },
  resolve: vi.fn((...args: string[]) => args.join('/')),
}));

vi.mock('https', () => {
  const impl = (_options: unknown, callback: (res: unknown) => void) => {
    const next = httpsResponses.shift() ?? { status: 500, body: 'No mock response queued' };
    const res = {
      statusCode: next.status,
      on: vi.fn((event: string, handler: (data?: unknown) => void) => {
        if (event === 'data') handler(next.body);
        if (event === 'end') handler();
        return res;
      }),
    };
    callback(res);
    return { on: vi.fn().mockReturnThis(), end: vi.fn(), destroy: vi.fn() };
  };
  return { default: { request: impl }, request: impl };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/tinglysning');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url.toString());
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/tinglysning — parameter validation', () => {
  beforeEach(() => {
    httpsResponses = [];
    process.env.TINGLYSNING_CERT_PATH = '/fake/cert.pfx';
    process.env.TINGLYSNING_CERT_PASSWORD = 'test-password';
    process.env.TINGLYSNING_BASE_URL = 'https://test.tinglysning.dk';
  });

  it('returns 400 when bfe parameter is missing', async () => {
    const { GET } = await import('@/app/api/tinglysning/route');
    const req = makeRequest({});
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('bfe');
  });

  it('returns 400 when bfe contains non-numeric characters', async () => {
    const { GET } = await import('@/app/api/tinglysning/route');
    const req = makeRequest({ bfe: 'abc123' });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when bfe contains special characters (injection attempt)', async () => {
    const { GET } = await import('@/app/api/tinglysning/route');
    const req = makeRequest({ bfe: "100165718'; DROP TABLE--" });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/tinglysning — cert configuration', () => {
  it('returns 503 when no cert environment variables are set', async () => {
    delete process.env.TINGLYSNING_CERT_PATH;
    delete process.env.TINGLYSNING_CERT_B64;
    delete process.env.TINGLYSNING_CERT_PASSWORD;
    delete process.env.NEMLOGIN_DEVTEST4_CERT_PATH;
    delete process.env.NEMLOGIN_DEVTEST4_CERT_B64;
    delete process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD;

    // Must resetModules so the route re-reads env vars at import time
    vi.resetModules();
    const { GET } = await import('@/app/api/tinglysning/route');
    const req = makeRequest({ bfe: '100165718' });
    const res = await GET(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('certifikat');
  });
});

describe('GET /api/tinglysning — BFE 100165718 (known test property)', () => {
  beforeEach(() => {
    httpsResponses = [];
    process.env.TINGLYSNING_CERT_PATH = '/fake/cert.pfx';
    process.env.TINGLYSNING_CERT_PASSWORD = 'test-password';
    process.env.TINGLYSNING_BASE_URL = 'https://test.tinglysning.dk';
  });

  it('returns full TinglysningData shape with correct fields', async () => {
    httpsResponses = [
      { status: 200, body: SEARCH_RESPONSE_JSON },
      { status: 200, body: SUMMARISK_XML },
    ];

    vi.resetModules();
    const { GET } = await import('@/app/api/tinglysning/route');
    const req = makeRequest({ bfe: '100165718' });
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);

    // Core fields from search response
    expect(body.bfe).toBe(100165718);
    expect(body.uuid).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(body.adresse).toBe('Thorvald Bindesbølls Plads 18, 1800 Frederiksberg C');
    expect(body.vedroerende).toBe('Frederiksberg matr.nr. 12a');
    expect(body.ejendomsVurdering).toBe(5400000);
    expect(body.grundVaerdi).toBe(2700000);
    expect(body.vurderingsDato).toBe('2024-01-01');
    expect(body.ejendomsnummer).toBe('1001234');
    expect(body.kommuneNummer).toBe('0147');

    // Fields from XML parsing (ejdsummarisk)
    expect(body.ejendomstype).toBe('Ejerlejlighed');
    expect(body.ejerlejlighedNr).toBe(42);
    expect(body.tinglystAreal).toBe(85);
    expect(body.fordelingstal).toEqual({ taeller: 234, naevner: 10000 });
  });

  it('returns Cache-Control header for CDN caching', async () => {
    httpsResponses = [
      { status: 200, body: SEARCH_RESPONSE_JSON },
      { status: 200, body: SUMMARISK_XML },
    ];

    vi.resetModules();
    const { GET } = await import('@/app/api/tinglysning/route');
    const req = makeRequest({ bfe: '100165718' });
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('s-maxage=3600');
  });
});

describe('GET /api/tinglysning — error handling', () => {
  beforeEach(() => {
    httpsResponses = [];
    process.env.TINGLYSNING_CERT_PATH = '/fake/cert.pfx';
    process.env.TINGLYSNING_CERT_PASSWORD = 'test-password';
    process.env.TINGLYSNING_BASE_URL = 'https://test.tinglysning.dk';
  });

  it('returns 502 when tinglysning API returns non-200 status', async () => {
    httpsResponses = [{ status: 500, body: 'Internal Server Error' }];

    vi.resetModules();
    const { GET } = await import('@/app/api/tinglysning/route');
    const req = makeRequest({ bfe: '100165718' });
    const res = await GET(req);
    expect(res.status).toBe(502);
  });

  it('returns 404 when property is not found in prod environment', async () => {
    httpsResponses = [{ status: 200, body: JSON.stringify({ items: [] }) }];
    process.env.TINGLYSNING_BASE_URL = 'https://www.tinglysning.dk';

    vi.resetModules();
    const { GET } = await import('@/app/api/tinglysning/route');
    const req = makeRequest({ bfe: '999999999' });
    const res = await GET(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('ikke fundet');
  });

  it('never leaks raw error messages in production', async () => {
    // Return invalid JSON so JSON.parse throws inside the try block
    httpsResponses = [{ status: 200, body: 'not valid json {{{' }];
    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    vi.resetModules();
    const { GET } = await import('@/app/api/tinglysning/route');
    const req = makeRequest({ bfe: '100165718' });
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe('Ekstern API fejl');
    // Must NOT have dev_detail in production
    expect(body.dev_detail).toBeUndefined();
    // Must NOT leak raw JSON parse error
    expect(JSON.stringify(body)).not.toMatch(/Unexpected token|JSON\.parse|SyntaxError/i);

    process.env.NODE_ENV = origNodeEnv;
  });
});

describe('parseEjdsummariskXml — XML parser regression', () => {
  beforeEach(() => {
    httpsResponses = [];
    process.env.TINGLYSNING_CERT_PATH = '/fake/cert.pfx';
    process.env.TINGLYSNING_CERT_PASSWORD = 'test-password';
    process.env.TINGLYSNING_BASE_URL = 'https://test.tinglysning.dk';
  });

  it('extracts ejerlejlighedsnummer from minimal XML', async () => {
    const minimalXml = `<?xml version="1.0"?>
      <ns7:EjendomSummarisk>
        <ns7:Ejerlejlighed>
          <ns7:Ejerlejlighedsnummer>7</ns7:Ejerlejlighedsnummer>
        </ns7:Ejerlejlighed>
      </ns7:EjendomSummarisk>`;

    httpsResponses = [
      { status: 200, body: SEARCH_RESPONSE_JSON },
      { status: 200, body: minimalXml },
    ];

    vi.resetModules();
    const { GET } = await import('@/app/api/tinglysning/route');
    const req = makeRequest({ bfe: '100165718' });
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ejendomstype).toBe('Ejerlejlighed');
    expect(body.ejerlejlighedNr).toBe(7);
    // These should be null when not in XML
    expect(body.tinglystAreal).toBeNull();
    expect(body.fordelingstal).toBeNull();
  });

  it('handles non-ejerlejlighed properties (no ejerlejlighed data in XML)', async () => {
    const grundXml = `<?xml version="1.0"?>
      <ns7:EjendomSummarisk>
        <ns7:Grund>
          <ns7:GrundAreal>450</ns7:GrundAreal>
        </ns7:Grund>
      </ns7:EjendomSummarisk>`;

    httpsResponses = [
      { status: 200, body: SEARCH_RESPONSE_JSON },
      { status: 200, body: grundXml },
    ];

    vi.resetModules();
    const { GET } = await import('@/app/api/tinglysning/route');
    const req = makeRequest({ bfe: '100165718' });
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    // No ejerlejlighed data in XML
    expect(body.ejendomstype).toBeNull();
    expect(body.ejerlejlighedNr).toBeNull();
    expect(body.tinglystAreal).toBeNull();
    expect(body.fordelingstal).toBeNull();
    // Core search fields are still present
    expect(body.bfe).toBe(100165718);
    expect(body.uuid).toBeTruthy();
    expect(body.adresse).toBeTruthy();
  });

  it('parses fordelingstal correctly from full XML', async () => {
    httpsResponses = [
      { status: 200, body: SEARCH_RESPONSE_JSON },
      { status: 200, body: SUMMARISK_XML },
    ];

    vi.resetModules();
    const { GET } = await import('@/app/api/tinglysning/route');
    const req = makeRequest({ bfe: '100165718' });
    const res = await GET(req);
    const body = await res.json();

    expect(body.fordelingstal).toEqual({ taeller: 234, naevner: 10000 });
    expect(body.tinglystAreal).toBe(85);
  });
});
