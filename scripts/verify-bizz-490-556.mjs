#!/usr/bin/env node
/**
 * Verify BIZZ-490 (grundskatteloft on SKAT tab) and BIZZ-556 (PropertyOwnerCard labels)
 * on test.bizzassist.dk.
 */
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';

loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const BASE = 'https://test.bizzassist.dk';
const EMAIL = process.env.E2E_TEST_EMAIL;
const PASS = process.env.E2E_TEST_PASS;
const OUT = '/tmp/bizz-verify';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 2200 } });
const page = await ctx.newPage();

async function login() {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  const cookie = page.getByRole('button', { name: /Acceptér|Accepter/i });
  if (await cookie.isVisible({ timeout: 2000 }).catch(() => false)) await cookie.click();
  await page.getByPlaceholder('navn@virksomhed.dk').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASS);
  await page.getByRole('button', { name: /Log ind/i }).click();
  await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30000 });
  if (page.url().includes('/onboarding')) await page.goto(`${BASE}/dashboard`);
  await page.waitForLoadState('domcontentloaded');
  for (let i = 0; i < 6; i++) {
    const next = page.getByRole('button', { name: /Næste|Kom i gang|Fortsæt|Luk|Close/i }).first();
    if (await next.isVisible({ timeout: 1000 }).catch(() => false)) {
      await next.click().catch(() => {});
      await page.waitForTimeout(300);
    } else break;
  }
}

try {
  console.log('→ Login');
  await login();

  // ── BIZZ-490: visit a residential apartment property likely to have
  //            active Loftansættelse (the 4.75% cap applies to grundskyld
  //            on residential property). Nørrebrogade 100 is a 5-building
  //            boligejendom which is a good candidate.
  const ADDRS = ['Nørrebrogade 100', 'Bibliotekvej 58', 'Amagertorv 18'];
  let _loftFound = false;
  let usedAddr = null;
  for (const addr of ADDRS) {
    console.log(`\n→ BIZZ-490 verify: navigate to ${addr} and open SKAT tab`);
    await page.goto(`${BASE}/dashboard/ejendomme`, { waitUntil: 'domcontentloaded' });
    const search = page.getByPlaceholder(/adresse.*vejnavn|vejnavn.*postnummer|postnummer/i).first();
    await search.waitFor({ timeout: 15000 });
    await search.fill(addr);
    await page.waitForTimeout(1500);
    const firstHit = page.locator('button').filter({ hasText: new RegExp(addr.split(' ')[0], 'i') }).first();
    await firstHit.waitFor({ timeout: 12000 });
    await firstHit.click();
    await page.waitForURL(/\/dashboard\/ejendomme\//, { timeout: 20000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const skatTab = page.getByRole('tab', { name: /^skat|^tax/i }).first();
    await skatTab.click();
    await page.waitForTimeout(1500);
    for (let i = 0; i < 10; i++) {
      const loading = await page.locator('text=/Henter|Indlæser|Loading/i').count();
      if (loading === 0) break;
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(2000);
    const skatText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const safe = addr.toLowerCase().replace(/\s+/g, '-').replace(/ø/g, 'oe').replace(/å/g, 'aa');
    fs.writeFileSync(`${OUT}/skat-${safe}.txt`, skatText);
    await page.screenshot({ path: `${OUT}/skat-${safe}.png`, fullPage: true });

    const has490 = /grundskatteloft|land-tax ceiling/i.test(skatText);
    const hasBasisaar = /basisår|base year/i.test(skatText);
    const hasLoftvaerdi = /loftværdi|capped value/i.test(skatText);
    console.log(`  ${addr}: grundskatteloft=${has490 ? '✅' : '❌'}  basisår=${hasBasisaar ? '✅' : '❌'}  loftværdi=${hasLoftvaerdi ? '✅' : '❌'}`);
    if (has490) {
      _loftFound = true;
      usedAddr = addr;
      break;
    }
  }
  console.log(`\n  → BIZZ-490 verified on: ${usedAddr || 'none (no property returned loft data)'}`);

  // ── BIZZ-556: visit a company page with ejendomme list ─────────────────────
  console.log('\n→ BIZZ-556 verify: JaJR Holding ApS ejendomme tab');
  await page.goto(`${BASE}/dashboard/companies/41092807`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);

  // Click Ejendomme tab
  const ejendommeTab = page.getByRole('tab', { name: /ejendomme|properties/i }).first()
    .or(page.getByRole('button', { name: /^Ejendomme$/ }).first());
  if (await ejendommeTab.isVisible({ timeout: 3000 }).catch(() => false)) {
    await ejendommeTab.click();
    await page.waitForTimeout(1500);
  }
  // Wait for ejendomme portfolio + enrich API calls
  for (let i = 0; i < 20; i++) {
    const loading = await page.locator('text=/Henter data|Henter ejendomsport|Indlæser|Loading/i').count();
    if (loading === 0) break;
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(3000);

  const bodyText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  fs.writeFileSync(`${OUT}/bizz556-company.txt`, bodyText);
  await page.screenshot({ path: `${OUT}/bizz556-company.png`, fullPage: true });

  const hasVurdLabel = /\bVurd\.?:|\bVal\.?:/i.test(bodyText);
  const hasEjerLabel = /\bEjer:|\bOwner:/i.test(bodyText);
  const hasKoebtLabel = /\bKøbt:|\bPurchased:/i.test(bodyText);
  console.log(`  BIZZ-556 "Vurd.:" label: ${hasVurdLabel ? '✅' : '❌'}`);
  console.log(`  BIZZ-556 "Ejer:" label: ${hasEjerLabel ? '✅' : '❌'}`);
  console.log(`  BIZZ-556 "Købt:" label: ${hasKoebtLabel ? '✅ (bonus)' : '— (not present if no purchase data)'}`);

  console.log(`\nScreenshots: ${OUT}/skat-bizz490.png + ${OUT}/bizz556-company.png`);
} catch (err) {
  console.error('ERR', err.message);
  await page.screenshot({ path: `${OUT}/error-verify.png`, fullPage: true });
} finally {
  await browser.close();
}
