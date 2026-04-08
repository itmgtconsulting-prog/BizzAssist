/**
 * E2E tests for the authenticated dashboard.
 *
 * Covers:
 *  - Dashboard loads with search bar after login
 *  - Property search returns autocomplete results
 *  - Company detail page renders
 *  - Sidebar navigation links are present
 *  - Map page loads
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars.
 * Tests are skipped automatically if auth state is missing (no credentials).
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH, dismissOnboarding } from './helpers';

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
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
  });

  /** Dashboard renders without crashing */
  test('dashboard loads with search input', async ({ page }) => {
    // Actual placeholder: 'Søg adresse, CVR, virksomhed…'
    const searchInput = page
      .getByPlaceholder(/Søg adresse|Søg.*CVR|Search address/i)
      .or(page.getByRole('searchbox'))
      .first();
    await expect(searchInput).toBeVisible({ timeout: 15_000 });
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
  // The main dashboard search bar navigates to /dashboard/ejendomme for property search.
  // Tests target the ejendomme (property) search page directly for reliability.

  test('property search page loads with autocomplete input', async ({ page }) => {
    await page.goto('/dashboard/ejendomme');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);

    // The ejendomme search box has a specific placeholder (from translations.ts: searchPlaceholder)
    const searchInput = page
      .getByPlaceholder(/adresse.*vejnavn|vejnavn.*postnummer|postnummer/i)
      .first();
    await expect(searchInput).toBeVisible({ timeout: 15_000 });
  });

  test('typing an address shows autocomplete suggestions', async ({ page }) => {
    await page.goto('/dashboard/ejendomme');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);

    // Target the ejendomme-specific search (not the top nav bar)
    const searchInput = page
      .getByPlaceholder(/adresse.*vejnavn|vejnavn.*postnummer|postnummer/i)
      .first();
    await expect(searchInput).toBeVisible({ timeout: 15_000 });
    await searchInput.fill('Vesterbrogade 1');

    // Autocomplete results are <button> elements rendered in a portal
    const firstResult = page
      .locator('button')
      .filter({ hasText: /Vesterbrogade/i })
      .first();
    await expect(firstResult).toBeVisible({ timeout: 12_000 });
  });

  test('clicking autocomplete result navigates to property detail', async ({ page }) => {
    await page.goto('/dashboard/ejendomme');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);

    const searchInput = page
      .getByPlaceholder(/adresse.*vejnavn|vejnavn.*postnummer|postnummer/i)
      .first();
    await expect(searchInput).toBeVisible({ timeout: 15_000 });
    await searchInput.fill('Vesterbrogade 1');

    // Click the first autocomplete result button
    const firstResult = page
      .locator('button')
      .filter({ hasText: /Vesterbrogade/i })
      .first();
    await expect(firstResult).toBeVisible({ timeout: 12_000 });
    await firstResult.click();

    // Should navigate to property detail page
    await expect(page).toHaveURL(/\/dashboard\/ejendomme\//, { timeout: 20_000 });
  });
});

test.describe('Dashboard — company search', () => {
  test('navigating to companies section shows search', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);

    // Click the Virksomheder (Companies) sidebar link
    await page
      .getByRole('link', { name: /Virksomheder/i })
      .first()
      .click();
    await page.waitForLoadState('domcontentloaded');

    // Companies page should render — look for any search input or heading
    await expect(
      page
        .getByPlaceholder(/CVR|Søg.*virksomhed|company/i)
        .or(page.getByRole('heading', { name: /Virksomheder|Companies/i }))
        .first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test('company detail page renders for known CVR', async ({ page }) => {
    // Novo Nordisk A/S — publicly known CVR
    await page.goto('/dashboard/companies/44788711');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);

    // Wait for the main content area — page renders even while data loads
    await expect(page.locator('#main-content, main').first()).toBeVisible({ timeout: 15_000 });
    // The CVR number or company name should appear in the page heading/content area
    await expect(
      page
        .locator('#main-content')
        .getByText(/44788711|Novo|virksomhed/i)
        .first()
    ).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('Dashboard — map page', () => {
  test('map page loads without critical errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/dashboard/kort');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);

    // Map container should render
    const mapContainer = page.locator('.mapboxgl-map, [data-testid="map"]').first();
    await expect(mapContainer).toBeVisible({ timeout: 20_000 });

    // Filter out known non-critical errors:
    // - Supabase CSP violations (Supabase URL needs adding to connect-src — tracked separately)
    // - Mapbox GL warnings
    // - Service worker / favicon / 401 noise
    const realErrors = errors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('manifest') &&
        !e.includes('401') &&
        !e.includes('Mapbox') &&
        !e.includes('supabase.co') &&
        !e.includes('Content Security Policy') &&
        !e.includes('Failed to fetch')
    );
    expect(realErrors).toHaveLength(0);
  });
});
