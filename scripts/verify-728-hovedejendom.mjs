// BIZZ-728 verification: visit Arnold Nielsens Boulevard 62B, 1. (erhvervsenhed
// with etage) and confirm the "Gå til hovedejendom" button is now visible.
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
// Arnold Nielsens Boulevard 62B, 1. — the exact case from the ticket
const TARGET = '/dashboard/ejendomme/222d784c-2363-46ef-9ff8-40632bb04d6e';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

console.log('1. Login...');
await page.goto(URL + '/login');
await page.fill('input[type="email"]', env.E2E_TEST_EMAIL);
await page.fill('input[type="password"]', env.E2E_TEST_PASS);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 15000 });

console.log('2. Open 62B, 1. ...');
await page.goto(URL + TARGET, { waitUntil: 'networkidle', timeout: 30000 });

// Wait a bit for async bbr data
await page.waitForTimeout(3000);

console.log('3. Check for "Gå til hovedejendom" button...');
const count = await page.locator('button:has-text("Gå til hovedejendom"), button:has-text("Go to main property")').count();
console.log('   Button count:', count);

// Screenshot for manual review
await page.screenshot({ path: '/tmp/bizz-728-62b.png', fullPage: false });
console.log('   Screenshot: /tmp/bizz-728-62b.png');

if (count >= 1) {
  // Click and verify navigation
  console.log('4. Click button and verify navigation...');
  const beforeUrl = page.url();
  await page.locator('button:has-text("Gå til hovedejendom"), button:has-text("Go to main property")').first().click();
  await page.waitForURL((u) => u.toString() !== beforeUrl, { timeout: 10000 }).catch(() => null);
  console.log('   Before:', beforeUrl.substring(beforeUrl.indexOf('/dashboard')));
  console.log('   After:', page.url().substring(page.url().indexOf('/dashboard')));
}

await browser.close();
process.exit(count >= 1 ? 0 : 1);
