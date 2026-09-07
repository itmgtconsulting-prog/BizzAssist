/**
 * E2E regression tests for the integrations routes — BIZZ-2275.
 *
 * The Gmail/LinkedIn integration routes passed a tenant UUID to tenantDb()
 * (which expects a schema name), and email_integrations lived in the shared,
 * non-exposed `tenant` schema → PGRST106 → HTTP 500 on every call. Migration
 * 217 moved the table to the per-tenant tenant_<slug> schema and the routes now
 * resolve the schema name first.
 *
 * This locks the fix: the status GETs must return 200 with a `connected`
 * boolean — NOT the 500 the bug produced. (The full OAuth connect flow needs
 * live Google/LinkedIn credentials and cannot be exercised headlessly, so the
 * read path is the regression anchor — it is exactly what was confirmed broken.)
 *
 * Read-only: no rows are created or deleted, so a real connection (if any) is
 * left untouched.
 *
 * Auth: tenant member via shared storageState. Requires E2E_TEST_EMAIL; skipped
 * otherwise. Target: test.bizzassist.dk (deploys from develop).
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping integrations tests');
  }
});

test.describe('Integrations routes (BIZZ-2275)', () => {
  test('GET /api/integrations/gmail → 200 med connected-flag (ikke 500/PGRST106)', async ({
    request,
  }) => {
    const res = await request.get('/api/integrations/gmail');
    expect(res.status(), 'gmail status må ikke være 500 (schema-resolution-bug)').toBe(200);
    const body = (await res.json()) as { connected?: boolean };
    expect(typeof body.connected).toBe('boolean');
  });

  test('GET /api/integrations/linkedin → 200 med connected-flag (ikke 500/PGRST106)', async ({
    request,
  }) => {
    const res = await request.get('/api/integrations/linkedin');
    expect(res.status(), 'linkedin status må ikke være 500 (schema-resolution-bug)').toBe(200);
    const body = (await res.json()) as { connected?: boolean };
    expect(typeof body.connected).toBe('boolean');
  });
});
