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
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.fill('input[type=email]', 'itmgtconsulting@gmail.com');
await page.fill('input[type=password]', process.env.E2E_ADMIN_PASS || process.env.E2E_TEST_PASS);
await Promise.all([page.waitForURL(/dashboard/, { timeout: 30000 }), page.click('button[type=submit]')]);

// Try admin pages
const adminPages = [
  '/dashboard/admin/users',
  '/dashboard/admin/billing',
  '/dashboard/admin/plans',
  '/dashboard/admin/security',
  '/dashboard/admin/service-manager',
];
console.log('=== BIZZ-663: Cron-status link visible on admin pages ===');
for (const pth of adminPages) {
  const res = await page.goto(`${BASE}${pth}`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
  const status = res?.status() || 0;
  if (status !== 200) {
    console.log(`  ${pth}: HTTP ${status} — skip`);
    continue;
  }
  // Look for Cron-status link/text
  const cronLink = await page
    .locator('a[href="/dashboard/admin/cron-status"]')
    .count();
  console.log(`  ${pth}: cron-status link count=${cronLink}`);
}

// Screenshot tokens page for BIZZ-664
console.log('\n=== BIZZ-664: Tokens page screenshot ===');
fs.mkdirSync('/tmp/verify-screenshots', { recursive: true });
await page.goto(`${BASE}/dashboard/tokens`, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(2000);
await page.screenshot({
  path: '/tmp/verify-screenshots/664-tokens.png',
  fullPage: true,
});
console.log('  screenshot: /tmp/verify-screenshots/664-tokens.png');
// Also company page for comparison
await page.goto(`${BASE}/dashboard/companies/26316804`, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForTimeout(2000);
await page.screenshot({
  path: '/tmp/verify-screenshots/664-company-ref.png',
  fullPage: false,
});
console.log('  ref screenshot: /tmp/verify-screenshots/664-company-ref.png');

await b.close();
