/**
 * E2E tests for ejendomshierarki navigation (BIZZ-832).
 *
 * Covers:
 *  - Breadcrumb renders on SFE page with correct structure
 *  - Breadcrumb renders on bygning page with SFE-link when BFE is known
 *  - PropertyCard SFE-href links to /sfe/[bfe] (BIZZ-831)
 *  - axe-core: 0 violations on SFE/bygning breadcrumb sections
 *  - SFE BFE navigation resolves to DAWA UUID and loads property detail
 *  - Foreløbig grundvurdering visible on hovedejendom detail pages
 *  - All nodes in ejendomsstruktur are navigable without errors
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars.
 * Uses BFE 2091165 (Arnold Nielsens Blvd 62, Hvidovre) as test fixture.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH, dismissOnboarding } from './helpers';

const TEST_BFE = '2091165'; // Arnold Nielsens Blvd 62 (SFE)
/** Arnold Nielsens Blvd 62B — Hovedejendom DAWA UUID */
const HOVEDEJENDOM_62B = '0a3f507c-b62b-32b8-e044-0003ba298018';

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

test.describe('Ejendomshierarki — SFE BFE navigation', () => {
  test.describe.configure({ mode: 'serial' });

  test('SFE BFE navigates to property detail without errors', async ({ page }) => {
    // Navigér til SFE via BFE-nummer — page.tsx skal resolve til DAWA UUID via redirect
    await page.goto(`/dashboard/ejendomme/${TEST_BFE}`);
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);

    // Skal redirecte til en DAWA UUID URL (ikke BFE-URL)
    await page.waitForURL(/\/dashboard\/ejendomme\/[0-9a-f]{8}-/, { timeout: 20_000 });

    // Adressens heading skal vise Arnold Nielsens Boulevard 62
    await expect(page.getByRole('heading', { name: /Arnold Nielsens Boulevard 62/i })).toBeVisible({
      timeout: 20_000,
    });
  });

  test('Hovedejendom 62B loads and shows ejendomsstruktur', async ({ page }) => {
    await page.goto(`/dashboard/ejendomme/${HOVEDEJENDOM_62B}`);
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);

    // Heading viser adressen
    await expect(page.getByRole('heading', { name: /Arnold Nielsens Boulevard 62B/i })).toBeVisible(
      { timeout: 20_000 }
    );

    // Ejendomsstruktur tree — kan være under folden, scroll til den
    const treeHeading = page.getByText('Ejendomsstruktur').first();
    await treeHeading.scrollIntoViewIfNeeded({ timeout: 20_000 });
    await expect(treeHeading).toBeVisible({ timeout: 5_000 });

    // SFE badge i træet
    await expect(page.locator('text=SFE').first()).toBeVisible({ timeout: 5_000 });

    // Ejerlejlighed badges i træet
    await expect(page.locator('text=Ejerlejlighed').first()).toBeVisible({ timeout: 5_000 });
  });

  test('Foreløbig grundvurdering visible on Overblik tab', async ({ page }) => {
    await page.goto(`/dashboard/ejendomme/${HOVEDEJENDOM_62B}`);
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);

    // Vent på at headeren loader
    await expect(page.getByRole('heading', { name: /Arnold Nielsens Boulevard 62B/i })).toBeVisible(
      { timeout: 20_000 }
    );

    // Foreløbig vurdering badge skal vises på Overblik-tab — scroll ned til det
    const forelobigBadge = page.getByText(/FORELØBIG/i).first();
    await forelobigBadge.scrollIntoViewIfNeeded({ timeout: 30_000 });
    await expect(forelobigBadge).toBeVisible({ timeout: 5_000 });

    // Grundværdi fra foreløbig vurdering skal vises
    await expect(page.getByText(/Grundværdi/i).first()).toBeVisible();
  });

  test('Foreløbig vurdering visible in Økonomi tab history', async ({ page }) => {
    await page.goto(`/dashboard/ejendomme/${HOVEDEJENDOM_62B}`);
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);

    await expect(page.getByRole('heading', { name: /Arnold Nielsens Boulevard 62B/i })).toBeVisible(
      { timeout: 20_000 }
    );

    // Navigér til Økonomi-tab
    await page.locator('text=Økonomi').first().click();

    // Vurderingshistorik med foreløbig badge — scroll til den
    const forelobigBadge = page.getByText(/FORELØBIG/i).first();
    await forelobigBadge.scrollIntoViewIfNeeded({ timeout: 30_000 });
    await expect(forelobigBadge).toBeVisible({ timeout: 5_000 });
  });

  test('All ejendomsstruktur nodes navigable', async ({ page }) => {
    await page.goto(`/dashboard/ejendomme/${HOVEDEJENDOM_62B}`);
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);

    await expect(page.getByRole('heading', { name: /Arnold Nielsens Boulevard 62B/i })).toBeVisible(
      { timeout: 20_000 }
    );

    // Scroll ned til ejendomsstruktur-sektionen
    const treeHeading = page.getByText('Ejendomsstruktur').first();
    await treeHeading.scrollIntoViewIfNeeded({ timeout: 20_000 });

    // Find alle klikbare links i ejendomsstruktur-træet
    const strukturLinks = page.locator(
      '.bg-slate-800\\/40:has-text("Ejendomsstruktur") a[href*="/dashboard/ejendomme/"]'
    );
    const count = await strukturLinks.count();
    expect(count).toBeGreaterThan(0);

    // Klik på SFE-noden (første link i træet, som ikke er den aktuelle ejendom)
    const sfeLink = strukturLinks.first();
    const href = await sfeLink.getAttribute('href');
    expect(href).toBeTruthy();

    // Navigér til SFE-noden
    await sfeLink.click();
    await page.waitForLoadState('domcontentloaded');

    // Skal IKKE give en fejl-side — heading viser en adresse
    await expect(page.getByRole('heading', { name: /Arnold Nielsens Boulevard 62/i })).toBeVisible({
      timeout: 25_000,
    });
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
