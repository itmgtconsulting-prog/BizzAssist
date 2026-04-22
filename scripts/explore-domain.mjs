#!/usr/bin/env node
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const BASE = 'https://test.bizzassist.dk';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await page.click('button[type=submit]');
try { await page.waitForURL(/dashboard/, { timeout: 45000 }); } catch { await page.waitForTimeout(5000); }
await page.waitForTimeout(2500);

// Tjek hvilke domains jjrchefen er member af
const mine = await page.evaluate(async () => {
  const res = await fetch('/api/domain/mine');
  const body = res.ok ? await res.json() : null;
  return { status: res.status, body };
});
console.log('GET /api/domain/mine:', JSON.stringify(mine, null, 2));

// Hvis ingen — tjek om feature flag er on
if (!mine.body || mine.status === 404) {
  console.log('\n/api/domain/mine returnerede ikke data — feature-flag måske ikke deployed endnu');
  const admin = await page.evaluate(async () => {
    const res = await fetch('/api/admin/domains');
    const body = res.ok ? await res.json() : null;
    return { status: res.status, body };
  });
  console.log('GET /api/admin/domains:', JSON.stringify(admin).slice(0, 500));
}

// Også prøv super-admin-view
await page.goto(`${BASE}/dashboard/admin/domains`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const ss = '/tmp/verify-screenshots/domain-admin-list.png';
fs.mkdirSync('/tmp/verify-screenshots', { recursive: true });
await page.screenshot({ path: ss, fullPage: true });
console.log(`Screenshot: ${ss}`);
console.log('URL efter nav:', page.url());
const body = await page.evaluate(() => document.body.innerText);
console.log('Body excerpt:', body.slice(0, 600));

await b.close();
