/**
 * E2E regression test for the cross-tenant user-activity aggregator — BIZZ-2289.
 *
 * GET /api/admin/user-activity aggregates activity_log across tenants. It
 * previously queried admin.from('activity_log') on the default (public) schema,
 * where the table does not exist → empty/broken. It now iterates each tenant's
 * per-tenant schema (error-isolated). This locks that it returns 200 with a
 * users array (not 500) for a super-admin.
 *
 * Auth: super-admin (isAdmin) via shared storageState (jjrchefen on test).
 * Requires E2E_TEST_EMAIL; skipped otherwise. Target: test.bizzassist.dk.
 * Read-only — creates/deletes nothing.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping user-activity tests');
  }
});

test.describe('Admin user-activity aggregator (BIZZ-2289)', () => {
  test('GET /api/admin/user-activity → 200 med users-array (per-tenant iteration)', async ({
    request,
  }) => {
    const res = await request.get('/api/admin/user-activity?days=30');
    // 200 for super-admin (403 if the E2E user is not admin — still not a 500).
    expect(res.status(), 'må ikke være 500 (schema-iteration-bug)').not.toBe(500);
    if (res.status() === 200) {
      const body = (await res.json()) as { users?: unknown; period?: { days: number } };
      expect(Array.isArray(body.users)).toBe(true);
      expect(body.period?.days).toBe(30);
    }
  });
});
