/**
 * BIZZ-2160: Genskab forsikring-analyse-tilstand ved bar-sti-navigation.
 *
 * URL-state (BIZZ-2148) dækker browser-back/genindlæs. Denne test verificerer den
 * nye sessionStorage-fallback: når brugeren først har set en analyse (med params i
 * URL'en) og derefter ankommer til /dashboard/forsikring UDEN params (som via
 * analyse-modulkortet), skal analysen genskabes — ikke en blank start-skærm — og
 * URL-sync skal skrive kunde/analyse-params tilbage så tilstanden igen er bookmark-bar.
 *
 * Kører mod test.bizzassist.dk (develop) med gemt auth-state.
 */
import { test, expect } from '@playwright/test';
import { AUTH_STATE_PATH } from './helpers';

test.use({ storageState: AUTH_STATE_PATH });

const KUNDE = '24301117'; // BELVEDERE EJENDOMME A/S
const ANALYSE = 'e3f90f08-0b71-4e3e-883d-b13e1a64ac9b';

test('BIZZ-2160: bar-sti /dashboard/forsikring genskaber seneste analyse fra sessionStorage', async ({
  page,
}) => {
  // 1) Besøg med fulde params (URL-restore, BIZZ-2148) — sætter sessionStorage.
  await page.goto(
    `/dashboard/forsikring?kunde=${KUNDE}&type=virksomhed&navn=${encodeURIComponent(
      'BELVEDERE EJENDOMME A/S'
    )}&analyse=${ANALYSE}`
  );
  await page.waitForLoadState('networkidle');
  // Kunden skal være genskabt som valgt.
  await expect(page.getByText('BELVEDERE EJENDOMME A/S').first()).toBeVisible({ timeout: 20_000 });

  // 2) Naviger til bar sti uden params (som analyse-modulkortet gør).
  await page.goto('/dashboard/forsikring');
  await page.waitForLoadState('networkidle');

  // 3) Analysen skal genskabes fra sessionStorage — kunden er stadig valgt …
  await expect(page.getByText('BELVEDERE EJENDOMME A/S').first()).toBeVisible({ timeout: 20_000 });

  // … og URL-sync skal have skrevet params tilbage (AC#2: bookmark-bar).
  await expect(page).toHaveURL(new RegExp(`kunde=${KUNDE}`), { timeout: 10_000 });

  await page.screenshot({ path: '.playwright/forsikring-2160-restore.png', fullPage: true });
});
