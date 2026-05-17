/**
 * E2E tests for kort-siden.
 *
 * BIZZ-1342: Fuldskærm kort, lag-toggle, adressesøg, markører.
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH, dismissOnboarding } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping kort tests');
  }
});

test.describe('Kort — fuldskærm', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/kort');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
  });

  test('kort-siden loader med Mapbox canvas', async ({ page }) => {
    await expect(page.locator('.mapboxgl-canvas, canvas').first()).toBeVisible({ timeout: 20_000 });
  });

  test('søgefelt er synligt', async ({ page }) => {
    await expect(page.getByPlaceholder(/Søg|Search|adresse/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
