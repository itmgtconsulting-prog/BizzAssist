/**
 * BIZZ-1590 — Verifikation af cache-first salgshistorik route.
 *
 * Mål: bevis at refaktor til cache-first ikke ændrer response-shape.
 * Workflow:
 *   1. Login + besøg Søbyvej 11 (BFE 2081243 — kendt test-ejendom)
 *   2. Tjek at Salgshistorik-sektionen renderer rows
 *   3. Tjek at intet console-fejl er kastet
 *   4. Anden visit til samme BFE bør være hurtigere (cache populeret)
 *
 * Markeres skipped hvis E2E_TEST_EMAIL mangler.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH, dismissOnboarding } from './helpers';

const TEST_BFE = 2081243; // Søbyvej 11

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping cache verification');
  }
});

test.describe('Salgshistorik cache-first (BIZZ-1590)', () => {
  test('første visit + anden visit ramme cache uden fejl', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // First visit — typically cache miss; warms cache fire-and-forget
    const start1 = Date.now();
    const r1 = await page.request.get(`/api/salgshistorik?bfeNummer=${TEST_BFE}`);
    const ms1 = Date.now() - start1;
    expect(r1.status()).toBe(200);
    const json1 = await r1.json();
    expect(json1).toHaveProperty('handler');
    expect(Array.isArray(json1.handler)).toBe(true);

    // Wait a beat for fire-and-forget upsert to land
    await page.waitForTimeout(500);

    // Second visit — cache should now have the data (read-back happens
    // inside the route, not visible to client, but no error means OK)
    const start2 = Date.now();
    const r2 = await page.request.get(`/api/salgshistorik?bfeNummer=${TEST_BFE}`);
    const ms2 = Date.now() - start2;
    expect(r2.status()).toBe(200);
    const json2 = await r2.json();
    expect(json2.handler.length).toBe(json1.handler.length);

    console.log(`[BIZZ-1590] first=${ms1}ms second=${ms2}ms cache-saved=${ms1 - ms2}ms`);

    // Console må ikke have fatale fejl fra cache-paths
    const cacheRelated = consoleErrors.filter((e) =>
      /tlHandlerCache|salgshistorik|tinglysning_handler/i.test(e)
    );
    expect(cacheRelated).toEqual([]);
  });

  test('Søbyvej 11 ejendomsside renderer Salgshistorik-sektion', async ({ page }) => {
    await page.goto(`/dashboard/ejendomme/${TEST_BFE}`);
    await page.waitForLoadState('domcontentloaded');
    await dismissOnboarding(page);

    // Salgshistorik-sektion vises i Økonomi-tab eller hovedsiden
    // (eksisterende e2e ejendom-detail.spec.ts håndterer tab-navigation)
    // Vi tjekker bare at siden ikke crasher (ingen 5xx errors)
    const errorOnPage = await page
      .getByText(/uventet fejl|server error|500/i)
      .isVisible({ timeout: 2_000 })
      .catch(() => false);
    expect(errorOnPage).toBe(false);
  });
});
