import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
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

await page.goto(`${BASE}/dashboard/owners/4000115446`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

// Click Ejendomme tab specifically within the tab-bar scope
// The tab-bar is right under the h1 with icons like the home icon
const ejTab = page.locator('button:has-text("Ejendomme")').filter({ has: page.locator('svg') }).first();
const tabCount = await ejTab.count();
console.log('tab candidates:', tabCount);
if (tabCount) {
  await ejTab.click({ timeout: 5000 }).catch((e) => console.log('click err', e.message));
  await page.waitForTimeout(4000);
}

// Screenshot current state
await page.screenshot({ path: '/tmp/verify-screenshots/686-ejendomme-scoped.png', fullPage: true });

// Look for specific properties from the API (9 BFEs) — their addresses should be visible
const knownProps = ['Søbyvej 11', 'Vigerslev', 'Hovager', 'Kaffevej', 'Arnold Nielsens', 'Astridsvej'];
const found = {};
for (const p of knownProps) {
  found[p] = await page.getByText(new RegExp(p, 'i')).count();
}

// Check if "Ingen" appears in personal ejendomme section
const ingenCount = await page.getByText(/Ingen.*ejendom|ingen personligt/i).count();
const loadingCount = await page.getByText(/Henter|Indlæser/i).count();

console.log('found addresses:', found);
console.log('ingen count:', ingenCount, 'loading:', loadingCount);
console.log('url:', page.url());
await b.close();
