import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto('https://test.bizzassist.dk/login');
await page.fill('input[type="email"]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type="password"]', process.env.E2E_TEST_PASS);
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard/);

// Verify API first
const api = await page.evaluate(async () => {
  const r = await fetch('/api/ejerskab/person-properties?navn=Jakob%20Juul%20Rasmussen&fdato=1972-07-11');
  return await r.json();
});
console.log('API shape:');
console.log('  bfes count:', api.bfes?.length);
console.log('  properties[0]:', JSON.stringify(api.properties?.[0]));
const soebyvejProp = api.properties?.find((p) => p.bfeNummer === 2081243);
console.log('  Søbyvej 11 (2081243):', JSON.stringify(soebyvejProp));

// Now UI — navigate to person, click Ejendomme, find the Søbyvej 11 card
await page.goto('https://test.bizzassist.dk/dashboard/owners/4000115446', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await page.evaluate(() => {
  const main = document.querySelector('main');
  if (!main) return;
  for (const el of main.querySelectorAll('button, a, [role="tab"]')) {
    if ((el.textContent ?? '').trim() === 'Ejendomme') { el.click(); return; }
  }
});
await page.waitForTimeout(10000);
for (let i = 0; i < 5; i++) { await page.evaluate(() => window.scrollBy(0, 400)); await page.waitForTimeout(500); }

const soebyvejCard = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('a[href*="/dashboard/ejendomme/"]')];
  for (const c of cards) {
    if ((c.textContent ?? '').includes('Søbyvej 11')) {
      return c.textContent.replace(/\s+/g, ' ').trim().slice(0, 300);
    }
  }
  return null;
});
console.log('\nSøbyvej 11 card content:');
console.log(' ', soebyvejCard);
console.log('\n  Contains "50%":', soebyvejCard?.includes('50%') ? '✓ YES' : '✗ NO');
await browser.close();
