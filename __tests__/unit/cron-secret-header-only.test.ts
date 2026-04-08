/**
 * Unit tests for BIZZ-181 — CRON_SECRET must be accepted only via Authorization header.
 *
 * Passing secrets as query parameters is unsafe: they appear in server access logs,
 * browser history, and HTTP Referer headers to third parties. All cron routes must
 * accept the secret ONLY as 'Authorization: Bearer <secret>'.
 *
 * This test verifies the verifyCronSecret logic by reading the source of each cron route
 * and confirming no query-param extraction of the secret is present.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const CRON_ROUTES = [
  'daily-report/route.ts',
  'daily-status/route.ts',
  'poll-properties/route.ts',
  'pull-bbr-events/route.ts',
  'purge-old-data/route.ts',
  'warm-cache/route.ts',
  'deep-scan/route.ts',
  'service-scan/route.ts',
  'generate-sitemap/route.ts',
];

const CRON_BASE = resolve(__dirname, '../../app/api/cron');

describe('cron routes — BIZZ-181 CRON_SECRET header-only enforcement', () => {
  for (const routeFile of CRON_ROUTES) {
    const routePath = resolve(CRON_BASE, routeFile);
    const source = readFileSync(routePath, 'utf-8');

    it(`${routeFile} does not read CRON_SECRET from query params`, () => {
      // Patterns that would indicate query param secret extraction
      // e.g. searchParams.get('secret') or URL(...).searchParams.get('secret')
      expect(source).not.toMatch(/searchParams\.get\(['"]secret['"]\)/);
      expect(source).not.toMatch(/query\??\.secret/);
      expect(source).not.toMatch(/\?secret=/);
    });

    it(`${routeFile} reads CRON_SECRET from Authorization header`, () => {
      expect(source).toContain('CRON_SECRET');
      expect(source).toContain("headers.get('authorization')");
    });
  }
});
