/**
 * Unit tests for BIZZ-174 — service-manager scan URL must come from env, not Origin header.
 *
 * Using `request.headers.get('origin')` as the base URL for the internal scan
 * fetch allows an attacker to supply a malicious Origin header and make the
 * server issue a request to an arbitrary host (SSRF).
 *
 * The fix replaces it with `process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk'`.
 *
 * This test verifies that:
 *  - The route source does NOT use request.headers.get('origin') for the fetch URL
 *  - The fetch URL is built from NEXT_PUBLIC_APP_URL / a hardcoded fallback
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const routeSource = readFileSync(
  resolve(__dirname, '../../app/api/admin/service-manager/route.ts'),
  'utf-8'
);

describe('service-manager POST — BIZZ-174 SSRF via Origin header', () => {
  it('does not use request.headers.get("origin") as the base URL for the scan fetch', () => {
    // The SSRF vulnerability: using the Origin header as the base for the internal fetch.
    // Verify the vulnerable pattern is gone.
    expect(routeSource).not.toMatch(/request\.headers\.get\(['"]origin['"]\)/);
  });

  it('uses NEXT_PUBLIC_APP_URL env var as the internal scan base URL', () => {
    expect(routeSource).toContain('NEXT_PUBLIC_APP_URL');
  });

  it('has a hardcoded fallback to bizzassist.dk when env var is missing', () => {
    expect(routeSource).toContain('https://bizzassist.dk');
  });

  it('the scan fetch catch handler logs the error', () => {
    // Ensure the floating fetch has a .catch() so errors are not silently swallowed
    expect(routeSource).toContain('.catch((err) =>');
    expect(routeSource).toContain('scan error');
  });
});
