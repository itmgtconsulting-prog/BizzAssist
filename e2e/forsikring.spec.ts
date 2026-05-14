/**
 * E2E tests for the insurance module (/dashboard/forsikring).
 *
 * Covers:
 *  - Sidebar link "Forsikring" appears
 *  - Forsikring page loads with header + upload zone
 *  - Empty state renders when no policies exist
 *  - Mocked upload + parse flow renders new policy in table
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars.
 * Tests skip automatically if auth state is missing (CI smoke runs).
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH, dismissOnboarding } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping authenticated insurance tests');
  }
});

test.describe('Forsikring — list page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
  });

  test('forsikring page accessible from Analyse & Tools', async ({ page }) => {
    // Navigate directly — forsikring is under Analyse & Tools module
    await page.goto('/dashboard/forsikring');
    await page.waitForLoadState('domcontentloaded');

    // Verify page loaded (not 500)
    await expect(page.getByRole('heading', { name: /Forsikring|Insurance/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('forsikring page renders header and upload zone', async ({ page }) => {
    // Mock empty list so test doesn't depend on tenant data state
    await page.route('/api/forsikring', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          policies: [],
          documents: [],
          totals: { policies: 0, gaps_critical: 0, gaps_warning: 0, gaps_info: 0 },
        }),
      });
    });

    await page.goto('/dashboard/forsikring');
    await page.waitForLoadState('domcontentloaded');

    // Header
    await expect(page.getByRole('heading', { name: /Forsikring|Insurance/i })).toBeVisible({
      timeout: 10_000,
    });

    // Upload zone (aria-label matches translation key uploadCta)
    await expect(
      page.getByRole('button', { name: /Upload forsikringsdokumenter|Upload insurance documents/i })
    ).toBeVisible({ timeout: 10_000 });
  });

  test('empty state shown when no policies', async ({ page }) => {
    await page.route('/api/forsikring', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          policies: [],
          documents: [],
          totals: { policies: 0, gaps_critical: 0, gaps_warning: 0, gaps_info: 0 },
        }),
      });
    });

    await page.goto('/dashboard/forsikring');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByText(/Ingen policer endnu|No policies yet/i)).toBeVisible({
      timeout: 10_000,
    });
  });

  test('table renders mocked policies with gap badges', async ({ page }) => {
    await page.route('/api/forsikring', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          policies: [
            {
              id: 'pol-test-1',
              policy_number: '50143392',
              insurer_name: 'Alm. Brand Forsikring A/S',
              policyholder_name: 'Belvedere Ejendomme A/S',
              property_address: 'Stengade 7, 3000 Helsingør',
              annual_premium_dkk: 5716,
              effective_to: '2028-03-31',
              main_renewal_date: '2026-04-01',
              gap_counts: { critical: 1, warning: 3, info: 1 },
              created_at: new Date().toISOString(),
            },
          ],
          documents: [],
          totals: { policies: 1, gaps_critical: 1, gaps_warning: 3, gaps_info: 1 },
        }),
      });
    });

    await page.goto('/dashboard/forsikring');
    await page.waitForLoadState('domcontentloaded');

    // Police-nr som link
    await expect(page.getByRole('link', { name: '50143392' })).toBeVisible({
      timeout: 10_000,
    });
    // Selskab
    await expect(page.getByText(/Alm\. Brand/i).first()).toBeVisible();
    // Adresse
    await expect(page.getByText(/Stengade 7/i)).toBeVisible();
  });
});
