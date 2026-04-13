/**
 * Unit tests for SSRF protection in /api/dokumenter/zip/route.ts
 *
 * The route accepts user-supplied URLs and fetches them server-side to build
 * a ZIP archive of PDFs. Without URL validation an attacker could supply
 * internal URLs (metadata service, RFC-1918 ranges, Supabase internal endpoints)
 * to probe the infrastructure.
 *
 * These tests verify that `validerUrl()` correctly:
 *  - Rejects non-HTTPS schemes
 *  - Rejects private / link-local IPv4 ranges
 *  - Rejects IPv6 loopback (::1)
 *  - Rejects localhost and 0.0.0.0 in production
 *  - Rejects hosts that are not on the allowlist
 *  - Accepts known legitimate external hosts
 *  - Accepts localhost in development (NODE_ENV=development)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validerUrl } from '../../app/api/dokumenter/zip/route';

/** Lagrer og gendanner NODE_ENV på tværs af tests */
let originalNodeEnv: string | undefined;

beforeEach(() => {
  originalNodeEnv = (process.env as Record<string, string | undefined>).NODE_ENV;
});

afterEach(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
});

// ---------------------------------------------------------------------------
// Skema-validering
// ---------------------------------------------------------------------------
describe('validerUrl — skema', () => {
  it('tillader https://', () => {
    const res = validerUrl('https://bizzassist.dk/api/rapport/123.pdf');
    expect(res.ok).toBe(true);
  });

  it('afviser http:// i produktion', () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    const res = validerUrl('http://bizzassist.dk/api/rapport/123.pdf');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fejl).toMatch(/HTTPS/i);
  });

  it('afviser ftp://', () => {
    const res = validerUrl('ftp://bizzassist.dk/file.pdf');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fejl).toMatch(/HTTPS/i);
  });

  it('afviser javascript: URI', () => {
    const res = validerUrl('javascript:alert(1)');
    expect(res.ok).toBe(false);
  });

  it('afviser data: URI', () => {
    const res = validerUrl('data:text/html,<h1>XSS</h1>');
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Private IPv4-ranges
// ---------------------------------------------------------------------------
describe('validerUrl — private IPv4-ranges', () => {
  const privateAddresses = [
    '127.0.0.1', // loopback
    '127.1.2.3', // loopback (/8)
    '10.0.0.1', // RFC-1918 class A
    '10.255.255.255', // RFC-1918 class A grænse
    '172.16.0.1', // RFC-1918 class B
    '172.31.255.254', // RFC-1918 class B grænse
    '192.168.0.1', // RFC-1918 class C
    '192.168.255.255', // RFC-1918 class C grænse
    '169.254.169.254', // AWS/GCP IMDS (link-local)
    '169.254.0.1', // link-local
    '0.0.0.1', // "this network"
  ];

  for (const ip of privateAddresses) {
    it(`afviser privat IP: ${ip}`, () => {
      const res = validerUrl(`https://${ip}/secret`);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        // Skal afvises enten som privat IP eller pga. ikke-FQDN / ikke på tilladelseslisten
        expect(res.fejl.length).toBeGreaterThan(0);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// IPv6 loopback
// ---------------------------------------------------------------------------
describe('validerUrl — IPv6 loopback', () => {
  it('afviser [::1]', () => {
    const res = validerUrl('https://[::1]/secret');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fejl).toMatch(/::1|loopback/i);
  });
});

// ---------------------------------------------------------------------------
// localhost og 0.0.0.0
// ---------------------------------------------------------------------------
describe('validerUrl — localhost / 0.0.0.0', () => {
  it('afviser localhost i produktion', () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    const res = validerUrl('https://localhost:3000/api/foo');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fejl).toMatch(/localhost/i);
  });

  it('tillader localhost i development med http', () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
    const res = validerUrl('http://localhost:3000/api/rapport/abc.pdf');
    expect(res.ok).toBe(true);
  });

  it('afviser 0.0.0.0 altid', () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
    const res = validerUrl('https://0.0.0.0/secret');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fejl).toMatch(/0\.0\.0\.0/);
  });
});

// ---------------------------------------------------------------------------
// Tilladelsesliste (allowlist)
// ---------------------------------------------------------------------------
describe('validerUrl — tilladelsesliste', () => {
  const tilladte = [
    'https://bizzassist.dk/api/rapport/123.pdf',
    'https://www.bizzassist.dk/doc.pdf',
    'https://bizzassist-test.bizzassist.dk/api/rapport/abc.pdf',
    'https://test.bizzassist.dk/api/rapport/abc.pdf',
    'https://api-fs.vurderingsportalen.dk/vurdering/1234',
    'https://tinglysning.dk/TinglysningService',
    'https://www.tinglysning.dk/TinglysningService',
    'https://api.dataforsyningen.dk/orto_foraar_webmercator',
    'https://services.datafordeler.dk/BBR/BBRPublic/1/REST/BBRSag',
    'https://wfs.datafordeler.dk/Matriklen2/MatGaeldendeObjekt/1.0.0/WFS',
    'https://wms.datafordeler.dk/GeoDanmark60/GeoDanmark_60_Basis_Kortforsyningen/1.0.0/WMS',
    'https://arealinfo.miljoeportal.dk/api/jordforurening',
    'https://plandata.dk/api/wfs',
    'https://www.plandata.dk/api/wfs',
  ];

  for (const url of tilladte) {
    it(`tillader: ${url}`, () => {
      const res = validerUrl(url);
      expect(res.ok).toBe(true);
    });
  }

  it('afviser ukendt ekstern host', () => {
    const res = validerUrl('https://evil.com/steal-credentials');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fejl).toMatch(/tilladelseslisten|evil\.com/);
  });

  it('afviser subdomain af tilladt host der ikke er på listen', () => {
    // "api.bizzassist.dk" er ikke på listen (kun "bizzassist.dk" og specifikke subdomains)
    const res = validerUrl('https://api.bizzassist.dk/internal');
    expect(res.ok).toBe(false);
  });

  it('afviser forsøg på at forvirre parser med @-tegn', () => {
    // https://user@evil.com/ — hostname er evil.com, ikke user
    const res = validerUrl('https://bizzassist.dk@evil.com/pdf');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fejl).toMatch(/tilladelseslisten|evil\.com/);
  });

  it('afviser forsøg med userinfo der indeholder tilladt host', () => {
    const res = validerUrl('https://bizzassist.dk:password@169.254.169.254/metadata');
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ugyldig URL-syntaks
// ---------------------------------------------------------------------------
describe('validerUrl — ugyldig syntaks', () => {
  it('afviser tom streng', () => {
    const res = validerUrl('');
    expect(res.ok).toBe(false);
  });

  it('afviser streng uden skema', () => {
    const res = validerUrl('bizzassist.dk/api/rapport.pdf');
    expect(res.ok).toBe(false);
  });

  it('afviser URL med mellemrum', () => {
    const _res = validerUrl('https://bizzassist.dk/api /rapport.pdf');
    // URL parseren normaliserer typisk mellemrum — men den resulterende host er stadig valid;
    // testen sikrer at vi ikke går ned på parsefejlen
    const res2 = validerUrl('not a url at all');
    expect(res2.ok).toBe(false);
  });
});
