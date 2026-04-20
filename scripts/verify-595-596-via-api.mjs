#!/usr/bin/env node
/**
 * Verify BIZZ-595 + BIZZ-596 via API calls:
 * - /api/ejerskab/person-properties?enhedsNummer=4000115446 returns Jakob's
 *   9 personally-owned BFE'er with ejerandel + address data
 */
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const BASE = 'https://test.bizzassist.dk';

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState('domcontentloaded');
  const c = page.getByRole('button', { name: /Acceptér|Accepter/i });
  if (await c.isVisible({ timeout: 3000 }).catch(() => false)) await c.click();
  await page.getByPlaceholder('navn@virksomhed.dk').fill(process.env.E2E_TEST_EMAIL);
  await page.getByPlaceholder('••••••••').fill(process.env.E2E_TEST_PASS);
  await page.getByRole('button', { name: /Log ind/i }).click();
  await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30000 });
  if (page.url().includes('/onboarding')) await page.goto(`${BASE}/dashboard`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
await login(page);
console.log('Login OK\n');

// Test person-properties API
console.log('═══ /api/ejerskab/person-properties?enhedsNummer=4000115446 ═══');
const pp = await page.evaluate(async () => {
  const r = await fetch('/api/ejerskab/person-properties?enhedsNummer=4000115446', { credentials: 'include' });
  if (!r.ok) return { error: `HTTP ${r.status}`, body: (await r.text()).slice(0, 300) };
  return await r.json();
});

if (pp.error) console.log(`❌ ${pp.error}: ${pp.body || ''}`);
else {
  console.log(`  bfes.length: ${(pp.bfes||[]).length}`);
  console.log(`  properties.length: ${(pp.properties||[]).length}`);
  if (pp.bfes) console.log(`  bfes: ${pp.bfes.slice(0,10).join(', ')}`);
  if (pp.properties) {
    for (const p of (pp.properties||[]).slice(0, 10)) {
      console.log(`    BFE ${p.bfe || p.bfeNummer || '?'}  ejerandel=${p.ejerandel_taeller}/${p.ejerandel_naevner}  adresse=${p.adresse || p.ejer_navn || '?'}`);
    }
  }
}

// Test Person-detail page directly (faster, no skeleton wait tricks)
console.log('\n═══ Jakobs persontab via direct fetch ═══');
await page.goto(`${BASE}/dashboard/owners/4000115446`);
// Wait for network idle + full render
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(6000);

// Switch tab directly in JS
await page.evaluate(() => {
  const buttons = Array.from(document.querySelectorAll('button, a, [role="tab"]'));
  const ej = buttons.find(b => /^(Ejendomme)$/i.test((b.textContent || '').trim()));
  if (ej) ej.click();
});
await page.waitForTimeout(8000);

const body = await page.locator('body').innerText();
const hasPlaceholder = /Kommer\s+snart/i.test(body);
const personalAddrs = ['Søbyvej 11', 'Vigerslevvej 146', 'H C Møllersvej 21', 'Horsekildevej 26', 'Hovager 8'];
const foundAddrs = personalAddrs.filter(a => body.includes(a));
const ejendomsLinks = await page.locator('a[href*="/dashboard/ejendomme/"]').count();
const hasPersonligtEjet = /Personligt\s+ejet/i.test(body);

console.log(`  body.length: ${body.length}`);
console.log(`  "Kommer snart" placeholder: ${hasPlaceholder}`);
console.log(`  "Personligt ejet"-label: ${hasPersonligtEjet}`);
console.log(`  Personlige adresser fundet: ${foundAddrs.length}/5 (${foundAddrs.join(', ')})`);
console.log(`  Ejendomslinks: ${ejendomsLinks}`);

await page.screenshot({ path: '/tmp/verify-screenshots/bizz-595-596-re.png', fullPage: true });

await browser.close();
