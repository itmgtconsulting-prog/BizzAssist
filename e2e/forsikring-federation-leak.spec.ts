/**
 * BIZZ-2192.6: Isolations-regressionstest for domæne-federationen (ADR-0011).
 *
 * Efter at forsikrings-analyse-læsestier blev federeret (egen tenant ∪ co-domæne-
 * medlemmers tenants, 2192.2/2b/2c) er cross-tenant LÆSNING app-gated frem for
 * fysisk umulig. Denne test er isolations-guarden: den fanger hvis en fremtidig
 * ændring enten (a) lækker en analyse fra et tenant der IKKE er i brugerens
 * federation, eller (b) holder op med at dele co-domæne-medlemmers analyser.
 *
 * Kører som authenticated bruger jjrchefen@gmail.com, hvis federation i test er
 * [tenant_jjrchefen_gmail_com, tenant_jakob_test]. Fixtures er test-miljø-
 * specifikke (som andre parity-regressionsspecs).
 *
 * Verificeret manuelt mod test.bizzassist.dk 2026-09-05: federeret analyse -> 200,
 * ikke-federeret analyse -> 404.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

// Test-miljø-fixtures (jjrchefens federation = jjrchefen + jakob_test).
const JAKOB_TEST_TENANT_ID = '77ecf1fb-33a7-4372-9c7d-9ebe0b76169a';
// En analyse der ligger i tenant_slj_rtm_dk — IKKE i jjrchefens federation.
const NON_FEDERATED_ANALYSE_ID = 'f864fbe3-6cbf-4823-b627-7a2014cd2d80';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'Ingen E2E_TEST_EMAIL — springer federations-isolationstest over');
  }
});

test.describe('Forsikring — domæne-federation isolation (ADR-0011)', () => {
  test('co-domæne: analyse-listen indeholder co-medlems analyser', async ({ page }) => {
    const res = await page.request.get('/api/forsikring/analyser');
    expect(res.status()).toBe(200);
    const data = (await res.json()) as { analyser?: Array<{ tenant_id: string }> };
    const analyser = data.analyser ?? [];
    expect(analyser.length).toBeGreaterThan(0);
    // Federationen er aktiv: listen skal inkludere co-medlemmets (jakob_test) analyser.
    const tenantIds = new Set(analyser.map((a) => a.tenant_id));
    expect(
      tenantIds.has(JAKOB_TEST_TENANT_ID),
      `Forventede co-medlems tenant ${JAKOB_TEST_TENANT_ID} i federeret liste (fundne: ${[...tenantIds].join(', ')})`
    ).toBe(true);
  });

  test('LÆK-GUARD: analyse uden for federationen kan IKKE hentes (404)', async ({ page }) => {
    const res = await page.request.get(`/api/forsikring/analyser/${NON_FEDERATED_ANALYSE_ID}`);
    // Må ALDRIG være 200 — analysen ligger i et tenant der ikke er i brugerens
    // domæne-federation. 404 = korrekt isolation.
    expect(
      res.status(),
      `Cross-tenant læk! Analyse ${NON_FEDERATED_ANALYSE_ID} (ikke-federeret) returnerede ${res.status()} i stedet for 404`
    ).toBe(404);
  });
});
