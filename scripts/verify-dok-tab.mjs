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
await page.waitForTimeout(4000);
console.log('H1:', await page.locator('h1').first().textContent());

// Klik Dokumenter-tab
const dokTab = page.getByRole('tab', { name: /Dokumenter|Documents/i }).first();
await dokTab.click();
await page.waitForTimeout(3000);

const dokumenterHeader = await page.getByRole('heading', { name: /Dokumenter|Documents/ }).count();
const bbrNotice = await page.getByText('BBR-meddelelse').count();
const soilContamination = await page.getByText(/Jordforurening|Soil contam/).count();
const cadastreMap = await page.getByText(/Matrikelkort|Cadastre map/).count();
const downloadBtn = await page.getByRole('button', { name: /Download valgte|Download selected/ }).count();
console.log('Dokumenter header:', dokumenterHeader);
console.log('BBR-meddelelse entry:', bbrNotice);
console.log('Jordforurening entry:', soilContamination);
console.log('Matrikelkort entry:', cadastreMap);
console.log('Download button:', downloadBtn);
console.log('Page errors:', errors.length ? errors : 'none');

await browser.close();
