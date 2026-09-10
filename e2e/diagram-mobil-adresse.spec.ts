/**
 * E2E regression — mobil tap-for-detalje på ejendoms-noder (BIZZ-2270).
 *
 * På 375px var ejendoms-adresserne på ejerskabsdiagrammet ulæselige ved
 * fit-zoom (SVG-tekst ~5px). Fix: tap på en ejendoms-node åbner en læsbar
 * detalje-popover med den fulde adresse + BFE + en "Åbn"-knap. Denne test
 * kører i chromium-mobile-projektet (375px) og bekræfter at popoveren vises.
 *
 * Fixture: Jacob Bøg Holding ApS (CVR 40249206) på test — har en ejendoms-node
 * (fra bug-rapporten). Auth via delt storageState; skippes uden E2E_TEST_EMAIL.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping mobil-diagram test');
  }
});

test.describe('Mobil ejendoms-adresse tap-for-detalje (BIZZ-2270)', () => {
  test('tap på ejendoms-node viser læsbar adresse-popover på 375px', async ({ page }) => {
    test.setTimeout(90_000);

    await page.goto('/dashboard/companies/40249206');
    await page.waitForLoadState('networkidle');

    // Åbn Diagram-fanen (tab eller knap).
    const diagramTab = page
      .getByRole('tab', { name: 'Diagram' })
      .or(page.getByRole('button', { name: 'Diagram' }))
      .first();
    await diagramTab.click();

    // Vent på at force-simulationen er konvergeret og ejendoms-noden er renderet.
    const propertyNode = page.locator('[data-node-type="property"]').first();
    await expect(propertyNode).toBeVisible({ timeout: 45_000 });

    // Tap → læsbar detalje-popover.
    await propertyNode.click({ force: true });

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    // Popoveren skal have en "Åbn ejendom"-knap (bevarer den oprindelige handling).
    await expect(dialog.getByRole('button', { name: /Åbn ejendom/ })).toBeVisible();

    await page.screenshot({ path: '.playwright/2270-mobil-adresse-popover.png' });
  });
});
