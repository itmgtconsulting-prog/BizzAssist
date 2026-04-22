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

// Test BFE API directly for each ejerlejlighed
const testBfes = [100165718, 173448, 100435372, 100065801, 5157134, 2024847];
const results = {};
for (const bfe of testBfes) {
  const r = await page.evaluate(async (b) => {
    const t0 = performance.now();
    const x = await fetch(`/api/bbr-arealer?bfe=${b}`);
    const ms = Math.round(performance.now() - t0);
    const txt = await x.text();
    let body = null;
    try { body = JSON.parse(txt); } catch {}
    return { status: x.status, ms, body };
  }, bfe);
  results[bfe] = r;
}

console.log(JSON.stringify(results, null, 2));

// Also try different endpoint names
const alternatives = await page.evaluate(async () => {
  const endpoints = ['/api/bbr-arealer', '/api/bbr', '/api/bbr-data'];
  const out = {};
  for (const e of endpoints) {
    try {
      const r = await fetch(e + '?bfe=173448');
      out[e] = { status: r.status, ok: r.ok };
    } catch (err) { out[e] = { error: String(err) }; }
  }
  return out;
});
console.log('endpoints:', alternatives);

await b.close();
