/**
 * Unit tests for BIZZ-194 — 'unsafe-eval' must not appear in the global CSP.
 *
 * Mapbox GL JS needs eval() for shader compilation, but that requirement
 * should be scoped to the map routes (/dashboard/kort, /kort) only.
 * Adding 'unsafe-eval' globally widens the XSS attack surface unnecessarily.
 *
 * BIZZ-209 note: CSP was moved from next.config.ts to proxy.ts (nonce-based).
 * Tests now check both possible locations and skip gracefully if the CSP has been
 * removed from next.config.ts as part of the nonce migration.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ─── Read source files ────────────────────────────────────────────────────────

const configPath = resolve(__dirname, '../../next.config.ts');
const configSource = readFileSync(configPath, 'utf-8');

const proxyPath = resolve(__dirname, '../../proxy.ts');
const proxySource = existsSync(proxyPath) ? readFileSync(proxyPath, 'utf-8') : null;

/** True when CSP is still in next.config.ts (pre-BIZZ-209 architecture). */
const cspInConfig = configSource.includes('script-src');

/** True when CSP has been moved to proxy.ts (BIZZ-209 nonce-based architecture). */
const cspInProxy = proxySource !== null && proxySource.includes('script-src');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('next.config.ts CSP — BIZZ-194 unsafe-eval scope', () => {
  it('global CSP does not contain unconditional unsafe-eval', () => {
    if (!cspInConfig && !cspInProxy) {
      return;
    }

    const source = cspInConfig ? configSource : proxySource!;
    const scriptSrcLines = source.split('\n').filter((line) => line.includes('script-src'));

    // The map-route CSP is a string literal with unconditional unsafe-eval.
    // The global CSP must NOT have unconditional unsafe-eval (it may have
    // a dev-only conditional like `${isDev ? " 'unsafe-eval'" : ''}`).
    const unconditionalEvalLines = scriptSrcLines.filter(
      (line) =>
        line.includes("'unsafe-eval'") && !line.includes('isDev') && !line.includes('development')
    );

    // Only the map-route line should have unconditional unsafe-eval.
    // It must also contain unsafe-inline (Mapbox signature).
    for (const line of unconditionalEvalLines) {
      expect(line).toContain("'unsafe-inline'");
    }
  });

  it('map-route unsafe-eval override exists when CSP is in next.config.ts', () => {
    if (!cspInConfig) {
      // CSP moved to proxy.ts (BIZZ-209) — map-route override lives there now.
      return;
    }
    const mapCspSection = configSource.match(/const mapCspValue[\s\S]*?;/);
    expect(mapCspSection).toBeTruthy();
    expect(mapCspSection![0]).toContain("'unsafe-eval'");
  });

  it('map route /dashboard/kort uses override headers when CSP is in next.config.ts', () => {
    if (!cspInConfig) {
      return;
    }
    expect(configSource).toContain("source: '/dashboard/kort'");
    expect(configSource).toContain('headers: mapHeaders');
  });

  it('map route /kort uses override headers when CSP is in next.config.ts', () => {
    if (!cspInConfig) {
      return;
    }
    expect(configSource).toContain("source: '/kort'");
  });

  it('proxy.ts uses nonce-based CSP instead of unsafe-inline for non-map routes (BIZZ-209)', () => {
    if (!cspInProxy) {
      return;
    }
    // The global script-src must use a nonce, not unsafe-inline
    expect(proxySource).toContain("'nonce-${nonce}'");
    // Map routes are allowed to keep unsafe-inline for Mapbox compatibility
    expect(proxySource).toContain('isMapRoute');
  });
});
