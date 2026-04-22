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

// Ejerlejligheder (fra BIZZ-691 ticket): Thorvald Bindesbølls 100165718, Horsekildevej 173448, JC Jacobsens 100435372
// Plus control: Kildegårdsvej 100065801 (ejerbolig, var OK)
const ejerlejligheder = [
  { bfe: 100165718, name: 'Thorvald Bindesbølls Plads 18' },
  { bfe: 173448, name: 'Horsekildevej 26' },
  { bfe: 100435372, name: 'J.C. Jacobsens Gade 11' },
];
const ejerboliger = [
  { bfe: 100065801, name: 'Kildegårdsvej 18D' },
  { bfe: 5157134, name: 'H C Møllersvej 21' },
];

console.log('=== Ejerlejligheder (tidligere 0 m², nu skal de have reel m²) ===');
for (const { bfe, name } of ejerlejligheder) {
  const r = await page.evaluate(async (b) => {
    const x = await fetch(`/api/ejendomme-by-owner/enrich?bfe=${b}`);
    return { status: x.status, body: await x.json().catch(() => null) };
  }, bfe);
  console.log(`  ${bfe} ${name.padEnd(30)} | status=${r.status} bolig=${r.body?.boligAreal} areal=${r.body?.areal}`);
}

console.log('\n=== Ejerboliger (kontrol, bør stadig virke) ===');
for (const { bfe, name } of ejerboliger) {
  const r = await page.evaluate(async (b) => {
    const x = await fetch(`/api/ejendomme-by-owner/enrich?bfe=${b}`);
    return { status: x.status, body: await x.json().catch(() => null) };
  }, bfe);
  console.log(`  ${bfe} ${name.padEnd(30)} | status=${r.status} bolig=${r.body?.boligAreal} areal=${r.body?.areal}`);
}

await b.close();
