#!/usr/bin/env node
/**
 * Verificér at /api/cvr-public/related + /api/ejendomme-by-owner fires
 * INDEN bruger klikker på Diagram eller Ejendomme tab.
 * Success: calls observed while on Oversigt-tab (uden tab-interaction).
 */
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const BASE = 'https://test.bizzassist.dk';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

// Intercept API-kald med timestamp
const apiCalls = [];
let pageMountTime = null;
page.on('request', (req) => {
  if (req.url().includes('/api/')) {
    apiCalls.push({ url: new URL(req.url()).pathname, t: Date.now() });
  }
});

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await page.click('button[type=submit]');
try { await page.waitForURL(/dashboard/, { timeout: 45000 }); } catch { await page.waitForTimeout(5000); }
await page.waitForTimeout(2000);

// Ryd calls før navigation til detaljeside
apiCalls.length = 0;
pageMountTime = Date.now();
console.log('→ Navigerer til /dashboard/companies/41092807 (JaJR Holding)');
await page.goto(`${BASE}/dashboard/companies/41092807`, { waitUntil: 'domcontentloaded' });

// Vent 8 sek — lang nok til at prefetches kan fyre, kortere end typisk tab-klik-ventetid
await page.waitForTimeout(8000);

// Tjek om vi stadig er på Oversigt-fanen (skal være default)
const activeTab = await page.evaluate(() => {
  const active = document.querySelector('[aria-selected="true"], [data-state="active"]');
  return active?.textContent?.trim() || 'ukendt';
});
console.log('Aktiv tab efter 8s:', activeTab);

// Analysér prefetches
console.log('\nAPI calls (første 30 efter mount):');
for (const c of apiCalls.slice(0, 30)) {
  const elapsed = c.t - pageMountTime;
  console.log(`  +${String(elapsed).padStart(5)}ms  ${c.url}`);
}

// Find specifikke prefetches ticket forventer
const relatedCall = apiCalls.find(c => c.url.includes('/cvr-public/related'));
const salgsCall = apiCalls.find(c => c.url.includes('/salgshistorik/cvr'));
const relatedElapsed = relatedCall ? relatedCall.t - pageMountTime : null;
const salgsElapsed = salgsCall ? salgsCall.t - pageMountTime : null;

console.log('\n--- Acceptance ---');
console.log(`  ${relatedCall ? '✅' : '❌'} /api/cvr-public/related prefetch fires (elapsed=${relatedElapsed}ms)`);
console.log(`  ${salgsCall ? '✅' : '❌'} /api/salgshistorik/cvr prefetch fires (elapsed=${salgsElapsed}ms)`);
console.log(`  ${/oversigt|overview/i.test(activeTab) ? '✅' : '⚠️'} Stadig på Oversigt-tab (ingen tab-klik simuleret)`);
console.log(`  ${relatedElapsed && relatedElapsed < 7000 ? '✅' : '❌'} Prefetch happened within 7 s af mount`);

await b.close();
