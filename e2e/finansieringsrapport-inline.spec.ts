/**
 * BIZZ-1589 — verify finansieringsrapport renders inline panel, not modal overlay.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) testInfo.skip(true, 'No E2E auth');
});

test('BIZZ-1589: finansieringsrapport-side viser ikke fixed dialog-overlay initielt', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/dashboard/analyse/finansieringsrapport', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  // Vent på header — bekræfter at side er rendret
  const header = page.getByRole('heading', { name: /Finansieringsrapport/i }).first();
  await expect(header).toBeVisible({ timeout: 20_000 });

  // Der skal IKKE være en fixed-inset overlay (rolled='dialog' med fixed-class)
  const fixedDialogs = page.locator('[role="dialog"].fixed');
  const count = await fixedDialogs.count();
  console.log(`[BIZZ-1589] fixed role=dialog elementer: ${count}`);
  expect(count).toBe(0);

  // Søgefeltet skal være synligt (input-blokken er øverst)
  const searchInput = page.locator('input#property-search');
  await expect(searchInput).toBeVisible();
});
