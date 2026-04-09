/**
 * Unit tests for BIZZ-190 — SSRF protection in app/lib/dfProxy.proxyUrl().
 *
 * Verifies that:
 *  - allowlisted Datafordeler hostnames pass through without throwing
 *  - non-allowlisted URLs (including internal/private hosts) throw an error
 *  - proxy rewriting still works correctly for allowed URLs when DF_PROXY_URL is set
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// NOTE: dfProxy.ts is excluded from vitest coverage (see vitest.config.ts),
// but is not excluded from being imported and tested.
import { proxyUrl } from '@/app/lib/dfProxy';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function withProxyEnv(proxyUrl_: string, fn: () => void) {
  const original = process.env.DF_PROXY_URL;
  process.env.DF_PROXY_URL = proxyUrl_;
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env.DF_PROXY_URL;
    } else {
      process.env.DF_PROXY_URL = original;
    }
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('proxyUrl — BIZZ-190 SSRF protection', () => {
  beforeEach(() => {
    delete process.env.DF_PROXY_URL;
  });

  afterEach(() => {
    delete process.env.DF_PROXY_URL;
  });

  // ── Allowlisted URLs must NOT throw ──────────────────────────────────────────

  it('allows *.datafordeler.dk URLs', () => {
    expect(() =>
      proxyUrl('https://graphql.datafordeler.dk/BBR/v2?username=x&password=y')
    ).not.toThrow();
  });

  it('allows api.datafordeler.dk (subdomain)', () => {
    expect(() => proxyUrl('https://api.datafordeler.dk/mat/v1/')).not.toThrow();
  });

  it('allows distribution.virk.dk', () => {
    expect(() =>
      proxyUrl('https://distribution.virk.dk/cvr-permanent/virksomhed/_search')
    ).not.toThrow();
  });

  it('allows api-fs.vurderingsportalen.dk', () => {
    expect(() => proxyUrl('https://api-fs.vurderingsportalen.dk/ejendom/search')).not.toThrow();
  });

  // ── Non-allowlisted URLs must throw ──────────────────────────────────────────

  it('throws for an arbitrary external host', () => {
    expect(() => proxyUrl('https://evil.example.com/steal-data')).toThrow(/SSRF-beskyttelse/);
  });

  it('throws for localhost (internal SSRF)', () => {
    expect(() => proxyUrl('https://localhost:3000/api/secret')).toThrow(/SSRF-beskyttelse/);
  });

  it('throws for a private IP range host', () => {
    expect(() => proxyUrl('https://192.168.1.1/admin')).toThrow(/SSRF-beskyttelse/);
  });

  it('throws for a host that only ends with datafordeler.dk in the path', () => {
    // The hostname here is "evil.com", not "*.datafordeler.dk"
    expect(() => proxyUrl('https://evil.com/proxy/graphql.datafordeler.dk/BBR/v2')).toThrow(
      /SSRF-beskyttelse/
    );
  });

  it('throws for a malformed URL', () => {
    expect(() => proxyUrl('not-a-url')).toThrow(/Ugyldig URL/);
  });

  // ── Proxy rewriting works for allowed URLs ────────────────────────────────────

  it('rewrites allowlisted URL through proxy when DF_PROXY_URL is set', () => {
    withProxyEnv('https://bizzassist-test.bizzassist.dk', () => {
      const result = proxyUrl('https://graphql.datafordeler.dk/BBR/v2?apiKey=xxx');
      expect(result).toBe(
        'https://bizzassist-test.bizzassist.dk/proxy/graphql.datafordeler.dk/BBR/v2?apiKey=xxx'
      );
    });
  });

  it('returns URL unchanged when DF_PROXY_URL is not set', () => {
    const url = 'https://graphql.datafordeler.dk/BBR/v2?apiKey=xxx';
    expect(proxyUrl(url)).toBe(url);
  });
});

// ─── SSRF allowlist — private/reserved IP ranges ──────────────────────────────

describe('proxyUrl — SSRF private IP range blocking', () => {
  it('throws for 10.x.x.x (RFC-1918 private range)', () => {
    expect(() => proxyUrl('https://10.0.0.1/secret')).toThrow(/SSRF-beskyttelse/);
    expect(() => proxyUrl('https://10.255.255.255/admin')).toThrow(/SSRF-beskyttelse/);
  });

  it('throws for 192.168.x.x (RFC-1918 private range)', () => {
    expect(() => proxyUrl('https://192.168.0.1/internal')).toThrow(/SSRF-beskyttelse/);
    expect(() => proxyUrl('https://192.168.100.200/router')).toThrow(/SSRF-beskyttelse/);
  });

  it('throws for 172.16.x.x – 172.31.x.x (RFC-1918 private range)', () => {
    expect(() => proxyUrl('https://172.16.0.1/private')).toThrow(/SSRF-beskyttelse/);
    expect(() => proxyUrl('https://172.31.255.255/admin')).toThrow(/SSRF-beskyttelse/);
  });

  it('throws for 127.x.x.x (loopback)', () => {
    expect(() => proxyUrl('https://127.0.0.1/local')).toThrow(/SSRF-beskyttelse/);
    expect(() => proxyUrl('https://127.1.2.3/api')).toThrow(/SSRF-beskyttelse/);
  });

  it('throws for "localhost" (loopback hostname)', () => {
    expect(() => proxyUrl('http://localhost/api/secret')).toThrow(/SSRF-beskyttelse/);
  });

  it('throws for 0.0.0.0 (unspecified / any-interface)', () => {
    expect(() => proxyUrl('https://0.0.0.0/admin')).toThrow(/SSRF-beskyttelse/);
  });

  it('throws for arbitrary public IP not in allowlist', () => {
    expect(() => proxyUrl('https://93.184.216.34/data')).toThrow(/SSRF-beskyttelse/);
  });

  it('throws for a completely different public domain not in allowlist', () => {
    expect(() => proxyUrl('https://openai.com/v1/chat')).toThrow(/SSRF-beskyttelse/);
  });

  // ── Public allowed IPs / domains must still work ──────────────────────────

  it('allows api.datafordeler.dk (should NOT throw)', () => {
    expect(() => proxyUrl('https://api.datafordeler.dk/endpoint')).not.toThrow();
  });

  it('allows distribution.virk.dk (should NOT throw)', () => {
    expect(() =>
      proxyUrl('https://distribution.virk.dk/cvr-permanent/virksomhed/_search')
    ).not.toThrow();
  });

  // ── Malformed URL handling ────────────────────────────────────────────────

  it('throws an "Ugyldig URL" error for a plain string with no scheme', () => {
    expect(() => proxyUrl('just-a-hostname')).toThrow(/Ugyldig URL/);
  });

  it('throws an "Ugyldig URL" error for an empty string', () => {
    expect(() => proxyUrl('')).toThrow(/Ugyldig URL/);
  });

  it('throws an "Ugyldig URL" error for a relative path', () => {
    expect(() => proxyUrl('/api/internal?key=abc')).toThrow(/Ugyldig URL/);
  });
});
