/**
 * BIZZ-2092: Visuel verifikation — BELVEDERE EJENDOMME A/S (CVR 24301117)
 * Ejendomme-tab skal vise Fenrisvej 19 + Fenrisvej 15, ikke 4x Gefionsvej 47A.
 *
 * Kør: node scripts/_shot-2092.mjs
 */
import { chromium } from '@playwright/test';

const BASE = 'https://test.bizzassist.dk';
const browser = await chromium.launch();
const ctx = await browser.newContext({
  storageState: '.playwright/auth.json',
  viewport: { width: 1600, height: 1000 },
});
const page = await ctx.newPage();

await page.goto(`${BASE}/dashboard/companies/24301117`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('h1', { timeout: 30000 });
await page.locator('button:has-text("Ejendomme")').first().click();
// Vent til portefølje-loading er færdig (Indlæser-tekst væk)
await page
  .waitForFunction(() => !document.body.innerText.includes('Indlæser'), { timeout: 90000 })
  .catch(() => console.log('[WARN] Indlæser-tekst forsvandt ikke inden 90s'));
await page.waitForTimeout(3000);

const body = await page.locator('main').innerText().catch(() => '');
const gefionsvejCount = (body.match(/Gefionsvej 47A/g) || []).length;
console.log('Fenrisvej 19:', body.includes('Fenrisvej 19') ? 'JA' : 'NEJ');
console.log('Fenrisvej 15:', body.includes('Fenrisvej 15') ? 'JA' : 'NEJ');
console.log('Gefionsvej 47A forekomster:', gefionsvejCount);
console.log('Matrikelbetegnelse 65bi/65ce synlig:', /65bi|65ce/.test(body) ? 'JA' : 'NEJ');

await page.screenshot({ path: '/tmp/bizz2092-ejendomme.png', fullPage: false });
console.log('Screenshot: /tmp/bizz2092-ejendomme.png');
await browser.close();
