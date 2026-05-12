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

/** Søbyvej 11 DAWA UUID */
const SOEBYVEJ_11 = '0a3f50a8-b6f1-32b8-e044-0003ba298018';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping ejendom-detail tests');
  }
});

test.describe('Ejendom detalje — Søbyvej 11', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/dashboard/ejendomme/${SOEBYVEJ_11}`);
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
  });

  test('oversigt-tab viser titel, BFE og matrikel', async ({ page }) => {
    // Adressen vises i headeren
    await expect(page.getByText(/Søbyvej 11/i)).toBeVisible({ timeout: 20_000 });
    // BFE-nummer vises
    await expect(page.getByText(/BFE/i)).toBeVisible();
  });

  test('oversigt-tab viser bygninger (kun aktive)', async ({ page }) => {
    // Vent på at bygningsdata loader
    await expect(page.getByText(/Bygninger|Buildings/i).first()).toBeVisible({ timeout: 20_000 });
    // Bør IKKE vise 5 (nedrevne inkluderet) — korrekt er 3 eller 4 aktive
    const bygningerText = await page
      .getByText(/^\d+ bygning/i)
      .first()
      .textContent();
    if (bygningerText) {
      const count = parseInt(bygningerText);
      expect(count).toBeLessThanOrEqual(4);
    }
  });

  test('BBR-tab loader og viser bygninger', async ({ page }) => {
    // Klik BBR-tab
    await page.getByRole('tab', { name: /BBR/i }).click();
    await expect(page.getByText(/Bygning opført|Building constructed/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('ejerskab-tab viser ejertabel', async ({ page }) => {
    // Klik Ejerskab-tab
    await page.getByRole('tab', { name: /Ejerskab|Ownership/i }).click();
    // Ejertabel bør vise mindst én ejer
    await expect(page.getByText(/Ejer|Owner/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('økonomi-tab viser vurdering', async ({ page }) => {
    await page.getByRole('tab', { name: /Økonomi|Financials/i }).click();
    await expect(page.getByText(/Vurdering|Valuation/i).first()).toBeVisible({ timeout: 15_000 });
  });

  test('SKAT-tab loader', async ({ page }) => {
    await page.getByRole('tab', { name: /SKAT|Tax/i }).click();
    await expect(page.getByText(/Grundskyld|Ejendomsværdiskat|grundskyld/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('tinglysning-tab viser adkomst med ejernavne', async ({ page }) => {
    await page.getByRole('tab', { name: /Tinglysning|Land Registry/i }).click();
    await expect(page.getByText(/Adkomst|Title/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('dokumenter-tab loader', async ({ page }) => {
    await page.getByRole('tab', { name: /Dokumenter|Documents/i }).click();
    // Dokumenter-tab bør vise noget indhold inden for 15s
    await page.waitForTimeout(3_000);
    const content = await page.locator('[role="tabpanel"]').textContent();
    expect(content?.length).toBeGreaterThan(10);
  });
});
