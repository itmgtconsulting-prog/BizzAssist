// BIZZ-729 verification: navigate to a company diagram tab and assert
// that the loading indicator appears while ejendomme are being fetched.
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
// JaJR Holding ApS — has many ejendomme, so loading indicator should be visible
const COMPANY = '/dashboard/companies/41092807';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

console.log('1. Login...');
await page.goto(URL + '/login');
await page.fill('input[type="email"]', env.E2E_TEST_EMAIL);
await page.fill('input[type="password"]', env.E2E_TEST_PASS);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 15000 });

console.log('2. Navigate to company page...');
await page.goto(URL + COMPANY);
await page.waitForLoadState('domcontentloaded');

console.log('3. Click Diagram tab...');
// Tab may say "Diagram" in both languages
await page
  .locator('button:has-text("Diagram")')
  .first()
  .click();

console.log('4. Check for loading indicator within 5s...');
// The indicator appears while ejendomme are loading (role=status, text contains "Henter ejendomme")
let sawLoadingIndicator = false;
try {
  await page.waitForSelector('[role="status"]:has-text("Henter ejendomme"), [role="status"]:has-text("Loading properties")', {
    timeout: 5000,
  });
  sawLoadingIndicator = true;
} catch {
  // Didn't appear in 5s — either load was instant or indicator is broken
}

console.log('5. Wait for load to complete...');
// Give up to 20s for loading to finish
await page.waitForTimeout(3000);
const stillLoadingCount = await page.locator('[role="status"]:has-text("Henter ejendomme")').count();

console.log();
console.log('═══ RESULT ═══');
console.log('  Loading indicator observed:', sawLoadingIndicator ? '✓' : '✗ (never appeared — check if company has properties to load)');
console.log('  Still loading after 3s:', stillLoadingCount);

// Take screenshot
await page.screenshot({ path: '/tmp/bizz-729-diagram.png', fullPage: false });
console.log('  Screenshot:', '/tmp/bizz-729-diagram.png');

await browser.close();
process.exit(sawLoadingIndicator ? 0 : 1);
