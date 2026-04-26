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
await page.fill('input[type=email]', env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', env.E2E_TEST_PASS);
await page.click('button[type=submit]');
await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 15000 });

// Probe ejerlejligheder for 62A (known to have 2 units)
const params = new URLSearchParams({
  ejerlavKode: "12851",  // Hvidovre By, Risbjerg
  matrikelnr: '21by',
  moderBfe: '2091164',  // 62A BFE per ticket ref
});
const r = await page.request.get(`${URL}/api/ejerlejligheder?${params}`);
const d = await r.json();
console.log('Total lejligheder:', (d.lejligheder||[]).length);
for (const l of (d.lejligheder||[]).slice(0, 6)) {
  console.log(`  ${l.adresse}`);
  console.log(`    bfe=${l.bfe} areal=${l.areal} koebspris=${l.koebspris} koebsdato=${l.koebsdato} ejer="${l.ejer}"`);
}
const anyBfe = (d.lejligheder||[]).some(l => l.bfe > 0);
const anyAreal = (d.lejligheder||[]).some(l => l.areal != null && l.areal > 0);
console.log();
console.log('Any lejlighed has real BFE:', anyBfe ? '✓' : '✗');
console.log('Any lejlighed has areal:', anyAreal ? '✓' : '✗');
await browser.close();
process.exit((anyBfe || anyAreal) ? 0 : 1);
