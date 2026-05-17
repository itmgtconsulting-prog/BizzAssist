/**
 * BIZZ-1583 — verify Sælger-kolonne i salgshistorik-tabellen.
 *
 * Søbyvej 11, 2650 Hvidovre (BFE 2081243) har 4 handler — perfekt til at
 * verificere at sælger udledes som forrige (ældre) handels køber.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

const BFE = 2081243;

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) testInfo.skip(true, 'No E2E auth');
});

test('BIZZ-1583: Salgshistorik viser Sælger-kolonne', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/dashboard/ejendomme/${BFE}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  // Skift til Økonomi-fanen — kan være tab role eller button
  const oekonomiTab = page
    .locator('button, [role="tab"]')
    .filter({ hasText: /^[ØO]konomi$/ })
    .first();
  await expect(oekonomiTab).toBeVisible({ timeout: 30_000 });
  await oekonomiTab.click();

  // Vent på salgshistorik-tabel og Sælger-header
  const saelgerHeader = page.locator('th').filter({ hasText: /^S[æa]lger$/ });
  await expect(saelgerHeader.first()).toBeVisible({ timeout: 30_000 });
  console.log(`[BIZZ-1583] Sælger-header fundet`);

  // Bekræft at Køber-kolonne fortsat findes (tilfojet uden at fjerne)
  const koeberHeader = page.locator('th').filter({ hasText: /^K[øo]ber$/ });
  await expect(koeberHeader.first()).toBeVisible();

  await page.screenshot({ path: 'test-results/bizz-1583-saelger.png', fullPage: false });
});
