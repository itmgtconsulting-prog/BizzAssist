/**
 * E2E tests for søgning.
 *
 * BIZZ-1341: Dækker adresse-, CVR-, person-søgning, filtre
 * og navigation til detaljeside.
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH, dismissOnboarding } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping search tests');
  }
});

test.describe('Sidebar-søgning', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
  });

  test('adresse-søgning viser autocomplete', async ({ page }) => {
    const search = page.getByPlaceholder(/Søg adresse|Search/i).first();
    await search.fill('Søbyvej 11');
    // Vent på dropdown med resultater
    await expect(page.getByText(/Søbyvej 11/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test('virksomheds-søgning viser CVR-resultater', async ({ page }) => {
    const search = page.getByPlaceholder(/Søg adresse|Search/i).first();
    await search.fill('JaJR Holding');
    await expect(page.getByText(/41092807|JaJR/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test('person-søgning viser resultater', async ({ page }) => {
    const search = page.getByPlaceholder(/Søg adresse|Search/i).first();
    await search.fill('Jakob Juul');
    await expect(page.getByText(/Jakob Juul/i).first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Ejendomme-søgning', () => {
  test('autocomplete returnerer relevante adresser', async ({ page }) => {
    await page.goto('/dashboard/ejendomme');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
    const search = page.getByPlaceholder(/Søg|Search/i).first();
    await search.fill('Arnold Nielsens Boulevard 62');
    await expect(page.getByText(/Arnold Nielsens Boulevard 62/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
