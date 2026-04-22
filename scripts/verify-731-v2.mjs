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

// Intercept alle API-requests for at se hvad UI bruger
const apiCalls = [];
page.on('response', async (res) => {
  const u = res.url();
  if (u.includes('/api/') && (u.includes('ejendom') || u.includes('bbr') || u.includes('owner'))) {
    try {
      const body = await res.text();
      apiCalls.push({ url: u, status: res.status(), bodySnippet: body.slice(0, 500) });
    } catch {}
  }
});

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await page.click('button[type=submit]');
try { await page.waitForURL(/dashboard/, { timeout: 45000 }); } catch { await page.waitForTimeout(5000); }
await page.waitForTimeout(2000);

apiCalls.length = 0; // clear

// Navigér til person-side
console.log('→ Navigerer til person-side');
await page.goto(`${BASE}/dashboard/owners/4000115446`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);

// Tab-click: exclude sidebar-nav (aside). Scope til main content
let tabClicked = false;
try {
  // Eksluder sidebar-links (typisk i <aside> eller <nav>). Prøv at finde tab-button inde i main
  const tabBtn = page.locator('main button, main [role=tab], main a').filter({ hasText: /^Ejendomme$/ }).first();
  if (await tabBtn.count()) {
    await tabBtn.click();
    tabClicked = true;
  }
} catch {}
if (!tabClicked) {
  try {
    // Alternativ: prøv at finde tab-link med ?tab query
    const url = new URL(page.url());
    url.searchParams.set('tab', 'ejendomme');
    await page.goto(url.toString(), { waitUntil: 'networkidle' });
    tabClicked = true;
  } catch {}
}
console.log('Tab-klik lykkedes:', tabClicked);
await page.waitForTimeout(4000);

// Tag screenshot af Ejendomme-tab
const ss = '/tmp/verify-screenshots/731-v2-ejendomme-tab.png';
await page.screenshot({ path: ss, fullPage: true });
console.log('Screenshot:', ss);

// Print alle API-kald UI har lavet
console.log('\n── API calls made by UI ──');
for (const c of apiCalls) {
  console.log(`  [${c.status}] ${c.url.slice(BASE.length)}`);
  if (c.status === 200 && c.url.includes('ejendom')) {
    console.log(`       ${c.bodySnippet.slice(0, 250)}`);
  }
}

// Check body for expected addresses + check at ingen "0 m²"
const body = await page.evaluate(() => document.body.innerText);
const expected = [
  { bfe: 100165718, adresse: 'Thorvald Bindesbølls Plads 18' },
  { bfe: 173448, adresse: 'Horsekildevej 26' },
  { bfe: 100435372, adresse: 'J.C. Jacobsens Gade 11' },
  { bfe: 167448, adresse: 'Vigerslevvej 146' },
];
console.log('\n── Tjek af bolig-tekst omkring hver adresse ──');
for (const e of expected) {
  const fragment = e.adresse.replace(/\./g, '\\.');
  const re = new RegExp(`${fragment}[\\s\\S]{0,500}?(bolig|m²)[\\s\\S]{0,80}`, 'i');
  const m = body.match(re);
  if (m) {
    const snippet = m[0].replace(/\s+/g, ' ').slice(0, 200);
    const boligVal = snippet.match(/bolig[:\s]*([\d.,]+)\s*m²/i);
    console.log(`  ${e.adresse}: "${snippet.slice(0, 150)}..."`);
    console.log(`    bolig fra regex: ${boligVal ? boligVal[1] : 'ikke fundet i snippet'}`);
  } else {
    console.log(`  ${e.adresse}: ikke fundet i body-tekst`);
  }
}

// Leder efter direkte "Bolig: 0" i body
const hasZeroBolig = /bolig\s*[:\s]*0\s*m²/i.test(body);
console.log(`\nRegression-guard — "Bolig: 0 m²" i body: ${hasZeroBolig ? '❌ STADIG FUND' : '✅ ikke fundet'}`);

await b.close();
