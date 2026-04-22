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

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await Promise.all([page.waitForURL(/dashboard/, { timeout: 30000 }), page.click('button[type=submit]')]);

fs.mkdirSync('/tmp/verify-screenshots', { recursive: true });
await page.goto(`${BASE}/dashboard/tokens`, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForSelector('text=/Buy|Køb|token/i', { timeout: 20000 }).catch(() => null);
await page.waitForTimeout(3000);
await page.screenshot({ path: '/tmp/verify-screenshots/664-tokens-v2.png', fullPage: true });
console.log('tokens screenshot: /tmp/verify-screenshots/664-tokens-v2.png');

// Reference
await page.goto(`${BASE}/dashboard/companies/26316804`, {
  waitUntil: 'domcontentloaded',
  timeout: 20000,
});
await page.waitForTimeout(3000);
await page.screenshot({ path: '/tmp/verify-screenshots/664-company-v2.png', fullPage: false });
console.log('company ref: /tmp/verify-screenshots/664-company-v2.png');

await b.close();
