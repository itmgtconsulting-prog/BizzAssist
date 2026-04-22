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
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();

await page.goto(URL + '/login');
await page.fill('input[type=email]', env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', env.E2E_TEST_PASS);
await page.click('button[type=submit]');
await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 15000 });

const pages = [
  '/dashboard/admin/users',
  '/dashboard/admin/billing',
  '/dashboard/admin/plans',
  '/dashboard/admin/analytics',
  '/dashboard/admin/ai-media-agents',
  '/dashboard/admin/security',
  '/dashboard/admin/service-manager',
  '/dashboard/admin/service-management',
  '/dashboard/admin/cron-status',
];

for (const path of pages) {
  try {
    await page.goto(URL + path, { timeout: 15000 });
    await page.waitForTimeout(1500);
    // Find all tab links
    const tabs = await page.$$eval('a[href^="/dashboard/admin/"], span', (els) =>
      els
        .map((e) => e.textContent?.trim())
        .filter((t) => t && t.length > 2 && t.length < 40)
    );
    const hasDomains = tabs.some((t) => t === 'Domains');
    const href = await page
      .locator('a[href="/dashboard/admin/domains"]')
      .first()
      .getAttribute('href')
      .catch(() => null);
    console.log(
      `${path.padEnd(40)} domains-tab: ${hasDomains ? '✓' : '✗'}  href: ${href ?? '(none)'}`
    );
  } catch (err) {
    console.log(`${path.padEnd(40)} ERROR: ${err.message.slice(0, 80)}`);
  }
}

// Click on Domains from /dashboard/admin/users
await page.goto(URL + '/dashboard/admin/users');
await page.waitForTimeout(1000);
await page.click('a[href="/dashboard/admin/domains"]');
await page.waitForTimeout(2000);
console.log('\nAfter click Domains tab:', page.url());

await browser.close();
