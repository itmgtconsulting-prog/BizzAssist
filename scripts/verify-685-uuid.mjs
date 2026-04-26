import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const BASE = 'https://test.bizzassist.dk';
fs.mkdirSync('/tmp/verify-screenshots', { recursive: true });
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await Promise.all([page.waitForURL(/dashboard/, { timeout: 30000 }), page.click('button[type=submit]')]);
await page.waitForTimeout(2000);

const target = `${BASE}/dashboard/ejendomme/0a3f507c-ce08-32b8-e044-0003ba298018`;
console.log('→', target);
await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(5000);

const notFound = (await page.getByText(/ikke fundet/i).count()) > 0;
const h1 = await page.locator('h1').first().textContent().catch(() => '');
console.log('notFound:', notFound, '| h1:', h1?.trim().slice(0, 60));
if (notFound) { await b.close(); process.exit(0); }

// Click Økonomi tab
const oekTab = page.locator('button:has-text("Økonomi")').filter({ has: page.locator('svg') }).first();
await oekTab.click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(15000);
await page.screenshot({ path: '/tmp/verify-screenshots/685-hoevedstensvej27-oek.png', fullPage: true });

// Tinglysning API direct
const tinglyR = await page.evaluate(async () => {
  const r = await fetch('/api/tinglysning?bfe=2091166');
  return { status: r.status, body: await r.json().catch(() => null) };
});
console.log('\n/api/tinglysning?bfe=2091166 status=', tinglyR.status);
if (tinglyR.body) {
  const salg = tinglyR.body.salgshistorik || tinglyR.body.handler || tinglyR.body.adkomst || tinglyR.body;
  console.log('body keys:', Object.keys(tinglyR.body || {}).slice(0, 10));
  const rows = Array.isArray(salg) ? salg : (salg?.handler || salg?.rows || []);
  console.log('salgs-rows count:', Array.isArray(rows) ? rows.length : 'N/A');
  if (Array.isArray(rows) && rows.length > 0) {
    console.log('first row:', JSON.stringify(rows[0]).slice(0, 500));
  } else {
    // Print entire body for inspection
    console.log('full body:', JSON.stringify(tinglyR.body, null, 2).slice(0, 1500));
  }
}

// Extract salgshistorik rows from DOM
const rows = await page.evaluate(() => {
  const out = [];
  const tables = document.querySelectorAll('table, [role="table"]');
  for (const t of tables) {
    const trs = t.querySelectorAll('tr, [role="row"]');
    for (const tr of trs) {
      const cells = Array.from(tr.querySelectorAll('td, [role="cell"]')).map(c => c.textContent.trim());
      if (cells.length > 0) out.push(cells);
    }
  }
  return out;
});
console.log('\nTable rows found:', rows.length);
rows.slice(0, 10).forEach(r => console.log(' ', JSON.stringify(r).slice(0, 200)));

// Also fetch the underlying API
const apiResp = await page.evaluate(async () => {
  // Try multiple candidates
  const candidates = [
    '/api/tinglysning/salgshistorik?bfe=2091166',
    '/api/tinglysning?bfe=2091166',
    '/api/ejendom/0a3f507c-ce08-32b8-e044-0003ba298018/salgshistorik',
  ];
  const out = {};
  for (const u of candidates) {
    try {
      const r = await fetch(u);
      out[u] = { status: r.status, body: (await r.text()).slice(0, 300) };
    } catch (e) { out[u] = { error: String(e) }; }
  }
  return out;
});
console.log('\nAPI probes:');
for (const [k, v] of Object.entries(apiResp)) console.log(' ', k, '→', v.status || v.error);

await b.close();
