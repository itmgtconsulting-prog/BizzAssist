/**
 * E2E test for BIZZ-2143 — Bilbogen-forklaring paa virksomhedens Tinglysning-tab.
 *
 * Verificerer at den altid-synlige forklaringstekst ("Viser tinglyste
 * haeftelser ... ikke en komplet liste over ejede koeretojer") vises under
 * Bilbogen-sektionen, saa brugeren ikke forveksler bilbogen med en komplet
 * koeretojsliste.
 *
 * Test-virksomhed: CVR 33058446 (fra BIZZ-2143 screenshot).
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH, dismissOnboarding } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping bilbog-forklaring test');
  }
});

test.describe('BIZZ-2143: Bilbogen-forklaring', () => {
  test('forklaringstekst er synlig under Bilbogen', async ({ page }) => {
    await page.goto('/dashboard/companies/33058446');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);

    // Aabn Tinglysning-tab
    await page.locator('text=Tinglysning').first().click();
    await page.waitForTimeout(4_000);

    // Bilbogen-sektion + altid-synlig forklaring
    await expect(page.getByText('Bilbogen').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/ikke en komplet liste over ejede køretøjer/i).first()).toBeVisible(
      { timeout: 10_000 }
    );

    await page.screenshot({ path: 'playwright-report/bizz-2143-bilbog-forklaring.png' });
  });
});
