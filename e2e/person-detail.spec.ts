/**
 * E2E tests for person-detaljesiden.
 *
 * BIZZ-1339: Dækker roller, diagram, privatejede ejendomme,
 * virksomheder, kronologi.
 *
 * Test-person: Jakob Juul Rasmussen (enhedsNummer 4000115446).
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH, dismissOnboarding } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping person-detail tests');
  }
});

test.describe('Person detalje — Jakob Juul Rasmussen', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/owners/4000115446');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
    await expect(page.getByRole('heading', { name: /Jakob Juul Rasmussen/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('viser personnavn og roller', async ({ page }) => {
    await expect(page.getByText(/Holding|ApS|virksomhed/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('diagram-tab renderer graf', async ({ page }) => {
    await page.getByRole('tab', { name: /Diagram|Relations/i }).click();
    await expect(page.locator('svg').or(page.locator('canvas')).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('ejendomme-tab viser ejendomme', async ({ page }) => {
    await page.getByRole('tab', { name: /Ejendomme|Properties/i }).click();
    await expect(page.getByText(/ejendom|BFE|Personligt ejet|property/i).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('virksomheder-tab viser virksomheder med roller', async ({ page }) => {
    await page.getByRole('tab', { name: /Virksomheder|Companies/i }).click();
    // Bør vise virksomheder med roller (ejer, direktør, bestyrelse)
    await expect(
      page.getByText(/Ejer|Direkt|Bestyrelse|Owner|Director|Board/i).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test('kronologi-tab viser hændelser', async ({ page }) => {
    await page.locator('text=Kronologi').first().click();
    // Kronologi bør vise tidslinje med roller og virksomheder
    await expect(
      page.getByText(/Bestyrelse|Direktion|Stiftere|Board|Director/i).first()
    ).toBeVisible({ timeout: 15_000 });
  });
});
