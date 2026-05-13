/**
 * E2E tests for ejendomsdetaljesiden.
 *
 * BIZZ-1337: Dækker oversigt, BBR, ejerskab, økonomi, SKAT,
 * tinglysning, dokumenter, ejendomsstruktur og kort.
 *
 * Test-ejendom: Søbyvej 11, 2650 Hvidovre (DAWA UUID i URL).
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH, dismissOnboarding } from './helpers';

/** Søbyvej 11, 2650 Hvidovre — korrekt DAWA adgangsadresse UUID */
const SOEBYVEJ_11 = '0a3f50a5-9af3-32b8-e044-0003ba298018';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping ejendom-detail tests');
  }
});

test.describe('Ejendom detalje — Søbyvej 11', () => {
  // Seriel execution: undgå rate-limit (GLOBAL_RATE_LIMIT_EXCEEDED) ved
  // parallelle page-loads mod test.bizzassist.dk.
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(async ({ page }) => {
    await page.goto(`/dashboard/ejendomme/${SOEBYVEJ_11}`);
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
    // Vent på at adressen loader i headeren (h1)
    await expect(page.getByRole('heading', { name: /Søbyvej 11/i })).toBeVisible({
      timeout: 20_000,
    });
  });

  test('oversigt-tab viser titel, BFE og kommune', async ({ page }) => {
    await expect(page.getByText(/BFE/i).first()).toBeVisible();
    await expect(page.getByText(/Hvidovre/i).first()).toBeVisible();
  });

  test('oversigt-tab viser bygninger og enheder', async ({ page }) => {
    // Bygninger/enheder-sektion med m²-arealer
    await expect(page.getByText(/bygning/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/m²/i).first()).toBeVisible();
  });

  test('BBR-tab loader og viser bygningsdata', async ({ page }) => {
    await page.locator('text=BBR').first().click();
    // BBR-tab bør vise bygningsinfo (opført, areal, anvendelse)
    await expect(page.getByText(/Opført|opførelsesår|Areal|Anvendelse/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('ejerskab-tab viser ejertabel', async ({ page }) => {
    await page.locator('text=Ejerskab').first().click();
    await expect(page.getByText(/Ejer|Owner|ejerandel/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('økonomi-tab viser vurdering', async ({ page }) => {
    await page.locator('text=Økonomi').first().click();
    await expect(page.getByText(/Vurdering|Ejendomsværdi|Grundværdi/i).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('SKAT-tab loader', async ({ page }) => {
    await page.locator('text=SKAT').first().click();
    // SKAT-tab bør vise skattedata eller "ingen data" meddelelse
    await page.waitForTimeout(5_000);
    const panel = page.locator('main, [role="tabpanel"], .flex-1');
    const content = await panel.first().textContent({ timeout: 10_000 });
    expect(content?.length).toBeGreaterThan(5);
  });

  test('tinglysning-tab viser adkomst', async ({ page }) => {
    await page.locator('text=Tinglysning').first().click();
    await expect(page.getByText(/Adkomst|Tingbog|hæftels/i).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('dokumenter-tab loader', async ({ page }) => {
    await page.locator('text=Dokumenter').first().click();
    await page.waitForTimeout(5_000);
    const panel = page.locator('main, [role="tabpanel"], .flex-1');
    const content = await panel.first().textContent({ timeout: 10_000 });
    expect(content?.length).toBeGreaterThan(5);
  });

  test('kort renderes (Mapbox canvas)', async ({ page }) => {
    await expect(page.locator('.mapboxgl-canvas, canvas').first()).toBeVisible({ timeout: 25_000 });
  });

  test('oversigt-tab viser vurderingsdata', async ({ page }) => {
    await expect(page.getByText(/EJENDOMSVURDERING|Ejendomsv|vurdering/i).first()).toBeVisible({
      timeout: 20_000,
    });
  });
});
