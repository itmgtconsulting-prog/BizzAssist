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

// BFE 2091166 = Høvedstensvej 27 per screenshot
for (const bfe of [2091166, 2091180, 226630, 2091185]) {
  await page.goto(`${BASE}/dashboard/ejendomme/${bfe}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  const notFound = (await page.getByText(/ikke fundet/i).count()) > 0;
  const h1 = await page.locator('h1').first().textContent().catch(() => '');
  console.log(bfe, 'notfound=', notFound, 'h1=', h1?.trim().slice(0, 60));
  if (notFound) continue;
  // Economy tab
  await page.locator('button:has-text("Økonomi")').filter({ has: page.locator('svg') }).first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `/tmp/verify-screenshots/685-bfe-${bfe}-oek.png`, fullPage: true });

  // Look for salgshistorik markers
  const koeberPresent = await page.getByText(/Køber:|Sælger:/i).count();
  const koebesumPresent = await page.getByText(/\d+\s*(mio|kr|DKK)/i).count();
  const emptyCellCount = await page.getByText(/^—$|^-$/).count();
  console.log('  koeber/saelger:', koeberPresent, '| price-like:', koebesumPresent, '| empty cells:', emptyCellCount);
  break;
}
await b.close();
