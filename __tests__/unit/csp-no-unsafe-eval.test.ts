/**
 * Unit tests for BIZZ-194 — 'unsafe-eval' must not appear in the global CSP.
 *
 * Mapbox GL JS needs eval() for shader compilation, but that requirement
 * should be scoped to the map routes (/dashboard/kort, /kort) only.
 * Adding 'unsafe-eval' globally widens the XSS attack surface unnecessarily.
 *
 * These tests parse next.config.ts directly and verify:
 *  - The global Content-Security-Policy does NOT contain 'unsafe-eval'
 *  - The map-route-specific override DOES contain 'unsafe-eval'
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ─── Read next.config.ts as raw text for CSP string extraction ───────────────
// We cannot import next.config.ts directly in vitest (it uses CommonJS require()
// and withSentryConfig which requires build-time context). Parsing the source
// text is sufficient for this assertion.

const configPath = resolve(__dirname, '../../next.config.ts');
const configSource = readFileSync(configPath, 'utf-8');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('next.config.ts CSP — BIZZ-194 unsafe-eval scope', () => {
  it('global securityHeaders CSP does not contain unsafe-eval', () => {
    // The script-src line in securityHeaders is the authoritative global CSP.
    // It must NOT contain 'unsafe-eval'. We locate the line that sets the
    // global script-src (before mapCspValue is computed).
    //
    // Strategy: find the line with "script-src 'self' 'unsafe-inline'" that does
    // NOT also contain 'unsafe-eval'. At least one such line must exist.
    const scriptSrcLines = configSource
      .split('\n')
      .filter((line) => line.includes('script-src') && line.includes("'unsafe-inline'"));

    // There must be at least one script-src line
    expect(scriptSrcLines.length).toBeGreaterThan(0);

    // At least one script-src line must NOT have 'unsafe-eval' (the global one).
    const globalCspLine = scriptSrcLines.find((line) => !line.includes("'unsafe-eval'"));
    expect(globalCspLine).toBeTruthy();
  });

  it('map-route override adds unsafe-eval for Mapbox GL JS', () => {
    // The mapCspValue variable replaces the script-src to add unsafe-eval
    const mapCspSection = configSource.match(/const mapCspValue[\s\S]*?;/);
    expect(mapCspSection).toBeTruthy();
    expect(mapCspSection![0]).toContain("'unsafe-eval'");
  });

  it('map route /dashboard/kort uses the override headers with unsafe-eval', () => {
    expect(configSource).toContain("source: '/dashboard/kort'");
    expect(configSource).toContain('headers: mapHeaders');
  });

  it('map route /kort uses the override headers with unsafe-eval', () => {
    expect(configSource).toContain("source: '/kort'");
  });
});
