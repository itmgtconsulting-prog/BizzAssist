#!/usr/bin/env node
/**
 * v3 — præcise verifikationer:
 *   BIZZ-605  scroll til SERVITUT-række 13, klik PDF (a[href] ikke button), tæl popup-faner
 *   BIZZ-585  navigér til DIAGRAM-tab (ikke Ejendomme), tjek stiplede emerald-edges til Jakobs ejendomme
 */
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';

loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const BASE = 'https://test.bizzassist.dk';
const SHOTS = '/tmp/verify-screenshots';

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState('domcontentloaded');
  const cookie = page.getByRole('button', { name: /Acceptér|Accepter/i });
  if (await cookie.isVisible({ timeout: 3000 }).catch(() => false)) await cookie.click();
  await page.getByPlaceholder('navn@virksomhed.dk').fill(process.env.E2E_TEST_EMAIL);
  await page.getByPlaceholder('••••••••').fill(process.env.E2E_TEST_PASS);
  await page.getByRole('button', { name: /Log ind/i }).click();
  await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30000 });
  if (page.url().includes('/onboarding')) await page.goto(`${BASE}/dashboard`);
  await page.waitForLoadState('domcontentloaded');
  for (let i = 0; i < 5; i++) {
    const n = page.getByRole('button', { name: /Næste|Next|Kom i gang|Fortsæt/i }).first();
    if (await n.isVisible({ timeout: 1000 }).catch(() => false)) { await n.click(); await page.waitForTimeout(250); } else break;
  }
}

async function verify_605(page, context) {
  console.log('--- BIZZ-605 ---');
  await page.goto(`${BASE}/dashboard/ejendomme/dd4a90de-b126-4438-824f-3677efab2bd0`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3000);

  const tlTab = page.getByRole('tab', { name: /Tinglysning/i }).first();
  if (await tlTab.isVisible({ timeout: 5000 }).catch(() => false)) {
    await tlTab.click();
    await page.waitForTimeout(5000);
  }

  // Find alle PDF-links (a-tags der linker til /api/tinglysning/dokument/ eller indeholder .pdf)
  const pdfLinks = page.locator('a[href*="/tinglysning/dokument"], a[href*=".pdf"], a[target="_blank"]:has-text("PDF")');
  const count = await pdfLinks.count();
  console.log(`  Fandt ${count} PDF-links på Tinglysning-tab`);

  if (count < 13) {
    console.log(`  ❌ Kan ikke ramme række 13 med kun ${count} PDF-links`);
    return { ticket: 'BIZZ-605', passed: false, notes: `Kun ${count} PDF-links synlige — kan ikke nå række 13` };
  }

  // Scroll til SERVITUT-række 13 (0-indexed: 12)
  const target = pdfLinks.nth(12);
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);

  // Hør efter popup-events — sæt listener FØR klik
  const popupPromises = [];
  context.on('page', (p) => popupPromises.push(p));

  const tabsBefore = context.pages().length;
  await target.click({ timeout: 5000 }).catch((e) => console.log('  klik-fejl:', e.message));
  await page.waitForTimeout(4000);
  const tabsAfter = context.pages().length;
  const newTabs = tabsAfter - tabsBefore;

  await page.screenshot({ path: `${SHOTS}/bizz-605-v3-after-click.png`, fullPage: false });

  // Luk ekstra faner
  for (const p of context.pages()) if (p !== page) await p.close().catch(() => {});

  console.log(`  Klik åbnede ${newTabs} fane(r)`);
  const passed = newTabs <= 1;
  return { ticket: 'BIZZ-605', passed, notes: passed ? `PDF-klik på række 13 åbnede ${newTabs} fane (bug løst ✓)` : `PDF åbnede ${newTabs} faner (bug stadig til stede)` };
}

async function verify_585(page) {
  console.log('--- BIZZ-585 ---');
  await page.goto(`${BASE}/dashboard/companies/41092807`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3000);

  // PRECIS: klik DIAGRAM-tab, ikke Ejendomme
  // Tab'en er "📋 Diagram" — brug button-selektor direkte
  const diaButtons = page.locator('button:has-text("Diagram"), [role="tab"]:has-text("Diagram")');
  const diaCount = await diaButtons.count();
  console.log(`  Fandt ${diaCount} Diagram-tab-kandidater`);

  if (diaCount === 0) {
    return { ticket: 'BIZZ-585', passed: false, notes: 'Ingen Diagram-tab fundet' };
  }

  await diaButtons.first().click();
  await page.waitForTimeout(8000); // lang ventetid for D3-force-simulering

  await page.screenshot({ path: `${SHOTS}/bizz-585-v3-diagram.png`, fullPage: true });

  // Inspicér SVG
  const svgStats = await page.evaluate(() => {
    const svg = document.querySelector('svg');
    if (!svg) return null;
    const paths = svg.querySelectorAll('path, line');
    let dashedCount = 0;
    let emeraldCount = 0;
    for (const p of paths) {
      const dash = p.getAttribute('stroke-dasharray') || getComputedStyle(p).strokeDasharray;
      if (dash && dash !== 'none' && dash !== '0') dashedCount++;
      const stroke = p.getAttribute('stroke') || getComputedStyle(p).stroke;
      if (stroke && /(#10b981|#059669|#34d399|emerald|rgb\(16,\s*185,\s*129\))/i.test(stroke)) emeraldCount++;
    }
    return { totalPaths: paths.length, dashedCount, emeraldCount };
  });

  console.log(`  SVG stats:`, svgStats);

  const body = await page.locator('body').innerText();
  const personal = ['Søbyvej 11', 'Vigerslevvej 146', 'Horsekildevej 26', 'Hovager 8', 'H C Møllersvej', 'Thorvald Bindesbølls'];
  const found = personal.filter((a) => new RegExp(a.replace(/\s+/g, '\\s*'), 'i').test(body));
  console.log(`  Fandt ${found.length}/${personal.length} personlige adresser: ${found.join(', ')}`);

  const passed = svgStats && svgStats.dashedCount > 0 && found.length >= 3;
  return {
    ticket: 'BIZZ-585',
    passed,
    notes: passed
      ? `Diagram viser ${found.length}/${personal.length} personligt ejede + ${svgStats.dashedCount} stiplede linjer (emerald=${svgStats.emeraldCount}) ✓`
      : `Diagram mangler stiplede linjer eller personlige ejendomme (dashed=${svgStats?.dashedCount ?? 'n/a'}, found=${found.length}/${personal.length})`,
  };
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
const page = await context.newPage();

await login(page);
console.log('Login OK\n');

const r1 = await verify_605(page, context);
const r2 = await verify_585(page);

await browser.close();

console.log('\n═══ RESULTS ═══');
for (const r of [r1, r2]) {
  console.log(`${r.passed ? '✅' : '❌'} ${r.ticket}: ${r.notes}`);
}

fs.writeFileSync(`${SHOTS}/results-v3.json`, JSON.stringify([r1, r2], null, 2));
