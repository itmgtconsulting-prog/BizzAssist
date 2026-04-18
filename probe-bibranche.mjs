#!/usr/bin/env node
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const env = Object.fromEntries(
  readFileSync('/root/BizzAssist/.env.local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^"|"$/g,'')]; })
);

const BASE = 'https://test.bizzassist.dk';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(`${BASE}/login`);
await page.locator('input[type="email"]').fill(env.E2E_TEST_EMAIL);
await page.locator('input[type="password"]').fill(env.E2E_TEST_PASS);
await page.locator('button[type="submit"]').click();
await page.waitForURL(/dashboard/);

// Probe raw CVR ES via our /api/cvr-raw or similar — or just check multiple known CVRs
const cvrs = [
  { cvr: '41370025', name: 'HP Properties ApS' },
  { cvr: '41092807', name: 'JaJR Holding ApS' },
  { cvr: '24256790', name: 'NOVO NORDISK A/S' },
  { cvr: '36022722', name: 'Maersk' },
];
for (const t of cvrs) {
  // Use cvr-public endpoint to check what's returned; look for bibranche in raw via admin?
  // Just look at current structured response:
  const data = await page.evaluate(async (cvr) => {
    const r = await fetch(`/api/cvr-public?vat=${cvr}`);
    return await r.json();
  }, t.cvr);
  console.log(`\n── ${t.name} (${t.cvr}) ──`);
  console.log(`navn: ${data.name ?? '?'}`);
  console.log(`branche: ${data.branche ?? data.industry ?? '?'}`);
  console.log(`all keys: ${Object.keys(data).filter(k => !k.startsWith('_')).slice(0, 30).join(', ')}`);
}

await browser.close();
