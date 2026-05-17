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
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/companies/41092807');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
    // Vent på h1 med virksomhedsnavn
    await expect(page.getByRole('heading', { name: /JaJR Holding/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('viser virksomhedsnavn og CVR', async ({ page }) => {
    await expect(page.getByText(/41092807/).first()).toBeVisible();
  });

  test('viser CVR-badges (status, type)', async ({ page }) => {
    await expect(page.getByText(/Aktiv|Active|Normal/i).first()).toBeVisible();
    await expect(page.getByText(/ApS|A\/S|Holding/i).first()).toBeVisible();
  });

  test('diagram-tab renderer graf', async ({ page }) => {
    await page.locator('text=Diagram').first().click();
    await expect(page.locator('svg').first()).toBeVisible({ timeout: 20_000 });
  });

  test('ejendomme-tab viser ejendomme', async ({ page }) => {
    await page.locator('text=Ejendomme').first().click();
    await expect(page.getByText(/ejendom|BFE|property/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('virksomheder-tab viser relaterede selskaber', async ({ page }) => {
    await page.locator('text=Virksomheder').first().click();
    await expect(
      page.getByText(/Datterselskab|datter|Subsidiary|moderselskab/i).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test('regnskab-tab viser nøgletal', async ({ page }) => {
    await page.locator('text=Regnskab').first().click();
    await expect(
      page.getByText(/Omsætning|Resultat|Egenkapital|Revenue|Profit|Equity|regnskab/i).first()
    ).toBeVisible({ timeout: 20_000 });
  });

  test('personer-tab viser bestyrelse og direktion', async ({ page }) => {
    await page.locator('text=Personer').first().click();
    await expect(page.getByText(/Direkt|Bestyrelse|Director|Board|rolle/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('tinglysning-tab loader', async ({ page }) => {
    await page.locator('text=Tinglysning').first().click();
    await page.waitForTimeout(5_000);
    const panel = page.locator('main, [role="tabpanel"], .flex-1');
    const content = await panel.first().textContent({ timeout: 10_000 });
    expect(content?.length).toBeGreaterThan(5);
  });
});
