#!/usr/bin/env node
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext();
const page = await ctx.newPage();
await page.goto('https://test.bizzassist.dk/login');
await page.waitForTimeout(1500);
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await page.click('button[type=submit]');
try { await page.waitForURL(/dashboard/, { timeout: 45000 }); } catch { await page.waitForTimeout(5000); }
await page.waitForTimeout(2000);

const api = await page.evaluate(async () => {
  const r = await fetch('/api/ejerlejligheder?ejerlavKode=12851&matrikelnr=21by&moderBfe=226630').then(r => r.json());
  return r;
});
console.log(`Lejligheder: ${api.lejligheder?.length || 0}`);
for (const l of api.lejligheder || []) {
  const lbl = `${l.adresse?.slice(0, 35)}`;
  console.log(`  ${lbl} → bfe=${l.bfe}, areal=${l.areal}, ejer=${l.ejer}, koebsdato=${l.koebsdato}, koebspris=${l.koebspris}`);
}

// Tjek om BFE > 0 (tidligere 0 på alle)
const bfeResolved = (api.lejligheder || []).filter(l => l.bfe && l.bfe > 0).length;
const arealResolved = (api.lejligheder || []).filter(l => l.areal != null && l.areal > 0).length;
console.log(`\nBFE resolved: ${bfeResolved}/4`);
console.log(`Areal resolved: ${arealResolved}/4`);

await b.close();
