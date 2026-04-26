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

// ── BIZZ-687: JaJR Holding ApS (CVR 41092807) ────────────────────────────
console.log('=== BIZZ-687: JaJR Holding diagram ===');
await page.goto(`${BASE}/dashboard/companies/41092807`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
// Oversigt first — check ejere section
await page.screenshot({ path: '/tmp/verify-screenshots/687-oversigt.png', fullPage: false });
const jakobInOversigt = await page.getByText(/Jakob Juul Rasmussen/).count();
const cvrDataFromApi = await page.evaluate(async () => {
  const r = await fetch('/api/cvr-public?vat=41092807');
  const j = await r.json();
  return { owners: j.owners?.slice(0, 3), deltagerCount: j.deltagere?.length };
});
console.log('Jakob in Oversigt text-matches:', jakobInOversigt, '| API owners:', JSON.stringify(cvrDataFromApi).slice(0, 300));

// Diagram tab
const diagTab = page.locator('button:has-text("Diagram")').filter({ has: page.locator('svg') }).first();
await diagTab.click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(6000);
await page.screenshot({ path: '/tmp/verify-screenshots/687-diagram.png', fullPage: false });
const jakobInDiagram = await page.getByText(/Jakob Juul Rasmussen/).count();
console.log('Jakob in Diagram text-matches:', jakobInDiagram);

// ── BIZZ-693: Kaffevej 31, 1.tv salgshistorik ────────────────────────────
console.log('\n=== BIZZ-693: Kaffevej 31 1.tv salgshistorik ===');
const salgsApi = await page.evaluate(async () => {
  const r = await fetch('/api/salgshistorik?bfeNummer=425479');
  const j = await r.json();
  return {
    count: (j.handler || []).length,
    rowsWithKoeber: (j.handler || []).filter((h) => h.koeber?.navn || h.koeberCvr).length,
    rowsWithKoebesum: (j.handler || []).filter((h) => h.koebesum).length,
    sample: (j.handler || []).slice(0, 2),
  };
});
console.log('salgshistorik 425479:', JSON.stringify(salgsApi, null, 2).slice(0, 600));

await b.close();
