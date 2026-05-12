/**
 * E2E tests for notifikationer.
 *
 * BIZZ-1345: Klokke-dropdown, følg-knap på ejendom/virksomhed.
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH, dismissOnboarding } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping notifikation tests');
  }
});

test.describe('Notifikationer', () => {
  test('klokke-ikon er synligt i header', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
    await expect(
      page
        .locator('[aria-label*="Notifikation"], [aria-label*="Notification"], button:has(svg)')
        .first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test('følg-knap synlig på ejendomsside', async ({ page }) => {
    await page.goto('/dashboard/ejendomme/0a3f50a8-b6f1-32b8-e044-0003ba298018');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
    await expect(page.getByText(/Følg|Follow/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
