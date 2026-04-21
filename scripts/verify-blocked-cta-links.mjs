#!/usr/bin/env node
/**
 * BIZZ-651: verificér at buy-tokens-banner CTA-knapper linker til sider der
 * faktisk eksisterer og renderer OK for en zero-budget bruger.
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

for (const target of ['/dashboard/tokens', '/dashboard/settings?tab=abonnement']) {
  const res = await page.goto(`${BASE}${target}`, { waitUntil: 'networkidle' });
  const status = res?.status() || 0;
  const title = await page.title();
  const bodyText = (await page.locator('body').textContent())?.slice(0, 150).replace(/\s+/g, ' ');
  console.log(`${status} ${target}`);
  console.log(`  title: ${title}`);
  console.log(`  body:  ${bodyText}`);
}

await browser.close();
