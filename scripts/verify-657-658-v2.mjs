#!/usr/bin/env node
/**
 * BIZZ-657+658 functional verification v2 — bruger text-based tab-selectors.
 */
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
const BASE = 'https://test.bizzassist.dk';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 150)));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('vercel.live') && !t.includes('401'))
    errors.push('error: ' + t.slice(0, 150));
});

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await Promise.all([page.waitForURL(/dashboard/, { timeout: 30000 }), page.click('button[type=submit]')]);

async function testTabs(u, tabs, label) {
  console.log(`\n=== ${label} ===`);
  await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);
  for (const name of tabs) {
    const before = errors.length;
    // Match button/span/a containing exact text (case-insensitive for Økonomi etc.)
    const el = page.getByText(new RegExp(`^${name}$`, 'i')).first();
    const count = await el.count();
    if (!count) {
      console.log(`  ⚠️ "${name}" — text not found`);
      continue;
    }
    await el.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const newErrs = errors.length - before;
    const crashText = await page.getByText(/Noget gik galt|Uncaught/i).count().catch(() => 0);
    console.log(`  ${newErrs === 0 && crashText === 0 ? '✅' : '⚠️'} "${name}" — errors=${newErrs} crash=${crashText}`);
  }
}

await testTabs(
  `${BASE}/dashboard/ejendomme/425479`,
  ['Oversigt', 'BBR', 'Ejerforhold', 'Økonomi', 'SKAT', 'Dokumenter', 'Tinglysning', 'Kort', 'Kronologi'],
  'BIZZ-657 Ejendom'
);
await testTabs(
  `${BASE}/dashboard/companies/26316804`,
  ['Oversigt', 'Diagram', 'Ejendomme', 'Virksomheder', 'Regnskab', 'Personer', 'Kronologi'],
  'BIZZ-658 Virksomhed'
);

console.log(`\nTotal relevant errors: ${errors.length}`);
errors.slice(0, 10).forEach((e, i) => console.log(`  [${i}] ${e}`));
await page.screenshot({ path: '/tmp/verify-screenshots/657-ejendom-v2.png', fullPage: false });
await b.close();
