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

const r = await page.request.get(`${URL}/api/search?q=${encodeURIComponent('Arnold Nielsens Boulevard 62')}`);
const d = await r.json();
const addrs = (d.results || d || []).filter(x => x.type === 'address');
console.log('Total address hits:', addrs.length);
let count62AUnits = 0, count62BUnits = 0;
for (const r of addrs) {
  const t = r.title || '';
  console.log('  ', t, '|', r.subtitle || '');
  if (/62A.*[0-9]+\.|62A.*st\./i.test(t)) count62AUnits++;
  if (/62B.*[0-9]+\.|62B.*st\./i.test(t)) count62BUnits++;
}
console.log();
console.log('62A units:', count62AUnits);
console.log('62B units:', count62BUnits);
await browser.close();
process.exit(count62AUnits >= 1 ? 0 : 1);
