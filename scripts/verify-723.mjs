#!/usr/bin/env node
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const BASE = 'https://test.bizzassist.dk';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await page.click('button[type=submit]');
try { await page.waitForURL(/dashboard/, { timeout: 45000 }); } catch { await page.waitForTimeout(5000); }
await page.waitForTimeout(2500);

// Søgning på "Arnold Nielsens Boulevard 62"
const search = await page.evaluate(async () => {
  const r = await fetch('/api/search?q=' + encodeURIComponent('Arnold Nielsens Boulevard 62')).then(r => r.json());
  return Array.isArray(r) ? r : (r.results ?? []);
});

console.log(`Total hits: ${search.length}`);
const addresses = search.filter(r => r.type === 'address');
console.log(`Address hits: ${addresses.length}`);
for (const a of addresses) {
  console.log(`  - ${a.title} (etage=${a.meta?.etage || '-'}, dør=${a.meta?.dør || '-'})`);
}

// Check acceptance: 62A + 62B hovedejendomme + 62A/62B 1. og st.
const has62A_hoved = addresses.some(a => /62A,/i.test(a.title) && !a.meta?.etage);
const has62B_hoved = addresses.some(a => /62B,/i.test(a.title) && !a.meta?.etage);
const has62A_1 = addresses.some(a => /62A/i.test(a.title) && /^1/.test(a.meta?.etage || ''));
const has62A_st = addresses.some(a => /62A/i.test(a.title) && /^st/i.test(a.meta?.etage || ''));
const has62B_1 = addresses.some(a => /62B/i.test(a.title) && /^1/.test(a.meta?.etage || ''));
const has62B_st = addresses.some(a => /62B/i.test(a.title) && /^st/i.test(a.meta?.etage || ''));

const checks = [
  { name: '62A hovedejendom (adgangsadresse)', ok: has62A_hoved },
  { name: '62B hovedejendom (adgangsadresse)', ok: has62B_hoved },
  { name: '62A 1.sal lejlighed', ok: has62A_1 },
  { name: '62A st. lejlighed', ok: has62A_st },
  { name: '62B 1.sal lejlighed', ok: has62B_1 },
  { name: '62B st. lejlighed', ok: has62B_st },
];
console.log('\n--- Acceptance ---');
for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}`);
const pass = checks.filter(c => c.ok).length;
console.log(`\nResultat: ${pass}/${checks.length}`);

await b.close();
