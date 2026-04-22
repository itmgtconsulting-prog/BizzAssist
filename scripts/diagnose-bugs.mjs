#!/usr/bin/env node
/**
 * Diagnostic: Capture API responses for 3 bug pages via Playwright.
 */
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'https://test.bizzassist.dk';
const EMAIL = process.env.E2E_TEST_EMAIL;
const PASS = process.env.E2E_TEST_PASS;
const OUT = '/tmp/diag-bugs';

// Known DAWA IDs
const ARNOLD_62A = '0a3f507c-b62a-32b8-e044-0003ba298018';
const KAFFEVEJ_31 = '4afa00c5-c304-463d-a67e-b24446187465';

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const apiLog = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/api/')) {
      const status = res.status();
      let body = '';
      try { body = await res.text(); } catch { body = '<err>'; }
      apiLog.push({ url: url.replace(BASE, ''), status, bodyLen: body.length, body: body.slice(0, 1000) });
    }
  });

  // Login
  console.log('Logging in...');
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard**', { timeout: 15000 });
  console.log('OK\n');

  // ── 694: Arnold Nielsens 62A ──
  console.log('=== BIZZ-694: Arnold Nielsens 62A ===');
  apiLog.length = 0;
  await page.goto(`${BASE}/dashboard/ejendomme/${ARNOLD_62A}`);
  await page.waitForTimeout(6000);

  // Click Ejerskab
  try {
    await page.locator('button:has-text("Ejerskab"), button:has-text("Ejerforhold")').first().click();
    await page.waitForTimeout(4000);
  } catch { console.log('  Could not click Ejerskab tab'); }

  await page.screenshot({ path: `${OUT}/694.png`, fullPage: true });

  for (const e of apiLog) {
    if (e.url.includes('ejendom/') || e.url.includes('ejerlejlighed') || e.url.includes('ejerskab')) {
      console.log(`  ${e.status} ${e.url.slice(0, 90)} (${e.bodyLen}b)`);
      if (e.url.includes('ejerlejlighed')) console.log(`    → ${e.body.slice(0, 300)}`);
      if (e.url.includes('ejendom/') && !e.url.includes('ejendomme')) {
        try {
          const d = JSON.parse(e.body);
          console.log(`    → ejerlejlighedBfe=${d.ejerlejlighedBfe}, moderBfe=${d.moderBfe}`);
          console.log(`    → rel[0]: bfe=${d.ejendomsrelationer?.[0]?.bfeNummer}, ejerlav=${d.ejendomsrelationer?.[0]?.ejerlavKode}, matr=${d.ejendomsrelationer?.[0]?.matrikelnr}`);
        } catch {}
      }
    }
  }

  // ── 693: Kaffevej 31 ──
  console.log('\n=== BIZZ-693: Kaffevej 31 salgshistorik ===');
  apiLog.length = 0;
  await page.goto(`${BASE}/dashboard/ejendomme/${KAFFEVEJ_31}`);
  await page.waitForTimeout(6000);

  // Click Økonomi
  try {
    await page.locator('button:has-text("Økonomi"), button:has-text("Economy")').first().click();
    await page.waitForTimeout(4000);
  } catch { console.log('  Could not click Økonomi tab'); }

  await page.screenshot({ path: `${OUT}/693.png`, fullPage: true });

  for (const e of apiLog) {
    if (e.url.includes('salgshistorik') || e.url.includes('tinglysning/summarisk')) {
      console.log(`  ${e.status} ${e.url.slice(0, 90)} (${e.bodyLen}b)`);
      if (e.url.includes('salgshistorik')) console.log(`    → ${e.body.slice(0, 400)}`);
      if (e.url.includes('summarisk') && e.url.includes('ejere')) console.log(`    → ${e.body.slice(0, 400)}`);
    }
  }

  // ── 687: JaJR Holding ──
  console.log('\n=== BIZZ-687: JaJR Holding ===');
  apiLog.length = 0;
  await page.goto(`${BASE}/dashboard/companies/41092807`);
  await page.waitForTimeout(6000);

  await page.screenshot({ path: `${OUT}/687-oversigt.png`, fullPage: true });

  for (const e of apiLog) {
    if (e.url.includes('cvr-public') && !e.url.includes('related') && !e.url.includes('person')) {
      console.log(`  ${e.status} ${e.url.slice(0, 90)} (${e.bodyLen}b)`);
      try {
        const d = JSON.parse(e.body);
        console.log(`    → name=${d.name}, deltagere=${d.deltagere?.length}`);
        for (const dt of (d.deltagere || []).slice(0, 5)) {
          const aktiveRoller = dt.roller?.filter(r => !r.til)?.map(r => r.rolle) || [];
          console.log(`      ${dt.navn} (erVirk=${dt.erVirksomhed}, enhNr=${dt.enhedsNummer}) aktive: [${aktiveRoller}]`);
        }
      } catch {}
    }
  }

  // Click Diagram
  try {
    await page.locator('button:has-text("Diagram")').first().click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${OUT}/687-diagram.png`, fullPage: true });
  } catch { console.log('  Could not click Diagram'); }

  await browser.close();
  console.log(`\nDone. Screenshots in ${OUT}/`);
}

main().catch(err => { console.error(err); process.exit(1); });
