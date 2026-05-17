/**
 * BIZZ-1554 — verify Data Intelligence result-area uses full width
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) testInfo.skip(true, 'No E2E auth');
});

test('BIZZ-1554: intelligence result area is wider than 900px on desktop after query', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/dashboard/analyse/intelligence', { waitUntil: 'domcontentloaded' });
  const main = page.locator('main#main');
  await expect(main).toBeVisible({ timeout: 20_000 });
  const mainBox = await main.boundingBox();
  console.log(`[BIZZ-1554] main bbox:`, mainBox);

  // Submit a query that returns multiple rows
  const input = page.locator('input#prompt');
  await input.fill('Antal virksomheder pr kommune top 5');
  await page.locator('button[type="submit"]').first().click();

  // Wait for either loading or response to render
  const resultTable = page.locator('table').first();
  await expect(resultTable).toBeVisible({ timeout: 60_000 });
  const tableBox = await resultTable.boundingBox();
  console.log(`[BIZZ-1554] result table bbox:`, tableBox);
  await page.screenshot({ path: 'test-results/bizz-1554-after-query.png', fullPage: false });

  // Result table should use most of the main width (not collapsed to ~450px)
  expect(tableBox?.width ?? 0).toBeGreaterThan(900);
});
