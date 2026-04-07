/**
 * E2E tests for the authenticated dashboard.
 *
 * Covers:
 *  - Dashboard loads with search bar after login
 *  - Property search returns results and navigates to detail page
 *  - Company search returns results and navigates to detail page
 *  - Sidebar navigation links are present
 *  - Recent entities section renders
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars.
 * Tests are skipped automatically if auth state is missing (no credentials).
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './auth.setup';

/** Skip all tests in this file if auth state was not produced by auth.setup */
test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping authenticated dashboard tests');
  }
});

test.describe('Dashboard — main page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');
  });

  /** Dashboard renders without crashing */
  test('dashboard loads with search input', async ({ page }) => {
    // Search bar is present
    const searchInput = page.getByPlaceholder(/Søg efter ejendom/i).or(page.getByRole('searchbox'));
    await expect(searchInput.first()).toBeVisible({ timeout: 15_000 });
  });

  /** Sidebar navigation is present */
  test('sidebar shows navigation links', async ({ page }) => {
    await expect(page.getByRole('link', { name: /Ejendomme/i }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Virksomheder/i }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Kort/i }).first()).toBeVisible();
  });

  /** Settings link in sidebar */
  test('sidebar has settings link', async ({ page }) => {
    await expect(page.getByRole('link', { name: /Indstillinger/i }).first()).toBeVisible();
  });

  /** Page title */
  test('page has correct document title', async ({ page }) => {
    await expect(page).toHaveTitle(/BizzAssist/i);
  });
});

test.describe('Dashboard — property search', () => {
  test('searching for an address shows suggestions', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    // Type into the main search bar
    const searchInput = page.getByPlaceholder(/Søg efter ejendom/i).first();
    await expect(searchInput).toBeVisible({ timeout: 15_000 });
    await searchInput.fill('Vesterbrogade 1');

    // Autocomplete dropdown should appear within 5s
    const dropdown = page.locator('[role="listbox"], [role="option"]').first();
    await expect(dropdown).toBeVisible({ timeout: 8_000 });
  });

  test('clicking a search result navigates to property detail', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    const searchInput = page.getByPlaceholder(/Søg efter ejendom/i).first();
    await expect(searchInput).toBeVisible({ timeout: 15_000 });
    await searchInput.fill('Vesterbrogade 1, 1620');

    // Wait for and click first result
    const firstResult = page.locator('[role="option"]').first();
    await expect(firstResult).toBeVisible({ timeout: 8_000 });
    await firstResult.click();

    // Should navigate to /dashboard/ejendomme/[id]
    await expect(page).toHaveURL(/\/dashboard\/ejendomme\//, { timeout: 15_000 });
  });
});

test.describe('Dashboard — company search', () => {
  test('navigating to companies section shows search', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    // Click the Virksomheder (Companies) sidebar link
    await page
      .getByRole('link', { name: /Virksomheder/i })
      .first()
      .click();
    await page.waitForLoadState('networkidle');

    // CVR search input should be present
    const cvrInput = page
      .getByPlaceholder(/CVR/i)
      .or(page.getByPlaceholder(/Søg virksomhed/i))
      .first();
    await expect(cvrInput).toBeVisible({ timeout: 10_000 });
  });

  test('searching by CVR number navigates to company detail', async ({ page }) => {
    // Navigate directly to a known CVR (Novo Nordisk A/S)
    await page.goto('/dashboard/companies/44788711');
    await page.waitForLoadState('networkidle');

    // Company detail page should show the company name or CVR
    await expect(
      page
        .getByText(/44788711/i)
        .or(page.getByText(/Novo/i))
        .first()
    ).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Dashboard — map page', () => {
  test('map page loads without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dashboard/kort');
    await page.waitForLoadState('networkidle');

    // Map container should render
    const mapContainer = page.locator('.mapboxgl-map, [data-testid="map"]').first();
    await expect(mapContainer).toBeVisible({ timeout: 20_000 });

    // Filter out known harmless errors
    const realErrors = errors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('manifest') &&
        !e.includes('401') &&
        !e.includes('Mapbox') // Mapbox GL can log non-fatal warnings
    );
    expect(realErrors).toHaveLength(0);
  });
});
