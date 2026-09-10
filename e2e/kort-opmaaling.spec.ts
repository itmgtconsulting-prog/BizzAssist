/**
 * E2E for the interactive map measure tool — BIZZ-2285.
 *
 * Runs in both chromium-auth (desktop) and chromium-mobile (375px). Activates
 * the Opmål tool on /dashboard/kort, places two points on the map, and asserts a
 * distance readout appears — proving click/tap placement + live measurement work
 * on both viewports. Captures a screenshot per viewport as the visual artifact.
 *
 * Auth via shared storageState; requires E2E_TEST_EMAIL. Target: test.bizzassist.dk.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping kort-opmåling test');
  }
});

test.describe('Kort opmålingsværktøj (BIZZ-2285)', () => {
  test('placér punkter → afstand vises (klik/tap)', async ({ page }) => {
    test.setTimeout(90_000);

    await page.goto('/dashboard/kort');
    await page.waitForLoadState('networkidle');
    // Vent på at Mapbox-lærredet er klar.
    await expect(page.locator('.mapboxgl-canvas')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2500);

    // Aktivér opmålingsværktøjet.
    await page
      .getByRole('button', { name: /Opmål|Measure tool/i })
      .first()
      .click();
    // Panelet + Afstand-fanen skal vises.
    await expect(page.getByRole('tab', { name: /Afstand|Distance/ })).toBeVisible({
      timeout: 5_000,
    });

    // Placér to punkter på kortet (viewport-relative, uden for top-toolbar/panel).
    const vp = page.viewportSize() ?? { width: 1280, height: 720 };
    const p1 = { x: Math.round(vp.width * 0.5), y: Math.round(vp.height * 0.48) };
    const p2 = { x: Math.round(vp.width * 0.62), y: Math.round(vp.height * 0.6) };
    await page.mouse.click(p1.x, p1.y);
    await page.waitForTimeout(400);
    await page.mouse.click(p2.x, p2.y);

    // En afstand (m/km) skal fremgå (marker + panel-readout).
    await expect(page.getByText(/\d+([.,]\d+)?\s?(m|km)\b/).first()).toBeVisible({
      timeout: 10_000,
    });

    await page.screenshot({ path: `.playwright/2285-opmaaling-${vp.width}.png` });
  });
});
