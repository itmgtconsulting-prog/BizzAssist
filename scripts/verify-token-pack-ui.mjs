#!/usr/bin/env node
/**
 * Verify token pack UI renders for a logged-in user on test.bizzassist.dk.
 */
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

const BASE = 'https://test.bizzassist.dk';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await Promise.all([
  page.waitForURL(/dashboard/, { timeout: 30000 }),
  page.click('button[type=submit]'),
]);

// Fetch /api/token-packs directly
const packsApi = await page.evaluate(async () => {
  const r = await fetch('/api/token-packs');
  return { status: r.status, body: await r.text() };
});
console.log('GET /api/token-packs:', packsApi.status);
console.log('body:', packsApi.body.slice(0, 300));

await page.goto(`${BASE}/dashboard/tokens`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

// Look for the "Køb" button
const buyButtons = await page.locator('button', { hasText: /køb|buy/i }).all();
console.log('Buy buttons found:', buyButtons.length);

// Look for "500.000 tokens" text
const packLabel = await page.locator('text=/500\\.000/').count();
console.log('"500.000" text count:', packLabel);

await page.screenshot({ path: '/tmp/verify-screenshots/token-pack-ui.png', fullPage: true });
console.log('screenshot: /tmp/verify-screenshots/token-pack-ui.png');

await browser.close();
