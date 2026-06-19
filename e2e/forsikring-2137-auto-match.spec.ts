/**
 * BIZZ-2137: Auto-vælg standard betingelser fra biblioteket ved analyse-start.
 *
 * Verificerer at når man åbner analyse-wizarden for en forsikringsejer med
 * tidligere uploadede policer, kalder frontend automatisk
 * POST /api/forsikring/standard-docs/auto-match og pre-selecter de
 * biblioteks-betingelser som policernes conditions_ref refererer til —
 * uafhængigt af kundens historik.
 *
 * Flow: genskab Belvedere via URL (BIZZ-2148) → doc-picker åbner + indlæser
 * tidligere docs → autoMatchConditions() fyrer → endpoint returnerer matchede
 * betingelser (DF20903-2 + DF20904-2) → de unioneres ind i stdSelectedIds →
 * "(N valgt)"-badgen i "Standard forsikringsbetingelser"-sektionen viser ≥ 1.
 *
 * Read-only: ingen uploads/sletninger; ingen tenant-forurening.
 *
 * Kører mod test.bizzassist.dk (develop) med gemt auth-state.
 */
import { test, expect } from '@playwright/test';
import { AUTH_STATE_PATH } from './helpers';

test.use({ storageState: AUTH_STATE_PATH });

const KUNDE = '24301117'; // BELVEDERE EJENDOMME A/S
const KUNDE_NAVN = 'BELVEDERE EJENDOMME A/S';

test('BIZZ-2137: standardbetingelser auto-vælges ved analyse-start', async ({ page }) => {
  // Fang auto-match-svaret så vi kan asserte på den faktiske live-matchning.
  const autoMatchResp = page.waitForResponse(
    (r) =>
      r.url().includes('/api/forsikring/standard-docs/auto-match') &&
      r.request().method() === 'POST',
    { timeout: 30_000 }
  );

  // Genskab kunde via URL — sætter selected + åbner doc-picker (BIZZ-2148).
  await page.goto(
    `/dashboard/forsikring?kunde=${KUNDE}&type=virksomhed&navn=${encodeURIComponent(KUNDE_NAVN)}`
  );
  await page.waitForLoadState('networkidle');
  await expect(page.getByText(KUNDE_NAVN).first()).toBeVisible({ timeout: 20_000 });

  // 1) Endpoint-niveau: auto-match kaldes og returnerer matchede betingelser.
  const resp = await autoMatchResp;
  expect(resp.status()).toBe(200);
  const body = (await resp.json()) as {
    matched?: Array<{ source_url: string; titel: string; ref: string }>;
  };
  const matched = body.matched ?? [];

  console.log('[2137] matched count:', matched.length);
  for (const m of matched) {
    console.log(`[2137] ✓ ref=${m.ref} | titel=${m.titel}`);
  }
  expect(matched.length).toBeGreaterThanOrEqual(1);
  const refs = matched.map((m) => m.ref);
  expect(refs).toContain('DF20903-2');
  expect(refs).toContain('DF20904-2');

  // 2) UI-niveau: "(N valgt)"-badgen viser de pre-selectede betingelser.
  const badge = page.getByText(/\(\d+\s+(valgt|selected)\)/).first();
  await expect(badge).toBeVisible({ timeout: 15_000 });
  const badgeText = (await badge.textContent()) ?? '';

  console.log('[2137] badge:', badgeText.trim());
  const n = parseInt(badgeText.replace(/\D/g, ''), 10);
  expect(n).toBeGreaterThanOrEqual(1);

  await page.screenshot({ path: '.playwright/forsikring-2137-auto-match.png', fullPage: true });
});
