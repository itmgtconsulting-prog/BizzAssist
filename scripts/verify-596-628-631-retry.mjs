#!/usr/bin/env node
/**
 * Retry af BIZZ-596, 628, 631 med proper wait for persondata at loade
 * (tidligere screenshot viste "Indlæser persondata..." skeleton).
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
  const c = page.getByRole('button', { name: /Acceptér|Accepter/i });
  if (await c.isVisible({ timeout: 3000 }).catch(() => false)) await c.click();
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

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
const page = await context.newPage();
await login(page);

// Brug 4000197904 (Peter Klein — ticket BIZZ-631 refererer til ham)
// Men Jakob (4000115446) er bedre til 596/628
const testers = [
  { id: '4000115446', name: 'Jakob Juul Rasmussen' },
];

const results = [];

for (const t of testers) {
  console.log(`\n--- Person: ${t.name} (${t.id}) ---`);
  await page.goto(`${BASE}/dashboard/owners/${t.id}`);
  await page.waitForLoadState('domcontentloaded');

  // Vent til "Indlæser persondata" skeleton er væk
  for (let i = 0; i < 30; i++) {
    const hasSkeleton = await page.getByText(/Indlæser\s+persondata/i).isVisible({ timeout: 500 }).catch(() => false);
    if (!hasSkeleton) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(2000);

  // Klik Ejendomme-tab
  const ejTab = page.getByRole('tab', { name: /^Ejendomme/i }).first();
  if (await ejTab.isVisible({ timeout: 5000 }).catch(() => false)) {
    await ejTab.click();
    await page.waitForTimeout(5000);
  }

  // Vent igen for tab-data
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);

  await page.screenshot({ path: `${SHOTS}/bizz-596-628-631-retry-${t.id}.png`, fullPage: true });

  const bodyText = await page.locator('body').innerText();
  console.log(`  body.length: ${bodyText.length} chars`);

  // BIZZ-631: filter-knapper
  const hasFilterEjendomshandler = /Ejendomshandler/i.test(bodyText);
  const filterBtns = await page.locator('button:has-text("Ejendomshandler")').count();
  // Se også om "Alle / Ejendomme" knap-par er synlige
  const alleBtn = await page.locator('button:has-text("Alle")').count();
  console.log(`  Filter: hasEjendomshandler=${hasFilterEjendomshandler}, filterBtns=${filterBtns}, alleBtns=${alleBtn}`);

  // BIZZ-628: "Ejer:" linje
  const ejerLines = (bodyText.match(/\bEjer:\s/g) || []).length;
  console.log(`  "Ejer:" linjer: ${ejerLines}`);

  // BIZZ-596: alignment — kommer snart, antal ejendomskort
  const hasPlaceholder = /Kommer\s+snart/i.test(bodyText);
  const ejendomLinks = await page.locator('a[href*="/dashboard/ejendomme/"]').count();
  const ejendomsAdrs = ['Søbyvej 11', 'Vigerslevvej 146', 'H C Møllersvej', 'Horsekildevej 26', 'Hovager 8'];
  const foundAdrs = ejendomsAdrs.filter(a => new RegExp(a.replace(/\s+/g, '\\s*'), 'i').test(bodyText));
  console.log(`  Placeholder=${hasPlaceholder}, ejendomsLinks=${ejendomLinks}, foundPersonalAdrs=${foundAdrs.length}/5`);

  results.push({
    ticket: 'BIZZ-631',
    passed: !hasFilterEjendomshandler && filterBtns === 0,
    notes: `Filter "Ejendomshandler" ${hasFilterEjendomshandler ? 'STADIG synlig' : 'ikke synlig ✓'} (btns=${filterBtns}, "Alle" btns=${alleBtn})`,
  });
  results.push({
    ticket: 'BIZZ-628',
    passed: ejerLines === 0,
    notes: `"Ejer:"-linjer: ${ejerLines} ${ejerLines === 0 ? '(fjernet ✓)' : '(stadig til stede)'}`,
  });
  results.push({
    ticket: 'BIZZ-596',
    passed: !hasPlaceholder && foundAdrs.length >= 3,
    notes: `Placeholder=${hasPlaceholder ? 'JA' : 'NEJ'}, ejendomsLinks=${ejendomLinks}, personlige adresser fundet=${foundAdrs.length}/5 (${foundAdrs.join(', ')})`,
  });
}

await browser.close();

console.log('\n═══ RETRY RESULTS ═══');
for (const r of results) console.log(`${r.passed ? '✅' : '❌'} ${r.ticket}: ${r.notes}`);
fs.writeFileSync(`${SHOTS}/results-retry.json`, JSON.stringify(results, null, 2));
