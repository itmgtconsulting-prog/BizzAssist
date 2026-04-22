import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
const BASE = 'https://test.bizzassist.dk';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await Promise.all([page.waitForURL(/dashboard/, { timeout: 30000 }), page.click('button[type=submit]')]);
await page.waitForTimeout(2000);

const out = {};

// ── BIZZ-686: Person Jakob ejendomme via direct API + tabs (scoped) ──────
await page.goto(`${BASE}/dashboard/owners/4000115446`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

// Use API directly to see what backend returns
const personProps = await page.evaluate(async () => {
  const r = await fetch('/api/ejerskab/person-properties?navn=Jakob%20Juul%20Rasmussen&fdato=1972-07-11');
  const j = await r.json();
  return { status: r.status, bfes: j.bfes, count: (j.bfes || []).length };
});
out['686_api'] = personProps;

// Scoped click — find the tab bar and click Ejendomme inside it
const tabBar = page.locator('[role="tablist"], [class*="tab"]').first();
const ejendommeTab = page.locator('button, [role="tab"]').filter({ hasText: /^Ejendomme$/ }).first();
const tabCount = await ejendommeTab.count();
if (tabCount > 0) {
  await ejendommeTab.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(3000);
}
const personalProps = await page.getByText(/Søbyvej|Vigerslev|Hovager|Astridsvej|Kaffevej/i).count();
const pageUrl = page.url();
await page.screenshot({ path: '/tmp/verify-screenshots/686-person-ejendomme.png', fullPage: false });
out['686_ui'] = { url: pageUrl, personalAddresses: personalProps };

// ── BIZZ-685: Salgshistorik — find a valid BFE from JAJR Holding's portfolio ──
// Jakob Holding ApS CVR 41092807 owns various properties. Try BFE 2024847 (Kaffevej 31)
// or 100165718 (from earlier person-properties list — Jakob's personal)
const candidates = [100165718, 10133930, 173448, 167448];
for (const bfe of candidates) {
  await page.goto(`${BASE}/dashboard/ejendomme/${bfe}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  const notFound = (await page.getByText(/ikke fundet/i).count()) > 0;
  if (notFound) {
    out[`685_${bfe}`] = 'not found';
    continue;
  }
  const h1 = await page.locator('h1').first().textContent().catch(() => '');
  // Try Økonomi tab
  const oek = page.locator('button, [role="tab"]').filter({ hasText: /^Økonomi$/ }).first();
  if ((await oek.count()) > 0) {
    await oek.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }
  const salgRows = await page.locator('text=/\\d+ kr|DKK|mio/i').count();
  const koeberCount = await page.getByText(/Køber:|Sælger:|Købesum/i).count();
  await page.screenshot({ path: `/tmp/verify-screenshots/685-bfe-${bfe}.png`, fullPage: false });
  out[`685_${bfe}`] = { h1: h1?.trim().slice(0, 50), salgRows, koeberCount };
  break;
}

console.log(JSON.stringify(out, null, 2));
await b.close();
