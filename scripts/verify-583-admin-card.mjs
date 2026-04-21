#!/usr/bin/env node
/**
 * BIZZ-583 verifikation: /api/ejendomsadmin returnerer admin + UI-kort rendres
 * på Ejerforhold-tab. Vi tester primært API-laget via page.evaluate siden
 * admin-kort kun skjules hvis listen er tom.
 */
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
const BASE = 'https://test.bizzassist.dk';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext();
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await Promise.all([page.waitForURL(/dashboard/), page.click('button[type=submit]')]);

// Test API for 10 kendte BFE'er — se om mindst 1 returnerer admin
const sampleBfes = [226630, 2091185, 2091191, 2091182, 425479, 2081243, 2024847, 100165718];
const hits = [];
for (const bfe of sampleBfes) {
  const r = await page.evaluate(async (b) => {
    const x = await fetch(`/api/ejendomsadmin?bfeNummer=${b}`);
    return { status: x.status, body: await x.text() };
  }, bfe);
  let count = 0,
    err = null;
  try {
    const j = JSON.parse(r.body);
    count = (j.administrators || j.admins || j.administrator || []).length;
    if (j.error) err = j.error;
  } catch {}
  console.log(`BFE ${bfe}: HTTP ${r.status}, admins=${count}${err ? ', err=' + err : ''}`);
  if (count > 0) hits.push({ bfe, body: JSON.parse(r.body) });
}

if (hits.length > 0) {
  console.log('\nFirst hit sample:');
  console.log(JSON.stringify(hits[0], null, 2).slice(0, 800));
}

await b.close();
