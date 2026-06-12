import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: '.playwright/auth.json', viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto('https://test.bizzassist.dk/dashboard/companies/24301117', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('h1', { timeout: 30000 });
await page.locator('button:has-text("Ejendomme")').first().click();
await page.waitForFunction(() => !document.body.innerText.includes('Indlæser'), { timeout: 90000 }).catch(() => {});
await page.waitForTimeout(3000);
// Find alle BFE-numre + tilhørende adresse-overskrifter
const rows = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('main *')) {
    const txt = el.childNodes.length === 1 && el.textContent ? el.textContent.trim() : '';
    if (/^BFE \d+/.test(txt)) out.push(txt);
  }
  return out;
});
console.log('BFE-rækker:', JSON.stringify(rows));
const txt = await page.locator('main').innerText();
console.log('--- adresser ---');
console.log([...txt.matchAll(/^([A-ZÆØÅ][a-zæøåA-ZÆØÅ.\- ]+ \d+[A-Z]?(?:, .+)?)$/gm)].map(m=>m[1]).join('\n'));
await browser.close();
