import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const BASE = 'https://test.bizzassist.dk';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await Promise.all([page.waitForURL(/dashboard/, { timeout: 30000 }), page.click('button[type=submit]')]);
await page.waitForTimeout(2000);

// Get summarisk via tinglysning UUID for BFE 2091166
const r = await page.evaluate(async () => {
  // 1. get tinglysning UUID for BFE
  const t = await fetch('/api/tinglysning?bfe=2091166').then(r => r.json());
  const tluuid = t.uuid;
  // 2. fetch summarisk with tluuid
  const s = await fetch(`/api/tinglysning/summarisk?uuid=${tluuid}&hovedBfe=2091166`);
  const body = await s.json();
  return { tluuid, status: s.status, body };
});
console.log('tluuid:', r.tluuid, 'status:', r.status);
console.log('body keys:', Object.keys(r.body || {}));
if (r.body.ejere) {
  console.log('\nejere (', r.body.ejere.length, '):');
  r.body.ejere.forEach((e, i) => {
    console.log(`  [${i}] type=${e.adkomstType} tinglyst=${e.tinglystDato} koebesum=${e.koebesum} kontant=${e.kontantKoebesum} andel=${e.andelTaeller}/${e.andelNaevner}`);
    console.log('      ejer:', JSON.stringify({ navn: e.navn, cvr: e.cvr, adresse: e.adresse }).slice(0, 200));
  });
}
// Also check adkomst/handler section if exists
if (r.body.adkomstHistorik || r.body.handler) {
  console.log('\nhistoric entries:', r.body.adkomstHistorik?.length || r.body.handler?.length);
}
await b.close();
