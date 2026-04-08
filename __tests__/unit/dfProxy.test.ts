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
