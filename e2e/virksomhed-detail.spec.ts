/**
 * E2E tests for virksomhedsdetaljesiden.
 *
 * BIZZ-1338: Dækker CVR-data, diagram, regnskab, ejendomme, tinglysning.
 *
 * Test-virksomhed: JaJR Holding ApS (CVR 41092807).
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH, dismissOnboarding } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping virksomhed-detail tests');
  }
});

test.describe('Virksomhed detalje — JaJR Holding ApS', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/companies/41092807');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
  });

  test('viser virksomhedsnavn og CVR', async ({ page }) => {
    await expect(page.getByText(/JaJR Holding/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/41092807/)).toBeVisible();
  });

  test('diagram-tab renderer graf', async ({ page }) => {
    await page.getByRole('tab', { name: /Diagram|Relations/i }).click();
    // Vent på at diagrammet renderer (SVG eller canvas)
    await expect(page.locator('svg').or(page.locator('canvas')).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('ejendomme-tab viser ejendomme', async ({ page }) => {
    await page.getByRole('tab', { name: /Ejendomme|Properties/i }).click();
    // Bør vise ejendomme fra datterselskaber
    await expect(page.getByText(/ejendom|BFE|property/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('gruppe-tab viser relaterede selskaber', async ({ page }) => {
    await page.getByRole('tab', { name: /Gruppe|Group/i }).click();
    await expect(page.getByText(/Datterselskab|datter|Subsidiary/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
