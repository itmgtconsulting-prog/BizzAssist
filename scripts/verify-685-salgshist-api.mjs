import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const BASE = 'https://test.bizzassist.dk';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext();
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await Promise.all([page.waitForURL(/dashboard/, { timeout: 30000 }), page.click('button[type=submit]')]);
await page.waitForTimeout(2000);

// Test salgshistorik API for multiple BFEs
const bfes = [2091166, 425479, 2024847, 100065801, 2091185];
for (const bfe of bfes) {
  const r = await page.evaluate(async (b) => {
    const x = await fetch(`/api/salgshistorik?bfeNummer=${b}`);
    return { status: x.status, body: await x.json().catch(() => null) };
  }, bfe);
  const handler = r.body?.handler || [];
  console.log(`\nBFE ${bfe}: status=${r.status} handler-count=${handler.length}`);
  handler.slice(0, 4).forEach((h, i) => {
    console.log(`  [${i}]`, JSON.stringify({
      dato: h.overtagelsesdato || h.dato,
      koeber: h.koeber?.navn || h.koeberCvr || null,
      koebesum: h.koebesum,
      kontant: h.kontant,
      tinglyst: h.tinglyst || h.tinglystDato,
      type: h.handelsType || h.type,
    }).slice(0, 250));
  });
}
await b.close();
