#!/usr/bin/env node
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
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
await page.waitForTimeout(2000);

// API-test: /api/ejerskab/chain for BFE 2091165
const api = await page.evaluate(async () => {
  const r = await fetch('/api/ejerskab/chain?bfe=2091165').then(r => r.json()).catch(e => ({ err: e.message }));
  return r;
});
console.log('API response (slice):', JSON.stringify(api).slice(0, 2000));

// Find eventuelle entries der indeholder "opdelt i anpart"
const findStr = (o, path = []) => {
  const hits = [];
  if (typeof o === 'string' && /opdelt i anpart/i.test(o)) hits.push({ path: path.join('.'), value: o });
  if (Array.isArray(o)) o.forEach((v, i) => hits.push(...findStr(v, [...path, i])));
  else if (o && typeof o === 'object') Object.entries(o).forEach(([k, v]) => hits.push(...findStr(v, [...path, k])));
  return hits;
};
const anpartHits = findStr(api);
console.log(`\n"opdelt i anpart" hits: ${anpartHits.length}`);
for (const h of anpartHits.slice(0, 10)) console.log(`  ${h.path}: "${h.value}"`);

// Check: der må IKKE være en ejer med type="person" der har "opdelt i anpart" i navnet
const owners = api.owners || api.ejere || api.chain || [];
const bogusPerson = owners.filter(o => o.type === 'person' && /opdelt/i.test(o.navn || o.name || ''));
console.log(`\nFejlklassificerede "person"-ejere med "opdelt" i navnet: ${bogusPerson.length}`);
for (const p of bogusPerson) console.log('  ', JSON.stringify(p).slice(0, 200));

// Positivt: check om der findes en entry med type="status" og "opdelt i anpart"
const statusEntries = (Array.isArray(owners) ? owners : []).filter(o => o.type === 'status' && /opdelt/i.test(o.navn || o.name || ''));
console.log(`\n"status"-entries med "opdelt": ${statusEntries.length}`);
for (const s of statusEntries) console.log('  ', JSON.stringify(s).slice(0, 200));

await b.close();

// Tests check
console.log('\n--- Unit tests ---');
