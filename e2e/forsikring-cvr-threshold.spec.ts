/**
 * Verifikation af CVR-fallback threshold fix.
 *
 * Sikrer at CVR-alene-match (score 45) IKKE tæller som forsikret.
 * Belvedere har 17 ejendomme men kun ~8 med reel adresse-match.
 * Før fix: 17/17 forsikret (CVR-fallback score 55 > threshold 50).
 * Efter fix: ~8/17 forsikret (CVR-fallback score 45 < threshold 50).
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

const BELVEDERE_CVR = '24301117';
const BELVEDERE_NAVN = 'BELVEDERE EJENDOMME A/S';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping CVR threshold test');
  }
});

test.describe('CVR-fallback threshold fix', () => {
  test('insured_count < total_aktiver for Belvedere (CVR-only skal IKKE tælle)', async ({
    page,
  }) => {
    const res = await page.request.post('/api/forsikring/analyser', {
      data: {
        kunde_type: 'virksomhed',
        kunde_id: BELVEDERE_CVR,
        kunde_navn: BELVEDERE_NAVN,
      },
    });
    expect(res.status()).toBe(200);
    const data = (await res.json()) as {
      total_aktiver?: number;
      insured_count?: number;
    };

    console.log(`[CVR-threshold] total=${data.total_aktiver}, insured=${data.insured_count}`);

    // Belvedere har 17 aktiver — insured skal IKKE være 17
    expect(data.total_aktiver).toBeGreaterThanOrEqual(17);
    expect(data.insured_count).toBeLessThan(data.total_aktiver!);
    // Forventet ~8 forsikrede (de med reel adresse-match)
    expect(data.insured_count).toBeGreaterThanOrEqual(5);
    expect(data.insured_count).toBeLessThanOrEqual(10);
  });

  test('UI viser korrekt forsikrede-antal i seneste analyse', async ({ page }) => {
    await page.goto('/dashboard/forsikring');
    await page.waitForLoadState('networkidle', { timeout: 30_000 });

    // Vælg Belvedere
    await page
      .getByRole('button', { name: /BELVEDERE EJENDOMME/i })
      .first()
      .click();
    await page.waitForTimeout(3000);

    // "Forrige analyse" boksen viser seneste resultat — tjek den
    const kpiText = await page.locator('text=/\\d+ forsikrede/').first().textContent();
    console.log(`[CVR-threshold UI] KPI text: ${kpiText}`);

    // Skal vise ~8 forsikrede (ikke 17)
    const match = kpiText?.match(/(\d+)\s*forsikrede/);
    expect(match).not.toBeNull();
    const insuredCount = parseInt(match![1], 10);
    expect(insuredCount).toBeLessThanOrEqual(10);
    expect(insuredCount).toBeGreaterThanOrEqual(5);
  });
});
