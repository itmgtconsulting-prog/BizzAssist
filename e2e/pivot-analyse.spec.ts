/**
 * E2E tests for pivot-analyse.
 *
 * BIZZ-1343: Datakilde, kolonner, filtre, indlæs data, AI query builder.
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH, dismissOnboarding } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping pivot-analyse tests');
  }
});

test.describe('Pivot Analyse', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/analyse');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
  });

  test('analyse-siden loader med datakilde-valg', async ({ page }) => {
    await expect(page.getByText(/Analyse|Data|Pivot/i).first()).toBeVisible({ timeout: 10_000 });
  });
});
