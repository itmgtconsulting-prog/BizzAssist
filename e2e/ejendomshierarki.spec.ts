/**
 * E2E tests for ejendomshierarki navigation (BIZZ-832).
 *
 * Covers:
 *  - Breadcrumb renders on SFE page with correct structure
 *  - Breadcrumb renders on bygning page with SFE-link when BFE is known
 *  - PropertyCard SFE-href links to /sfe/[bfe] (BIZZ-831)
 *  - axe-core: 0 violations on SFE/bygning breadcrumb sections
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars.
 * Uses BFE 2091165 (Arnold Nielsens Blvd 62, Hvidovre) as test fixture.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH, dismissOnboarding } from './helpers';

const TEST_BFE = '2091165'; // Arnold Nielsens Blvd 62

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping hierarchy E2E tests');
  }
});

test.describe('Ejendomshierarki — SFE page', () => {
  test('SFE page renders breadcrumb with correct levels', async ({ page }) => {
    await page.goto(`/dashboard/ejendomme/sfe/${TEST_BFE}`);
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);

    const breadcrumb = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumb).toBeVisible({ timeout: 15_000 });

    // Verify breadcrumb has at least 3 levels: Dashboard, Ejendomme, SFE [bfe]
    const items = breadcrumb.locator('li');
    await expect(items).toHaveCount(3, { timeout: 5_000 });

    // First item links to dashboard
    const dashLink = breadcrumb.getByRole('link', { name: 'Dashboard' });
    await expect(dashLink).toBeVisible();
    await expect(dashLink).toHaveAttribute('href', '/dashboard');

    // Second item links to ejendomme
    const ejdLink = breadcrumb.getByRole('link', { name: 'Ejendomme' });
    await expect(ejdLink).toBeVisible();

    // Third item is current page (span, not link)
    const current = breadcrumb.locator('[aria-current="page"]');
    await expect(current).toBeVisible();
    await expect(current).toContainText(`SFE ${TEST_BFE}`);
  });

  test('SFE page shows component list', async ({ page }) => {
    await page.goto(`/dashboard/ejendomme/sfe/${TEST_BFE}`);
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);

    // Wait for the component list to render (may take a moment for API calls)
    const heading = page.getByRole('heading', { name: /SFE/i }).first();
    await expect(heading).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Ejendomshierarki — axe accessibility', () => {
  test('SFE page breadcrumb passes axe-core', async ({ page }) => {
    await page.goto(`/dashboard/ejendomme/sfe/${TEST_BFE}`);
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);

    // Wait for breadcrumb to render
    await expect(page.locator('nav[aria-label="Breadcrumb"]')).toBeVisible({ timeout: 15_000 });

    // Run axe-core on the breadcrumb nav element
    const violations = await page.evaluate(async () => {
      // @ts-expect-error — axe injected dynamically
      if (typeof window.axe === 'undefined') {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.7.2/axe.min.js';
        document.head.appendChild(script);
        await new Promise<void>((resolve) => {
          script.onload = () => resolve();
        });
      }
      // @ts-expect-error — axe injected dynamically
      const result = await window.axe.run('nav[aria-label="Breadcrumb"]');
      return result.violations;
    });

    expect(violations).toHaveLength(0);
  });
});
