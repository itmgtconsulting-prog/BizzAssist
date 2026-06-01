/**
 * E2E-verifikation af BIZZ-1939: falsk "Hus- og grundejeransvar mangler".
 *
 * Belvedere Ejendomme A/S (CVR 24301117) har en Topdanmark-police (9417319074)
 * med Erhvervsansvar. Topdanmark dækker grundejeransvar via Erhvervsansvar, men
 * gap-engine flagede tidligere hus_grundejer_ansvar som manglende (false positive
 * i GAP-067 branchekrav + GAP-STD-BASELINE standard-vilkår).
 *
 * Efter fixet (selskabs-aware coverage-alias) skal en frisk analyse IKKE længere
 * rapportere hus_grundejer_ansvar som manglende for Belvedere.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import { AUTH_STATE_PATH } from './helpers';

const BELVEDERE_CVR = '24301117';
const BELVEDERE_NAVN = 'BELVEDERE EJENDOMME A/S';

test.beforeEach(async ({}, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping BIZZ-1939 verification');
  }
});

test.describe('BIZZ-1939 — Topdanmark Erhvervsansvar dækker grundejeransvar', () => {
  test('frisk analyse flager IKKE hus_grundejer_ansvar som manglende', async ({ page }) => {
    const analyseRes = await page.request.post('/api/forsikring/analyser', {
      data: { kunde_type: 'virksomhed', kunde_id: BELVEDERE_CVR, kunde_navn: BELVEDERE_NAVN },
    });
    expect(analyseRes.status()).toBe(200);
    const { analyse_id } = (await analyseRes.json()) as { analyse_id: string };
    expect(analyse_id).toBeTruthy();

    const detailRes = await page.request.get(`/api/forsikring/analyser/${analyse_id}`);
    expect(detailRes.status()).toBe(200);
    const detail = (await detailRes.json()) as {
      gaps?: Array<{ check_id: string; title: string; source_data?: Record<string, unknown> }>;
    };
    const gaps = detail.gaps ?? [];

    // 1. GAP-067 branchekrav må ikke længere liste hus_grundejer_ansvar som manglende.
    const branchekrav = gaps.filter((g) => g.check_id === 'GAP-067');
    for (const g of branchekrav) {
      const manglende = (g.source_data as { manglende_krav?: string[] })?.manglende_krav ?? [];
      console.log(`[1939] GAP-067 manglende_krav: ${manglende.join(', ')}`);
      expect(manglende, `GAP-067 lister stadig hus_grundejer_ansvar som manglende`).not.toContain(
        'hus_grundejer_ansvar'
      );
    }

    // 2. Ingen gap (uanset type) må have en titel der falskt påstår grundejeransvar mangler.
    const grundejerGaps = gaps.filter((g) => /grundejeransvar/i.test(g.title));
    console.log(
      `[1939] gaps med "grundejeransvar" i titel: ${grundejerGaps.map((g) => `${g.check_id}:${g.title}`).join(' | ') || '(ingen)'}`
    );
    expect(
      grundejerGaps.map((g) => `${g.check_id}: ${g.title}`),
      'Der findes stadig gap(s) der nævner grundejeransvar i titlen'
    ).toEqual([]);

    // Diagnostik: log alle check-IDs for fuldt overblik
    console.log(
      `[1939] alle check_ids: ${gaps
        .map((g) => g.check_id)
        .sort()
        .join(', ')}`
    );
  });

  test('UI: forsikring-siden renderer og screenshottes', async ({ page }) => {
    await page.goto('/dashboard/forsikring');
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
    await page.screenshot({ path: '.playwright/1939-forsikring.png', fullPage: true });
  });
});
