import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
const BASE = 'https://bizzassist.dk';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/login`);
const c = page.getByRole('button', { name: /Accept/i });
if (await c.isVisible({ timeout: 3000 }).catch(() => false)) await c.click();
await page.getByPlaceholder('navn@virksomhed.dk').fill(process.env.E2E_TEST_EMAIL);
await page.getByPlaceholder('••••••••').fill(process.env.E2E_TEST_PASS);
await page.getByRole('button', { name: /Log ind/i }).click();
await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 20000 });
if (page.url().includes('/onboarding')) await page.goto(`${BASE}/dashboard`);
console.log('Login OK');

await page.goto(`${BASE}/dashboard/ejendomme/4afa00c5-c304-463d-a67e-b24446187465`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(5000);
console.log('H1:', await page.locator('h1').first().textContent());

async function checkTab(label, contentChecks) {
  const tab = page.getByRole('tab', { name: new RegExp(label, 'i') }).first();
  if (!(await tab.count())) {
    console.log(`❌ Tab not found: ${label}`);
    return;
  }
  await tab.click();
  await page.waitForTimeout(2500);
  const results = [];
  for (const check of contentChecks) {
    const n = await page.getByText(check).count();
    results.push(`${check}=${n}`);
  }
  console.log(`${label}: ${results.join(', ')}`);
}

await checkTab('Ejerforhold|Ownership', [/Administrator/, /Ejer/]);
await checkTab('Økonomi|Economy', [/Ejendomsvurdering|Property valuation/, /Salgshistorik|Sales history/]);
await checkTab('Skat|Tax', [/Ejendomsskatter|Property taxes/, /Skattehistorik|Tax history/]);
await checkTab('Dokumenter|Documents', [/BBR-meddelelse/, /Jordforurening|Soil/]);
console.log('Page errors:', errors.length ? errors : 'none');

await browser.close();
