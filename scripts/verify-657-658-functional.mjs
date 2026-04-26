#!/usr/bin/env node
/**
 * BIZZ-657 + BIZZ-658 functional verification:
 * navigate til ejendoms- og virksomhedsside, klik gennem alle tabs,
 * tjek at hver tab rendres uden fejl-state.
 */
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
const BASE = 'https://test.bizzassist.dk';
fs.mkdirSync('/tmp/verify-screenshots', { recursive: true });

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 200)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 200));
});

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await Promise.all([page.waitForURL(/dashboard/, { timeout: 30000 }), page.click('button[type=submit]')]);

async function testTabs(url, tabNames, label) {
  console.log(`\n=== ${label} ===`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);
  for (const name of tabNames) {
    const before = errors.length;
    const locator = page.getByRole('tab', { name }).first();
    const count = await locator.count();
    if (!count) {
      console.log(`  ❌ tab "${name}" not found`);
      continue;
    }
    await locator.click().catch(() => {});
    await page.waitForTimeout(2500);
    const newErrors = errors.length - before;
    const visibleCrashText = await page
      .getByText(/Noget gik galt|Error:|Uncaught/i)
      .count()
      .catch(() => 0);
    console.log(
      `  ${newErrors === 0 && visibleCrashText === 0 ? '✅' : '⚠️'} "${name}" — console-errors=${newErrors}, crash-text=${visibleCrashText}`
    );
  }
}

// BIZZ-657: Ejendom (bruger BFE 2081243 = Søbyvej 11)
await testTabs(
  `${BASE}/dashboard/ejendomme/2081243`,
  ['Overblik', 'BBR', 'Ejerforhold', 'Økonomi', 'SKAT', 'Dokumenter', 'Tinglysning', 'Kort', 'Kronologi'],
  'BIZZ-657 Ejendom 2081243'
);
await page.screenshot({
  path: '/tmp/verify-screenshots/657-ejendom.png',
  fullPage: false,
});

// BIZZ-658: Virksomhed (bruger CVR 26316804 = JAJR Ejendomme ApS)
await testTabs(
  `${BASE}/dashboard/companies/26316804`,
  ['Oversigt', 'Diagram', 'Ejendomme', 'Virksomheder', 'Regnskab', 'Personer', 'Kronologi', 'Tinglysning'],
  'BIZZ-658 Virksomhed 26316804'
);
await page.screenshot({
  path: '/tmp/verify-screenshots/658-virksomhed.png',
  fullPage: false,
});

console.log(`\nTotal unique errors: ${errors.length}`);
if (errors.length > 0 && errors.length <= 10) {
  errors.forEach((e, i) => console.log(`  [${i}] ${e}`));
}
await b.close();
