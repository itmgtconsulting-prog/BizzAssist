import { chromium } from 'playwright';
import { readFileSync } from 'fs';
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter(l => l && !l.startsWith('#'))
    .map(l => { const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); return m ? [m[1], m[2]] : [null, null]; })
    .filter(([k]) => k)
);
const URL = 'https://test.bizzassist.dk';
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
await page.goto(URL + '/login');
await page.fill('input[type="email"]', env.E2E_TEST_EMAIL);
await page.fill('input[type="password"]', env.E2E_TEST_PASS);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 15000 });

await page.goto(URL + '/dashboard/owners/4000115446');
await page.locator('button:has-text("Diagram")').first().click();
await page.waitForTimeout(12000);
await page.screenshot({ path: '/tmp/bizz-730.png', fullPage: false });
const html = await page.content();
const hasContainer = html.includes('Personligt ejede ejendomme');
console.log('Container node present:', hasContainer ? '✓' : '✗');
console.log('Screenshot: /tmp/bizz-730.png');
await browser.close();
process.exit(hasContainer ? 0 : 1);
