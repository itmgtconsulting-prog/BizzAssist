/**
 * BIZZ-1593 — verify Data Intelligence end-of-list marker + sticky footer bar
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) testInfo.skip(true, 'No E2E auth');
});

test('BIZZ-1593: result table viser end-of-list marker og sticky footer', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/dashboard/analyse/intelligence', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('main#main')).toBeVisible({ timeout: 20_000 });

  // Submit en query der returnerer få (<200) rækker
  const input = page.locator('input#prompt');
  await input.fill('Antal virksomheder pr kommune top 5');
  await page.locator('button[type="submit"]').first().click();

  // Vent på resultat-tabel
  const resultTable = page.locator('table').first();
  await expect(resultTable).toBeVisible({ timeout: 60_000 });

  // 1) End-of-list marker
  const endMarker = page.getByText(/Slut p[åa] resultater/);
  await expect(endMarker).toBeVisible({ timeout: 10_000 });
  const endText = await endMarker.textContent();
  console.log(`[BIZZ-1593] end-of-list marker text: "${endText?.trim()}"`);

  // 2) Sticky footer info-bar med "rækker i alt"
  const footer = page.getByText(/r[æa]kker? i alt/);
  await expect(footer).toBeVisible({ timeout: 5_000 });
  const footerText = await footer.textContent();
  console.log(`[BIZZ-1593] footer text: "${footerText?.trim()}"`);

  await page.screenshot({ path: 'test-results/bizz-1593-end-of-list.png', fullPage: false });
});
