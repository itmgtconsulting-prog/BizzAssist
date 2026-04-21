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
await page.goto(`${BASE}/login`);
const c = page.getByRole('button', { name: /Accept/i });
if (await c.isVisible({ timeout: 3000 }).catch(() => false)) await c.click();
await page.getByPlaceholder('navn@virksomhed.dk').fill(process.env.E2E_TEST_EMAIL);
await page.getByPlaceholder('••••••••').fill(process.env.E2E_TEST_PASS);
await page.getByRole('button', { name: /Log ind/i }).click();
await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 20000 });
if (page.url().includes('/onboarding')) await page.goto(`${BASE}/dashboard`);
console.log('Login OK');

// Load Kaffevej 31 ejendomsside (dawaId for 1.tv)
await page.goto(`${BASE}/dashboard/ejendomme/4afa00c5-c304-463d-a67e-b24446187465`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(4000);
const h1 = await page.locator('h1').first().textContent().catch(() => null);
console.log('Page H1:', h1);

// Klik på Skat-tab
const skatTab = page.getByRole('tab', { name: /skat|tax/i }).first();
const skatExists = await skatTab.count();
console.log('Skat tab found:', skatExists > 0);
if (skatExists) {
  await skatTab.click();
  await page.waitForTimeout(2000);
  // Find tax section titles
  const propertyTaxesHeader = await page.getByText(/Ejendomsskatter|Property taxes/).count();
  const historyHeader = await page.getByText(/Skattehistorik|Tax history/).count();
  const hasLoadingSpinner = await page.getByText(/Henter SKAT|Loading tax/).count();
  console.log('Property taxes header count:', propertyTaxesHeader);
  console.log('Skattehistorik header count:', historyHeader);
  console.log('Loading spinner count:', hasLoadingSpinner);

  // Check for errors in console
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForTimeout(1000);
  console.log('Page errors:', errors.length ? errors : 'none');
}

await browser.close();
