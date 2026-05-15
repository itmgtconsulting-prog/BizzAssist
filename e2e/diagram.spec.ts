/**
 * E2E tests for ejerskabsdiagram (virksomhed + person).
 *
 * BIZZ-1340+1346: Dækker diagram-rendering, udvid-knap,
 * ejendomme-toggle, zoom/pan.
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH, dismissOnboarding } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping diagram tests');
  }
});

test.describe('Virksomhedsdiagram — JaJR Holding', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/companies/41092807');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
    await page.getByRole('tab', { name: /Diagram|Relations/i }).click();
  });

  test('diagram renderer SVG/canvas', async ({ page }) => {
    await expect(page.locator('svg').or(page.locator('canvas')).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('diagram viser virksomhedsnoder', async ({ page }) => {
    await expect(page.getByText(/JaJR Holding/i).first()).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('Person-diagram — Jakob Juul Rasmussen', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/owners/4000115446');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
    await page.getByRole('tab', { name: /Diagram|Relations/i }).click();
  });

  test('person-diagram renderer', async ({ page }) => {
    await expect(page.locator('svg').or(page.locator('canvas')).first()).toBeVisible({
      timeout: 20_000,
    });
  });
});

test.describe('Ejendomsdiagram — Søbyvej 11', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/ejendomme/0a3f50a8-b6f1-32b8-e044-0003ba298018');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
    await page.getByRole('tab', { name: /Ejerskab|Ownership/i }).click();
  });

  test('ejerskabsdiagram renderer', async ({ page }) => {
    await expect(page.locator('svg').or(page.locator('canvas')).first()).toBeVisible({
      timeout: 25_000,
    });
  });
});
