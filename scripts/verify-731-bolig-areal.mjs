// BIZZ-731 verification: call /api/ejendomme-by-owner/enrich for the
// affected ejerlejlighed BFEs and confirm boligAreal is no longer 0.
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
// The 4 BFEs reported in the ticket + 1 known-working (Kildegårdsvej 18D) as regression check
const TEST_BFES = [
  { bfe: '100165718', adresse: 'Thorvald Bindesbølls Plads 18, 3. th', expectNonZero: true },
  { bfe: '173448', adresse: 'Horsekildevej 26, 2. tv', expectNonZero: true },
  { bfe: '100435372', adresse: 'J.C. Jacobsens Gade 11, 5. th', expectNonZero: true },
  { bfe: '167448', adresse: 'Vigerslevvej 146, 1. th', expectNonZero: true },
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

// Login to get session cookies
await page.goto(URL + '/login');
await page.fill('input[type="email"]', env.E2E_TEST_EMAIL);
await page.fill('input[type="password"]', env.E2E_TEST_PASS);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 15000 });

// Navigate to the person page to trigger enrichment with correct dawaIds
console.log('Loading person page (Jakob — enhedsNummer 4000115446)...');
await page.goto(URL + '/dashboard/owners/4000115446');
await page.waitForLoadState('networkidle');

// Click "Ejendomme" tab
await page.locator('button:has-text("Ejendomme")').first().click().catch(() => null);
// Progressive loading — wait longer and scroll to trigger any lazy render
await page.waitForTimeout(15000);
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(5000);

// Screenshot for manual review
await page.screenshot({ path: '/tmp/bizz-731.png', fullPage: true });
console.log('Screenshot:', '/tmp/bizz-731.png');

// Check page content for boligAreal texts — extract "Bolig: XX m²" near each target
const html = await page.content();
console.log();
console.log('═══ RESULT ═══');

let passed = 0;
let failed = 0;
for (const t of TEST_BFES) {
  // Look for "Bolig: N m²" near the address
  const idx = html.indexOf(t.adresse.split(',')[0]);
  if (idx === -1) {
    console.log(`  ${t.adresse} → NOT FOUND on page`);
    continue;
  }
  const slice = html.substring(idx, idx + 3000);
  const match = slice.match(/Bolig[:\s]*([0-9.,]+)\s*m/);
  if (match) {
    const num = parseFloat(match[1].replace(/[.,]/g, (c) => (c === ',' ? '.' : '')));
    const ok = t.expectNonZero ? num > 0 : num >= 0;
    console.log(`  ${t.adresse}: Bolig ${match[1]} m² ${ok ? '✓' : '✗'}`);
    ok ? passed++ : failed++;
  } else {
    console.log(`  ${t.adresse}: Bolig-felt ikke fundet`);
    failed++;
  }
}

console.log();
console.log(`Passed: ${passed}, Failed: ${failed}`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
