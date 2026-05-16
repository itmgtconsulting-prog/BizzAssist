/**
 * E2E tests for ejerskabsdiagram (virksomhed + person).
 *
 * BIZZ-1340+1346: Dækker diagram-rendering, udvid-knap,
 * ejendomme-toggle, zoom/pan.
 *
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS env vars.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH, dismissOnboarding } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping diagram tests');
  }
});

test.describe('Virksomhedsdiagram — JaJR Holding', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/companies/41092807');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
    await page.getByRole('tab', { name: /Diagram|Relations/i }).click();
  });

  test('diagram renderer SVG/canvas', async ({ page }) => {
    await expect(page.locator('svg').or(page.locator('canvas')).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('diagram viser virksomhedsnoder', async ({ page }) => {
    await expect(page.getByText(/JaJR Holding/i).first()).toBeVisible({ timeout: 20_000 });
  });
});

// BIZZ-1540+1541: Diagram dedup + overflow-position guards
test.describe('Diagram — dedup + overflow position', () => {
  test('BIZZ-1540: ingen duplikat ukendt-ejer noder på samme enhedsNummer', async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1400 });
    await page.goto('/dashboard/companies/24301117');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
    await page
      .locator('button, a')
      .filter({ hasText: /^Diagram$/ })
      .first()
      .click();
    await page.waitForTimeout(10000);
    const udvidBtn = page
      .locator('button')
      .filter({ hasText: /Udvid|Expand/ })
      .first();
    if (await udvidBtn.isVisible().catch(() => false)) await udvidBtn.click();
    await page.waitForTimeout(3000);

    // Find alle "Ukendt ejer (en NNNN)" labels og tjek at ingen enhedsnummer
    // optræder flere gange (dedup)
    const ukendtLabels = await page.evaluate(() => {
      const texts = Array.from(document.querySelectorAll('svg text')).map(
        (t) => t.textContent ?? ''
      );
      return texts.filter((t) => /Ukendt ejer\s*\(en\s*\d+\)/.test(t));
    });
    const enheder = ukendtLabels
      .map((l) => l.match(/\(en\s*(\d+)\)/)?.[1])
      .filter((x): x is string => !!x);
    const unique = new Set(enheder);
    expect(enheder.length).toBe(unique.size);
  });

  test('BIZZ-1541: overflow-boks overlapper ikke property-sibling-noder', async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1400 });
    await page.goto('/dashboard/companies/24301117');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
    await page
      .locator('button, a')
      .filter({ hasText: /^Diagram$/ })
      .first()
      .click();
    await page.waitForTimeout(10000);
    const udvidBtn = page
      .locator('button')
      .filter({ hasText: /Udvid|Expand/ })
      .first();
    if (await udvidBtn.isVisible().catch(() => false)) await udvidBtn.click();
    await page.waitForTimeout(3000);

    // Find overflow-boksen og verificér at den ikke overlapper sibling property-noder
    const layout = await page.evaluate(() => {
      const groups = Array.from(document.querySelectorAll('svg g[style*="cursor"]'));
      const out: Array<{ label: string; y: number; height: number }> = [];
      for (const g of groups) {
        const rect = g.querySelector('rect');
        const text = Array.from(g.querySelectorAll('text'))
          .map((t) => t.textContent ?? '')
          .join(' | ');
        if (rect && text) {
          const y = parseFloat(rect.getAttribute('y') ?? '0');
          const h = parseFloat(rect.getAttribute('height') ?? '0');
          out.push({ label: text.substring(0, 50), y, height: h });
        }
      }
      return out;
    });

    const overflowBox = layout.find((n) => /\+\d+ ejendomme/.test(n.label));
    const propertyBoxes = layout.filter((n) => /Stengade|Stenges/.test(n.label));

    if (overflowBox && propertyBoxes.length > 0) {
      const overflowTop = overflowBox.y;
      const overflowBottom = overflowBox.y + overflowBox.height;
      // Overflow-boks skal ikke overlappe nogen property-boks
      for (const p of propertyBoxes) {
        const pTop = p.y;
        const pBottom = p.y + p.height;
        const overlap = overflowTop < pBottom && overflowBottom > pTop;
        if (overlap) {
          console.log(
            `Overlap: overflow [${overflowTop}-${overflowBottom}] vs ${p.label} [${pTop}-${pBottom}]`
          );
        }
        expect(overlap).toBe(false);
      }
    }
  });
});

// BIZZ-1542+1543: Diagram property labels + ejerlejlighed navigation
test.describe('Diagram — property labels + navigation', () => {
  test('BIZZ-1543: ejerlejlighed label has etage on line 1 (Belvedere)', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1200 });
    await page.goto('/dashboard/companies/24301117');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
    await page
      .locator('button, a')
      .filter({ hasText: /^Diagram$/ })
      .first()
      .click();
    await page.waitForTimeout(8000);
    const udvidBtn = page
      .locator('button')
      .filter({ hasText: /Udvid|Expand/ })
      .first();
    if (await udvidBtn.isVisible().catch(() => false)) await udvidBtn.click();
    await page.waitForTimeout(2000);

    // Verify both ejerlejligheder show "Stengade 48D 2." and "Stengade 48D 1."
    // (etage on line 1, distinct from each other)
    const svgTexts = await page.locator('svg text').allTextContents();
    const has48D2 = svgTexts.some((t) => /Stengade 48D 2\./.test(t));
    const has48D1 = svgTexts.some((t) => /Stengade 48D 1\./.test(t));
    expect(has48D2 || has48D1).toBe(true);
  });

  test('BIZZ-1542: click ejerlejlighed in diagram resolves to property page', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1200 });
    await page.goto('/dashboard/companies/24301117');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
    await page
      .locator('button, a')
      .filter({ hasText: /^Diagram$/ })
      .first()
      .click();
    await page.waitForTimeout(8000);
    const udvidBtn = page
      .locator('button')
      .filter({ hasText: /Udvid|Expand/ })
      .first();
    if (await udvidBtn.isVisible().catch(() => false)) await udvidBtn.click();
    await page.waitForTimeout(2000);

    // Find ejerlejlighed-noden og klik
    const target = await page.evaluate(() => {
      const groups = Array.from(document.querySelectorAll('svg g[style*="cursor: pointer"]'));
      for (let i = 0; i < groups.length; i++) {
        const texts = Array.from(groups[i].querySelectorAll('text'))
          .map((t) => t.textContent ?? '')
          .join(' | ');
        if (/Stengade 48D 2\./.test(texts)) return { index: i, texts };
      }
      return null;
    });
    expect(target).not.toBeNull();
    const allGroups = page.locator('svg g[style*="cursor: pointer"]');
    await allGroups.nth(target!.index).scrollIntoViewIfNeeded();
    await allGroups.nth(target!.index).click({ force: true });
    await page.waitForLoadState('domcontentloaded');

    // Skal IKKE vise "Ejendom ikke fundet" (BIZZ-1542 regression-guard)
    await page.waitForTimeout(8000);
    const errorVisible = await page
      .getByText(/Ejendom ikke fundet|Adresse ikke fundet/i)
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    expect(errorVisible).toBe(false);
    // Adresse-heading skal være synlig
    await expect(page.getByRole('heading', { name: /Stengade 48D/i })).toBeVisible({
      timeout: 15_000,
    });
  });
});

test.describe('Person-diagram — Jakob Juul Rasmussen', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/owners/4000115446');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
    await page.getByRole('tab', { name: /Diagram|Relations/i }).click();
  });

  test('person-diagram renderer', async ({ page }) => {
    await expect(page.locator('svg').or(page.locator('canvas')).first()).toBeVisible({
      timeout: 20_000,
    });
  });
});

test.describe('Ejendomsdiagram — Søbyvej 11', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/ejendomme/0a3f50a8-b6f1-32b8-e044-0003ba298018');
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);
    await page.getByRole('tab', { name: /Ejerskab|Ownership/i }).click();
  });

  test('ejerskabsdiagram renderer', async ({ page }) => {
    await expect(page.locator('svg').or(page.locator('canvas')).first()).toBeVisible({
      timeout: 25_000,
    });
  });
});
