#!/usr/bin/env node
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
const BASE = 'https://test.bizzassist.dk';
fs.mkdirSync('/tmp/verify-screenshots', { recursive: true });
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 150)));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('vercel.live') && !t.includes('401') && !t.includes('Mapbox'))
    errors.push('error: ' + t.slice(0, 150));
});
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await Promise.all([page.waitForURL(/dashboard/, { timeout: 30000 }), page.click('button[type=submit]')]);

// Settings page (alle 4 tabs)
console.log('=== BIZZ-661 Settings page ===');
await page.goto(`${BASE}/dashboard/settings`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(4000);
await page.screenshot({ path: '/tmp/verify-screenshots/661-settings.png', fullPage: false });
const crash1 = await page.getByText(/Noget gik galt|Uncaught/i).count();
console.log('Settings page crash:', crash1, 'errors:', errors.length);

// Abonnement tab via ?tab= query param
await page.goto(`${BASE}/dashboard/settings?tab=abonnement`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(4000);
await page.screenshot({ path: '/tmp/verify-screenshots/661-settings-abonnement.png', fullPage: false });
const crash2 = await page.getByText(/Noget gik galt|Uncaught/i).count();
console.log('Abonnement tab crash:', crash2, 'errors-total:', errors.length);

// Kort (1916 linjer, uændret)
console.log('\n=== Kort page (uændret 1916l) ===');
await page.goto(`${BASE}/dashboard/kort`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(4000);
await page.screenshot({ path: '/tmp/verify-screenshots/661-kort.png', fullPage: false });
const crash3 = await page.getByText(/Noget gik galt|Uncaught/i).count();
console.log('Kort crash:', crash3, 'errors-total:', errors.length);

console.log(`\nTotal relevant errors: ${errors.length}`);
errors.slice(0, 5).forEach((e, i) => console.log(`  [${i}] ${e}`));
await b.close();
