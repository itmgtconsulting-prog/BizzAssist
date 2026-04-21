#!/usr/bin/env node
/**
 * BIZZ-649 verifikation: jjrchefen@gmail.com har testplan1 (ai_tokens_per_month=0),
 * bonus=0, topUp=0 — gate SKAL blokere på alle 8 AI-endpoints.
 *
 * Bruger page.evaluate + fetch efter login for at ramme endpoints direkte.
 */
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

const BASE = 'https://test.bizzassist.dk';
const EMAIL = process.env.E2E_TEST_EMAIL;
const PASS = process.env.E2E_TEST_PASS;
if (!EMAIL || !PASS) {
  console.error('Missing E2E creds');
  process.exit(1);
}

const ENDPOINTS = [
  { path: '/api/ai/article-search', method: 'POST', body: { companyName: 'Test', cvr: '12345678' } },
  {
    path: '/api/ai/article-search/socials',
    method: 'POST',
    body: { companyName: 'Test', cvr: '12345678' },
  },
  {
    path: '/api/ai/article-search/articles?phase=ai',
    method: 'POST',
    body: { companyName: 'Test', cvr: '12345678' },
  },
  { path: '/api/ai/person-article-search', method: 'POST', body: { personName: 'Test' } },
  {
    path: '/api/ai/person-search/socials',
    method: 'POST',
    body: { personName: 'Test', enhedsNummer: '123' },
  },
  {
    path: '/api/ai/person-search/contacts',
    method: 'POST',
    body: { personName: 'Test', enhedsNummer: '123' },
  },
  {
    path: '/api/ai/person-search/articles',
    method: 'POST',
    body: { personName: 'Test', enhedsNummer: '123' },
  },
  {
    path: '/api/analysis/run',
    method: 'POST',
    body: { analysisType: 'property', context: { bfeNumber: '1' } },
  },
  {
    path: '/api/ai/chat',
    method: 'POST',
    body: { messages: [{ role: 'user', content: 'hej' }] },
  },
  { path: '/api/support/chat', method: 'POST', body: { messages: [{ role: 'user', content: 'hej' }] } },
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

console.log('→ Login som', EMAIL);
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('input[type=email]', EMAIL);
await page.fill('input[type=password]', PASS);
await Promise.all([page.waitForURL(/dashboard/, { timeout: 30000 }), page.click('button[type=submit]')]);
console.log('✅ Logged in');

const results = [];
for (const ep of ENDPOINTS) {
  const r = await page.evaluate(async ({ path, method, body }) => {
    try {
      const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let json = null;
      try {
        json = await res.json();
      } catch {}
      return { status: res.status, code: json?.code, error: json?.error?.slice(0, 100) };
    } catch (e) {
      return { status: 0, error: String(e).slice(0, 100) };
    }
  }, ep);
  const blocked =
    (r.status === 402 && r.code === 'trial_ai_blocked') ||
    (r.status === 429) ||
    (r.status === 403);
  const mark = blocked ? '✅ BLOCKED' : '❌ ALLOWED';
  console.log(`${mark} ${ep.path.padEnd(50)} status=${r.status} code=${r.code || '-'}`);
  results.push({ endpoint: ep.path, ...r, blocked });
}

const outPath = '/tmp/verify-screenshots/results-649-jjrchefen.json';
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log('\n→ report:', outPath);

const allBlocked = results.every((r) => r.blocked);
console.log(allBlocked ? '\n✅ ALL BLOCKED — gate works' : '\n❌ SOME LEAKED');

await browser.close();
process.exit(allBlocked ? 0 : 1);
