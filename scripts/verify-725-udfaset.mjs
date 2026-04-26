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
const TARGET = '/dashboard/ejendomme/3b362995-27a0-4c12-ad73-8ead0c978ad2'; // 62C Udfaset

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();

await page.goto(URL + '/login');
await page.fill('input[type="email"]', env.E2E_TEST_EMAIL);
await page.fill('input[type="password"]', env.E2E_TEST_PASS);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 15000 });

await page.goto(URL + TARGET, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(3000);

const banner = await page.locator('text=Udfaset ejendom, text=Retired property').count();
const matrikelBtn = await page.locator('button:has-text("Find andre ejendomme"), button:has-text("Find other properties")').count();
await page.screenshot({ path: '/tmp/bizz-725.png' });
console.log('Banner visible:', banner);
console.log('Matrikel button:', matrikelBtn);
console.log('Screenshot: /tmp/bizz-725.png');

await browser.close();
process.exit(banner >= 1 ? 0 : 1);
