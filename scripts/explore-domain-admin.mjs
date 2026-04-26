#!/usr/bin/env node
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const BASE = 'https://test.bizzassist.dk';
const DOMAIN_ID = 'a6e72582-5c6c-44b8-bde4-bf1ca0f27622';
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

fs.mkdirSync('/tmp/verify-screenshots/domain', { recursive: true });

// Test 1: Domain admin dashboard
const pages = [
  { url: `/domain/${DOMAIN_ID}`, name: '1-user-dashboard' },
  { url: `/domain/${DOMAIN_ID}/admin`, name: '2-admin-dashboard' },
  { url: `/domain/${DOMAIN_ID}/admin/users`, name: '3-admin-users' },
  { url: `/domain/${DOMAIN_ID}/admin/settings`, name: '4-admin-settings' },
  { url: `/domain/${DOMAIN_ID}/admin/templates`, name: '5-admin-templates' },
  { url: `/domain/${DOMAIN_ID}/admin/training`, name: '6-admin-training' },
  { url: `/domain/${DOMAIN_ID}/admin/audit`, name: '7-admin-audit' },
  { url: `/domain/${DOMAIN_ID}/new-case`, name: '8-new-case' },
];

const results = [];
for (const t of pages) {
  await page.goto(`${BASE}${t.url}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const ss = `/tmp/verify-screenshots/domain/${t.name}.png`;
  await page.screenshot({ path: ss, fullPage: false });
  const url = page.url();
  const body = await page.evaluate(() => document.body.innerText);
  // Check om siden "virker" — ikke 404, ikke redirect tilbage
  const reached = url.includes(t.url.split('?')[0]) || url.endsWith(t.url);
  const is404 = /404|not found|ikke fundet/i.test(body);
  const redirect = !reached;
  results.push({
    path: t.url,
    reached,
    is404,
    redirect,
    finalUrl: url.replace(BASE, ''),
    preview: body.slice(0, 180).replace(/\s+/g, ' '),
    ss,
  });
}

for (const r of results) {
  const status = r.is404 ? '❌ 404' : r.redirect ? `↪ redirect til ${r.finalUrl}` : '✅ OK';
  console.log(`${status}  ${r.path}`);
  console.log(`   ${r.preview}`);
  console.log(`   screenshot: ${r.ss}`);
  console.log('');
}

// Also list API endpoints
console.log('--- API endpoints check ---');
const apis = await page.evaluate(async (id) => {
  async function probe(u) {
    try {
      const r = await fetch(u);
      return { url: u, status: r.status, ok: r.ok };
    } catch (e) { return { url: u, error: e.message }; }
  }
  return Promise.all([
    probe('/api/domain/mine'),
    probe(`/api/domain/${id}/cases`),
    probe(`/api/domain/${id}/admin/settings`),
    probe(`/api/domain/${id}/admin/members`),
    probe(`/api/domain/${id}/templates`),
    probe(`/api/domain/${id}/training-docs`),
    probe(`/api/domain/${id}/audit-log`),
  ]);
}, DOMAIN_ID);
for (const a of apis) console.log(`  [${a.status || 'ERR'}] ${a.url}`);

await b.close();
