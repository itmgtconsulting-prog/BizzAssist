// BIZZ-732 verification: navigate to a company page, measure how quickly the
// Diagram tab is ready (should be near-instant when prefetch completes during
// the time the user spent on Overblik).
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
      return m ? [m[1], m[2]] : [null, null];
    })
    .filter(([k]) => k)
);

const URL = 'https://test.bizzassist.dk';
const COMPANY = '/dashboard/companies/41092807'; // JaJR Holding

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();

// Track API calls — see which ones fire at mount vs tab click
const callLog = [];
page.on('request', (r) => {
  const u = r.url();
  if (
    u.includes('/api/cvr-public/related') ||
    u.includes('/api/salgshistorik/cvr') ||
    u.includes('/api/ejendomme-by-owner')
  ) {
    callLog.push({ time: Date.now(), url: u.replace(/^https?:\/\/[^/]+/, '').split('?')[0] });
  }
});

console.log('1. Login...');
await page.goto(URL + '/login');
await page.fill('input[type=email]', env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', env.E2E_TEST_PASS);
await page.click('button[type=submit]');
await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 15000 });

console.log('2. Go to company page, mount-start time...');
const mountStart = Date.now();
await page.goto(URL + COMPANY);
await page.waitForLoadState('domcontentloaded');
const mountDone = Date.now();

// Wait 3s for prefetch to kick in
await page.waitForTimeout(3000);
const preClick = Date.now();

console.log('3. Click Diagram tab — should be near-instant...');
const tabClickStart = Date.now();
await page.locator('button:has-text("Diagram")').first().click();
await page.waitForSelector('.relationsdiagram, [role="tab"][aria-selected="true"]:has-text("Diagram")', { timeout: 5000 }).catch(() => null);
const tabClickDone = Date.now();

console.log();
console.log('═══ TIMING ═══');
console.log(`  Mount to DOM ready: ${mountDone - mountStart}ms`);
console.log(`  Tab-click render:   ${tabClickDone - tabClickStart}ms`);
console.log();
console.log('═══ API CALLS FIRED ═══');
for (const c of callLog) {
  const phase = c.time < preClick ? 'mount' : 'post-click';
  console.log(`  [+${c.time - mountStart}ms] (${phase}) ${c.url}`);
}

const prefetchFired = callLog.some(
  (c) => c.time < preClick && (c.url.includes('related') || c.url.includes('salgshistorik'))
);
console.log();
console.log('Prefetch fired at mount (not waiting for tab click):', prefetchFired ? '✓' : '✗');

await browser.close();
process.exit(prefetchFired ? 0 : 1);
