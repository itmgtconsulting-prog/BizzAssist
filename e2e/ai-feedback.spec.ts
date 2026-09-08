/**
 * E2E regression tests for the AI-feedback routes — BIZZ-2288.
 *
 * ai_feedback_log lives in the per-tenant tenant_<slug> schema, but the routes
 * queried the shared, non-exposed `tenant` schema (tenantDb('tenant')) → PGRST106
 * → HTTP 500. This locks the fix: a feedback entry can be written via
 * POST /api/ai/feedback and read back via GET /api/admin/ai-feedback (admin),
 * proving the write + read now reach the per-tenant table.
 *
 * Auth: tenant_admin via shared storageState (jjrchefen on test). Requires
 * E2E_TEST_EMAIL; skipped otherwise. Target: test.bizzassist.dk.
 *
 * Note: /api/ai/feedback is insert-only (no delete endpoint), so each run leaves
 * one clearly-marked feedback row on the test tenant. It carries no PII and is
 * purged by the 12-month retention cron.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping ai-feedback tests');
  }
});

test.describe('AI-feedback routes (BIZZ-2288)', () => {
  test('POST /api/ai/feedback → 200 og entry læses via admin (ikke 500/PGRST106)', async ({
    request,
  }) => {
    // Unique marker so we can find our own row in the admin list.
    const marker = `E2E-KB-FEEDBACK regressionsprobe ${Date.now()}`;

    // Write (was PGRST106/500 before the per-tenant repoint).
    const post = await request.post('/api/ai/feedback', {
      data: { questionText: marker, feedbackType: 'missing_capability' },
    });
    expect(post.status(), 'ai/feedback POST må ikke være 500').toBe(200);

    // Read back via the admin list (tenant_admin) and confirm our entry is there.
    const list = await request.get('/api/admin/ai-feedback?type=missing_capability&limit=200');
    expect(list.status(), 'admin/ai-feedback GET må ikke være 500').toBe(200);
    const rows = (await list.json()) as Array<{ question_text: string }>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.some((r) => r.question_text === marker)).toBe(true);
  });

  test('GET /api/admin/ai-feedback → 200 array (schema-resolution-fix)', async ({ request }) => {
    const res = await request.get('/api/admin/ai-feedback');
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
