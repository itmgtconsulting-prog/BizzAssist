/**
 * Boligpris værelser/etager-filter regression (BIZZ-2179/2176).
 *
 * Ejerlejligheder havde systematisk NULL antal_vaerelser, så værelses-/etager-
 * filtrene i boligpris-dashboardet returnerede ~0 ejerlejligheder. Efter
 * national backfill (TL→DAWA→BBR_Enhed) skal filtrene give meningsfulde,
 * indsnævrende resultater.
 *
 * Verificerer via det authenticated /api/analyse/boligpris-endpoint at et
 * værelses-filter (a) returnerer >0 handler og (b) indsnævrer ift. ufiltreret.
 *
 * @module e2e/boligpris-filter.spec
 */

import { test, expect } from '@playwright/test';

/** Hent KPI-antal_handler fra boligpris-API'et (authenticated via storageState). */
async function kpiAntal(
  page: import('@playwright/test').Page,
  baseURL: string,
  query: string
): Promise<number> {
  return page.evaluate(async (url) => {
    const r = await fetch(url);
    if (!r.ok) return -1;
    const j = await r.json();
    return j?.noegletal?.antal_handler ?? j?.noegletal?.antalHandler ?? -1;
  }, `${baseURL}/api/analyse/boligpris?${query}`);
}

test.describe('Boligpris værelser/etager-filter (BIZZ-2179)', () => {
  // København (kommune 101) — stor population, stabil til regression.
  const KOMMUNE = '101';

  test('værelses-filter returnerer ejerlejligheder og indsnævrer', async ({ page, baseURL }) => {
    const base = baseURL ?? 'https://test.bizzassist.dk';
    // Warm session: en authenticated side så cookies/headers er sat for fetch.
    await page.goto(`${base}/dashboard/analyse/boligpris`, { waitUntil: 'domcontentloaded' });

    const alle = await kpiAntal(page, base, `kommuner=${KOMMUNE}&handler=true&limit=1`);
    const vaerelser2 = await kpiAntal(
      page,
      base,
      `kommuner=${KOMMUNE}&handler=true&vaerelser_min=2&vaerelser_max=2&limit=1`
    );
    const vaerelser3 = await kpiAntal(
      page,
      base,
      `kommuner=${KOMMUNE}&handler=true&vaerelser_min=3&vaerelser_max=3&limit=1`
    );

    // Filtrene skal virke (ikke 403/fejl) og give reelle ejerlejligheder.
    expect(alle, 'ufiltreret KPI skal være positivt').toBeGreaterThan(0);
    expect(vaerelser2, '2-værelses-filter skal returnere >0 (var ~0 før backfill)').toBeGreaterThan(
      0
    );
    expect(vaerelser3, '3-værelses-filter skal returnere >0').toBeGreaterThan(0);
    // Et enkelt værelses-tal skal indsnævre ift. hele kommunen.
    expect(vaerelser2).toBeLessThan(alle);
    expect(vaerelser3).toBeLessThan(alle);
  });

  test('etager-filter returnerer resultater', async ({ page, baseURL }) => {
    const base = baseURL ?? 'https://test.bizzassist.dk';
    await page.goto(`${base}/dashboard/analyse/boligpris`, { waitUntil: 'domcontentloaded' });
    const etager4 = await kpiAntal(
      page,
      base,
      `kommuner=${KOMMUNE}&handler=true&etager_min=4&etager_max=4&limit=1`
    );
    expect(etager4, 'etager=4-filter skal returnere >0 (etager backfillet)').toBeGreaterThan(0);
  });
});
