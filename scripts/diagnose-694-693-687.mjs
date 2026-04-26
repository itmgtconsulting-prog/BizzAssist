#!/usr/bin/env node
/**
 * Diagnostic: BIZZ-694 (lejlighedsliste), BIZZ-693 (salgshistorik), BIZZ-687 (ejer i diagram)
 * Logs into test.bizzassist.dk and captures API responses for 3 pages.
 */
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'https://test.bizzassist.dk';
const EMAIL = process.env.E2E_TEST_EMAIL;
const PASS = process.env.E2E_TEST_PASS;
const OUT = '/tmp/diag-694';

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // Capture all API responses
  const apiLog = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/api/')) {
      const status = res.status();
      let body = '';
      try { body = await res.text(); } catch { body = '<unreadable>'; }
      const entry = { url: url.replace(BASE, ''), status, bodyLen: body.length, body: body.slice(0, 500) };
      apiLog.push(entry);
    }
  });

  // Login
  console.log('Logging in...');
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard**', { timeout: 15000 });
  console.log('Logged in.');

  // ── BIZZ-694: Arnold Nielsens Boulevard 62A (BFE 226630) ──
  console.log('\n=== BIZZ-694: Hovedejendom lejlighedsliste ===');
  apiLog.length = 0;

  // We need the DAWA ID for this address
  await page.goto(`${BASE}/dashboard`);
  // Search for the address
  const searchInput = page.locator('input[type="text"]').first();
  await searchInput.fill('Arnold Nielsens Boulevard 62A');
  await page.waitForTimeout(2000);

  // Check if we get search results — if not, navigate directly
  // Try direct navigation via a known DAWA ID from the address
  // First let's find the DAWA ID
  const dawaRes = await page.evaluate(async () => {
    const r = await fetch('https://dawa.aws.dk/adgangsadresser?q=Arnold+Nielsens+Boulevard+62A+2650&per_side=1');
    return r.ok ? await r.json() : null;
  });

  let dawaId = null;
  if (dawaRes && dawaRes.length > 0) {
    dawaId = dawaRes[0].id;
    console.log(`DAWA ID: ${dawaId}`);
  }

  if (dawaId) {
    await page.goto(`${BASE}/dashboard/ejendomme/${dawaId}`);
    await page.waitForTimeout(5000);

    // Click Ejerskab tab
    const ejerskabTab = page.locator('button', { hasText: /Ejerskab|Ejerforhold/ });
    if (await ejerskabTab.count() > 0) {
      await ejerskabTab.first().click();
      await page.waitForTimeout(3000);
    }

    await page.screenshot({ path: `${OUT}/694-ejerskab.png`, fullPage: true });

    // Log relevant API calls
    const relevant694 = apiLog.filter(e =>
      e.url.includes('ejerlejlighed') ||
      e.url.includes('ejendom/') ||
      e.url.includes('ejerskab')
    );
    console.log('API calls:');
    for (const e of relevant694) {
      console.log(`  ${e.status} ${e.url.slice(0, 80)} (${e.bodyLen}b)`);
      if (e.url.includes('ejerlejlighed')) {
        console.log(`    Body: ${e.body.slice(0, 200)}`);
      }
    }
  }

  // ── BIZZ-693: Kaffevej 31, 1.tv (DAWA ID 4afa00c5-c304-463d-a67e-b24446187465) ──
  console.log('\n=== BIZZ-693: Salgshistorik Kaffevej 31 ===');
  apiLog.length = 0;

  await page.goto(`${BASE}/dashboard/ejendomme/4afa00c5-c304-463d-a67e-b24446187465`);
  await page.waitForTimeout(5000);

  // Click Økonomi tab (salgshistorik is there)
  const oekTab = page.locator('button', { hasText: /Økonomi|Economy/ });
  if (await oekTab.count() > 0) {
    await oekTab.first().click();
    await page.waitForTimeout(3000);
  }

  await page.screenshot({ path: `${OUT}/693-oekonomi.png`, fullPage: true });

  const relevant693 = apiLog.filter(e =>
    e.url.includes('salgshistorik') ||
    e.url.includes('tinglysning') ||
    e.url.includes('ejerskab')
  );
  console.log('API calls:');
  for (const e of relevant693) {
    console.log(`  ${e.status} ${e.url.slice(0, 80)} (${e.bodyLen}b)`);
    if (e.url.includes('salgshistorik')) {
      console.log(`    Body: ${e.body.slice(0, 300)}`);
    }
  }

  // ── BIZZ-687: JaJR Holding (CVR 41092807) ──
  console.log('\n=== BIZZ-687: JaJR Holding diagram ===');
  apiLog.length = 0;

  await page.goto(`${BASE}/dashboard/companies/41092807`);
  await page.waitForTimeout(5000);

  // Click Diagram tab
  const diagTab = page.locator('button', { hasText: /Diagram/ });
  if (await diagTab.count() > 0) {
    await diagTab.first().click();
    await page.waitForTimeout(3000);
  }

  await page.screenshot({ path: `${OUT}/687-diagram.png`, fullPage: true });

  const relevant687 = apiLog.filter(e =>
    e.url.includes('cvr-public') ||
    e.url.includes('related')
  );
  console.log('API calls:');
  for (const e of relevant687) {
    console.log(`  ${e.status} ${e.url.slice(0, 80)} (${e.bodyLen}b)`);
    if (e.url.includes('cvr-public') && !e.url.includes('related')) {
      // Parse to check deltagere
      try {
        const d = JSON.parse(e.body.slice(0, 2000) + (e.bodyLen > 2000 ? '...' : ''));
        const deltagere = d.deltagere || [];
        console.log(`    deltagere: ${deltagere.length}`);
        for (const dt of deltagere.slice(0, 3)) {
          console.log(`      ${dt.navn} (erVirksomhed=${dt.erVirksomhed}, roller=${dt.roller?.length})`);
        }
      } catch {}
    }
  }

  await browser.close();
  console.log(`\nScreenshots saved to ${OUT}/`);
}

main().catch(err => { console.error(err); process.exit(1); });
