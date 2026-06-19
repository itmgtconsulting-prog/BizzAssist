/**
 * BIZZ-2167: Kort-knap skal vises også når en gammel analyse åbnes fra historik.
 *
 * Root cause: AnalyseDetailSection hentede analyse-data internt men propagerede
 * det ikke op til parent (aiAnalyseDetail forblev null → geoAnalyseId null →
 * Kort-knap aldrig synlig). Fix: onDetail-callback der sætter aiAnalyseDetail.
 *
 * Verifikation: åbn en gemt analyse (via analyse-param, samme kodevej som et klik
 * i historik-listen → activeAnalyseId → AnalyseDetailSection) og bekræft at
 * Kort-knappen er synlig i headeren.
 *
 * Kører mod test.bizzassist.dk (develop) med gemt auth-state.
 */
import { test, expect } from '@playwright/test';
import { AUTH_STATE_PATH } from './helpers';

test.use({ storageState: AUTH_STATE_PATH });

const KUNDE = '24301117'; // BELVEDERE EJENDOMME A/S
const ANALYSE = 'e3f90f08-0b71-4e3e-883d-b13e1a64ac9b';

test('BIZZ-2167: Kort-knap synlig når gammel analyse åbnes fra historik', async ({ page }) => {
  await page.goto(
    `/dashboard/forsikring?kunde=${KUNDE}&type=virksomhed&navn=${encodeURIComponent(
      'BELVEDERE EJENDOMME A/S'
    )}&analyse=${ANALYSE}`
  );
  await page.waitForLoadState('networkidle');

  // Analyse-detaljen skal være renderet (KPI-overskrift).
  await expect(page.getByText(/Analyse-resultater|Analysis results/).first()).toBeVisible({
    timeout: 20_000,
  });

  // Kort-knappen i headeren skal nu være synlig (drives af aiAnalyseDetail via onDetail).
  const kortKnap = page.getByRole('button', { name: /Vis kort|Show map/ });
  await expect(kortKnap).toBeVisible({ timeout: 15_000 });

  await page.screenshot({ path: '.playwright/forsikring-2167-kort-knap.png', fullPage: true });
});
